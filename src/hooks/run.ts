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

/**
 * Fail-LOUD binding health check.
 * The brain layer (db.ts) fails open by design so a broken brain never kills
 * the host agent's hooks — but that turns a missing better-sqlite3 binding
 * into SILENT, weeks-long data loss (the 2026-07-31 node-upgrade outage:
 * 383 swallowed errors before anyone noticed). Detect it once, up front, and
 * make the failure unmissable in both hooks.log and stderr.
 */
function assertDbBinding(action: string, sessionId: string): void {
  try {
    // better-sqlite3 loads its native binding LAZILY on first Database() —
    // a bare require() succeeds even when the binding is gone. Probe with a
    // throwaway in-memory DB to force the load and surface the real failure.
    const Database = require("better-sqlite3");
    const probe = new Database(":memory:");
    probe.close();
  } catch (err) {
    const msg =
      err instanceof Error ? err.message.split("\n")[0] : String(err);
    const hint =
      "[FATAL] context-cooler brain OFFLINE: better-sqlite3 binding will not load. " +
      "No context will be saved until fixed. Fix: run `npm ci` (or `npm i better-sqlite3`) in " +
      __dirname.replace(/dist\/hooks$/, "") +
      ` after a node upgrade (details: ${msg})`;
    try {
      fs.appendFileSync(
        path.join(getContextDir(), "hooks.log"),
        `${new Date().toISOString()} [${action}] session=${sessionId} ${hint}\n`
      );
    } catch {
      /* ignore */
    }
    process.stderr.write(hint + "\n");
    process.stdout.write(
      JSON.stringify({
        success: false,
        fatal: "better-sqlite3 binding missing — run npm ci in the context-cooler clone",
        session_id: sessionId,
      }) + "\n"
    );
    process.exit(0); // fail-open: never block the host agent
  }
}

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

  assertDbBinding(action, sessionId);

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
      // fail-LOUD continuity check: `fallback:true` is normal (fresh session ids),
      // so use event RECENCY instead — if the brain has zero recent events, or
      // nothing newer than 48h, ingestion has likely been failing silently.
      try {
        const recentParsed = JSON.parse(recentText || "{}");
        const events = Array.isArray(recentParsed?.events)
          ? recentParsed.events
          : [];
        let warn: string | undefined;
        if (recentParsed?.success === true && events.length === 0) {
          warn =
            "[WARN] brain has ZERO recent events — session ingestion may be failing; check hooks.log for binding/DB errors";
        } else if (events.length > 0) {
          const newest = events
            .map((e: { t?: string }) => e?.t || "")
            .filter(Boolean)
            .sort()
            .pop();
          if (
            newest &&
            Date.now() - new Date(newest).getTime() >
              48 * 60 * 60 * 1000
          ) {
            warn = `[WARN] newest brain event is stale (${newest}) — session ingestion may be failing; check hooks.log for binding/DB errors`;
          }
        }
        if (warn) log(warn);
      } catch {
        /* recent payload shape unknown; ignore */
      }
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
    // Safe to keep the full message: hooks.log is local-only (no stdout
    // injection risk), and it was the only breadcrumb during the silent
    // 2026-07 outage. Do NOT truncate.
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
