/**
 * Session-transcript ingestion for Claude Code / Grok Stop|SessionEnd hooks.
 *
 * Reads a finished conversation transcript (JSONL, one message per line),
 * renders a compact, secret-redacted digest, and:
 *   1) indexes the digest into FTS5 (ctx_search recall), and
 *   2) logs a high-priority `session_summary` event (session continuity).
 *
 * Extractive only — no LLM/ML calls — to match the tool's "no embeddings"
 * design and keep the hook fast and dependency-free.
 */

import * as fs from "fs";
import * as path from "path";
import { handleIndex } from "../tools/index";
import { handleSession } from "../tools/session";
import { redactSecrets } from "./redact";

// Truncate noisy tool outputs — they rarely aid recall and bloat the index.
const MAX_TOOL_RESULT = 500;
// Cap the indexed conversation body per session (header is always kept).
const MAX_DIGEST_BYTES = 300_000;

export interface IngestOptions {
  transcriptPath: string;
  sessionId?: string;
  cwd?: string;
  reason?: string;
}

export interface IngestResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  source?: string;
  session_id?: string;
  chunks_indexed?: number;
  turns?: number;
  files?: number;
  commands?: number;
  event_logged?: boolean;
}

interface Accumulator {
  tools: Set<string>;
  files: Set<string>;
  commands: Set<string>;
  firstUser: string;
  turns: number;
  start: string;
  end: string;
}

/** Render one message's content array to text; harvest files/commands/tools. */
function renderContent(content: unknown, acc: Accumulator): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, any>;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text.trim()) parts.push(b.text);
        break;
      case "thinking":
        // Skip verbose internal reasoning — high volume, low recall value.
        break;
      case "tool_use": {
        const name = typeof b.name === "string" ? b.name : "tool";
        acc.tools.add(name);
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, any>;
        const fp = input.file_path || input.path || input.notebook_path;
        if (fp) acc.files.add(String(fp));
        if (name === "Bash" && input.command) {
          acc.commands.add(String(input.command).slice(0, 200));
        }
        const hint = fp || input.command || input.pattern || input.url || input.query || "";
        parts.push(`  → ${name}${hint ? ": " + String(hint).slice(0, 200) : ""}`);
        break;
      }
      case "tool_result": {
        let rc: unknown = b.content;
        if (Array.isArray(rc)) {
          rc = rc
            .map((x: any) => (typeof x === "string" ? x : x?.text || ""))
            .join("\n");
        }
        if (typeof rc !== "string") rc = JSON.stringify(rc ?? "");
        const clipped = (rc as string).slice(0, MAX_TOOL_RESULT);
        if (clipped.trim()) parts.push(`  [result] ${clipped}`);
        break;
      }
      default:
        break;
    }
  }
  return parts.join("\n");
}

// Slash-command / harness wrappers that precede the real ask in a transcript.
// Skipping them keeps `first_request` a genuine human ask, not boilerplate.
const WRAPPER_MARKERS = [
  "<local-command-caveat>",
  "<command-message>",
  "<command-name>",
  "<command-args>",
  "<system-reminder>",
  "Caveat: The messages below",
  "[Request interrupted",
];

function isWrapperNoise(s: string): boolean {
  const t = s.trimStart();
  return WRAPPER_MARKERS.some((m) => t.startsWith(m));
}

/** First genuine human text in a user message (skips tool_result-only turns
 *  and slash-command / harness wrapper boilerplate). Exported for tests. */
export function firstHumanText(content: unknown): string {
  if (typeof content === "string") {
    return isWrapperNoise(content) ? "" : content;
  }
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    const b = block as Record<string, any>;
    if (
      b &&
      b.type === "text" &&
      typeof b.text === "string" &&
      b.text.trim() &&
      !isWrapperNoise(b.text)
    ) {
      return b.text;
    }
  }
  return "";
}

export async function ingestTranscript(opts: IngestOptions): Promise<IngestResult> {
  const { transcriptPath } = opts;
  const reason = opts.reason || "session-end";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { success: false, skipped: true, reason: "no transcript_path" };
  }

  // Bind the event log to the host session id.
  if (opts.sessionId) process.env.CTX_SESSION_ID = opts.sessionId;

  const cwd = opts.cwd || process.cwd();
  const project = path.basename(cwd) || "unknown";
  const sessionId = opts.sessionId || path.basename(transcriptPath).replace(/\.jsonl$/i, "");

  const raw = fs.readFileSync(transcriptPath, "utf-8");
  const lines = raw.split("\n");

  const acc: Accumulator = {
    tools: new Set(),
    files: new Set(),
    commands: new Set(),
    firstUser: "",
    turns: 0,
    start: "",
    end: "",
  };
  const body: string[] = [];
  let bodyBytes = 0;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }

    if (typeof obj.timestamp === "string") {
      if (!acc.start) acc.start = obj.timestamp;
      acc.end = obj.timestamp;
    }

    if (obj.type === "summary" && typeof obj.summary === "string") {
      if (bodyBytes < MAX_DIGEST_BYTES) body.push(`[summary] ${obj.summary}`);
      continue;
    }

    const role = obj.message?.role || obj.type;
    if (role !== "user" && role !== "assistant") continue;

    const rendered = renderContent(obj.message?.content, acc);
    if (!rendered.trim()) continue;

    if (role === "assistant") acc.turns++;
    if (role === "user" && !acc.firstUser) {
      const human = firstHumanText(obj.message?.content).trim();
      if (human) acc.firstUser = human.slice(0, 500);
    }

    if (bodyBytes < MAX_DIGEST_BYTES) {
      const entry = `[${role}] ${rendered}`;
      body.push(entry);
      bodyBytes += Buffer.byteLength(entry, "utf-8");
    }
  }

  const header = [
    "SESSION DIGEST",
    `project: ${project}`,
    `session: ${sessionId}`,
    `cwd: ${cwd}`,
    `started: ${acc.start || "?"}`,
    `ended: ${acc.end || "?"} (${reason})`,
    `turns: ${acc.turns}`,
    `files touched: ${[...acc.files].slice(0, 40).join(", ") || "(none)"}`,
    `commands: ${[...acc.commands].slice(0, 25).join(" | ") || "(none)"}`,
    "",
    "--- first request ---",
    acc.firstUser || "(none captured)",
    "",
    "--- conversation ---",
  ].join("\n");

  const digest = header + "\n" + body.join("\n");
  const source = `session:${project}:${sessionId}`;

  // Index the digest (handleIndex redacts + chunks internally).
  let chunks = 0;
  try {
    const idx = await handleIndex({ content: digest, source });
    const parsed = JSON.parse(idx.content[0]?.text || "{}");
    chunks = parsed.chunks_indexed || 0;
  } catch {
    /* fail-open */
  }

  // Log a session_summary event (redact the payload; handleIndex only redacts the digest).
  let eventLogged = false;
  try {
    const summaryData = {
      session_id: sessionId,
      project,
      cwd,
      reason,
      started: acc.start,
      ended: acc.end,
      turns: acc.turns,
      first_request: acc.firstUser,
      files: [...acc.files].slice(0, 40),
      commands: [...acc.commands].slice(0, 25),
    };
    await handleSession({
      action: "log",
      event_type: "session_summary",
      priority: "high",
      data: redactSecrets(JSON.stringify(summaryData)),
      limit: 10,
    });
    eventLogged = true;
  } catch {
    /* fail-open */
  }

  return {
    success: true,
    source,
    session_id: sessionId,
    chunks_indexed: chunks,
    turns: acc.turns,
    files: acc.files.size,
    commands: acc.commands.size,
    event_logged: eventLogged,
  };
}
