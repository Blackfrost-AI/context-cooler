#!/usr/bin/env node
/**
 * Context Cooler compact/session hook runner.
 * Invoked by Grok (or Claude-compatible) hooks on PreCompact / PostCompact / SessionStart.
 *
 * Usage:
 *   node dist/hooks/run.js pre-compact
 *   node dist/hooks/run.js post-compact
 *   node dist/hooks/run.js session-start
 *
 * Reads GROK_SESSION_ID / CLAUDE_SESSION_ID from the environment when present
 * and sets CTX_SESSION_ID so events stick to the host conversation.
 */

import * as fs from "fs";
import * as path from "path";
import { getContextDir } from "../lib/env";
import {
  getSessionId,
  generateSessionId,
  handleSession,
} from "../tools/session";
import { ingestTranscript } from "../lib/ingest";

function bindHostSession(explicitId?: string): string {
  const host =
    explicitId?.trim() ||
    process.env.GROK_SESSION_ID?.trim() ||
    process.env.CLAUDE_SESSION_ID?.trim() ||
    process.env.CTX_SESSION_ID?.trim();
  if (host) {
    process.env.CTX_SESSION_ID = host;
    // also stick for non-env consumers
    try {
      const p = path.join(getContextDir(), ".session_id");
      fs.writeFileSync(p, host);
    } catch {
      /* ignore */
    }
    return host;
  }
  return getSessionId();
}

async function main(): Promise<number> {
  const action = (process.argv[2] || "").toLowerCase();
  // Capture stdin (Grok/Claude send event JSON) so the pipe doesn't block and
  // session-end can read transcript_path / session_id from the hook payload.
  let stdinRaw = "";
  try {
    stdinRaw = await new Promise<string>((resolve) => {
      if (process.stdin.isTTY) return resolve("");
      let buf = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (c) => (buf += c));
      process.stdin.on("end", () => resolve(buf));
      setTimeout(() => resolve(buf), 500);
    });
  } catch {
    /* ignore */
  }
  let hookInput: Record<string, any> = {};
  try {
    hookInput = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch {
    hookInput = {};
  }

  const sessionId = bindHostSession(
    typeof hookInput.session_id === "string" ? hookInput.session_id : undefined
  );
  const logPath = path.join(getContextDir(), "hooks.log");
  const log = (msg: string) => {
    try {
      fs.appendFileSync(
        logPath,
        `${new Date().toISOString()} [${action}] session=${sessionId} ${msg}\n`
      );
    } catch {
      /* ignore */
    }
  };

  try {
    if (action === "pre-compact" || action === "snapshot") {
      const r = await handleSession({
        action: "snapshot",
        priority: "medium",
        limit: 10,
      });
      const text = r.content[0]?.type === "text" ? r.content[0].text : "";
      log(text.slice(0, 500));
      process.stdout.write(text + "\n");
      return 0;
    }
    if (action === "post-compact" || action === "restore") {
      const r = await handleSession({
        action: "restore",
        priority: "medium",
        limit: 10,
      });
      const text = r.content[0]?.type === "text" ? r.content[0].text : "";
      log(text.slice(0, 500));
      // Hooks are passive — print restore payload so hosts that surface stdout can inject it.
      process.stdout.write(text + "\n");
      return 0;
    }
    if (action === "session-start") {
      // Bind id + soft restore so the agent has continuity material early.
      const r = await handleSession({
        action: "restore",
        priority: "medium",
        limit: 10,
      });
      const text = r.content[0]?.type === "text" ? r.content[0].text : "";
      log(`bound session; restore=${text.slice(0, 200)}`);
      // Also surface recent events if restore was empty-ish
      const recent = await handleSession({
        action: "recent",
        limit: 8,
        priority: "medium",
      });
      const recentText =
        recent.content[0]?.type === "text" ? recent.content[0].text : "";
      process.stdout.write(
        JSON.stringify({
          success: true,
          session_id: sessionId,
          restore: JSON.parse(text || "{}"),
          recent: JSON.parse(recentText || "{}"),
        }) + "\n"
      );
      return 0;
    }

    if (action === "session-end" || action === "stop") {
      const transcriptPath =
        typeof hookInput.transcript_path === "string"
          ? hookInput.transcript_path
          : "";
      const r = await ingestTranscript({
        transcriptPath,
        sessionId,
        cwd: typeof hookInput.cwd === "string" ? hookInput.cwd : process.cwd(),
        reason: typeof hookInput.reason === "string" ? hookInput.reason : action,
      });
      log(`ingest ${JSON.stringify(r).slice(0, 300)}`);
      process.stdout.write(JSON.stringify(r) + "\n");
      return 0;
    }

    process.stderr.write(
      `usage: node dist/hooks/run.js {pre-compact|post-compact|session-start|session-end}\n`
    );
    return 2;
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    // fail-open for hooks
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        session_id: sessionId || generateSessionId(),
      }) + "\n"
    );
    return 0;
  }
}

main().then((code) => process.exit(code));
