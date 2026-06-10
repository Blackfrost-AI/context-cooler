import { z } from "zod";
import * as https from "https";
import * as http from "http";
import * as dns from "dns";
import * as net from "net";
import { indexContentBatch } from "../lib/db";
import { redactSecrets } from "../lib/redact";
import { autoChunk } from "../lib/chunker";

// CC-SSRF-006 fix: block requests to loopback / private / link-local addresses,
// enforce an http(s) scheme allowlist, and re-validate on EVERY redirect hop.
const MAX_REDIRECTS = 5;

function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const o = ip.split(".").map(Number);
    if (o[0] === 127) return true; // loopback
    if (o[0] === 10) return true; // RFC1918
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // RFC1918
    if (o[0] === 192 && o[1] === 168) return true; // RFC1918
    if (o[0] === 169 && o[1] === 254) return true; // link-local incl. 169.254.169.254 (IMDS)
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
    if (o[0] === 0) return true;
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("::ffff:")) return isBlockedIp(lower.slice(7)); // v4-mapped
    return false;
  }
  return true; // not a literal IP -> caller resolves DNS first
}

async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked scheme '${u.protocol}' (only http/https allowed)`);
  }
  const host = u.hostname;
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`blocked address ${host} (loopback/private/link-local)`);
    return;
  }
  // Resolve the hostname and block if ANY resolved address is internal
  // (defends against DNS pointing at internal hosts / rebinding).
  const addrs = await dns.promises.lookup(host, { all: true });
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`blocked host ${host} -> ${a.address} (loopback/private/link-local)`);
    }
  }
}

// We'll try to load turndown, fall back to basic HTML stripping
let TurndownService: any;
try {
  TurndownService = require("turndown");
} catch {
  TurndownService = null;
}

export const fetchIndexSchema = z.object({
  url: z.string().describe("The URL to fetch and index"),
  source: z
    .string()
    .optional()
    .describe("Label for the indexed content (e.g., 'React docs', 'API reference')"),
});

export type FetchIndexInput = z.infer<typeof fetchIndexSchema>;

async function fetchUrl(
  url: string,
  redirectsLeft: number = MAX_REDIRECTS
): Promise<{ body: string; contentType: string }> {
  // CC-SSRF-006 fix: validate the destination (scheme + resolved IP) on EVERY
  // hop, not just the first request.
  await assertUrlAllowed(url);
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      // Follow redirects (re-validated, depth-capped)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          reject(new Error("too many redirects"));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        fetchUrl(next, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const contentType = res.headers["content-type"] || "text/plain";
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        if (body.length < 1024 * 1024) {
          // 1MB cap
          body += chunk;
        }
      });
      res.on("end", () => resolve({ body, contentType }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

function htmlToMarkdown(html: string): string {
  if (TurndownService) {
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    return td.turndown(html);
  }

  // Basic HTML stripping fallback
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function handleFetchIndex(args: FetchIndexInput) {
  try {
    const { body, contentType } = await fetchUrl(args.url);
    const source = args.source || args.url;

    let text: string;
    if (contentType.includes("html")) {
      text = htmlToMarkdown(body);
    } else {
      text = body;
    }

    const redacted = redactSecrets(text);
    const chunks = autoChunk(redacted, source, contentType);

    // CC-E4 fix: one transaction for all chunks.
    indexContentBatch(chunks.map((c) => ({ source, label: c.label, content: c.content })));
    const indexed = chunks.length;

    // Return a preview (first 3KB)
    const preview = text.slice(0, 3000);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            url: args.url,
            source,
            content_type: contentType,
            total_bytes: Buffer.byteLength(text, "utf-8"),
            chunks_indexed: indexed,
            preview: preview + (text.length > 3000 ? "\n\n[...truncated — use ctx_search for full content]" : ""),
          }),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            url: args.url,
            error: err instanceof Error ? err.message : String(err),
          }),
        },
      ],
    };
  }
}
