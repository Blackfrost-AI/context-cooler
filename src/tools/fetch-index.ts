import { z } from "zod";
import * as https from "https";
import * as http from "http";
import { indexContent } from "../lib/db";
import { redactSecrets } from "../lib/redact";
import { autoChunk } from "../lib/chunker";

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

async function fetchUrl(url: string): Promise<{ body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
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

    let indexed = 0;
    for (const chunk of chunks) {
      indexContent(source, chunk.label, chunk.content);
      indexed++;
    }

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
