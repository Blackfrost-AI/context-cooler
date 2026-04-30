// src/adapters/index.ts — Adapter registry and a tiny installer CLI.
//
// install.py shells out to `node dist/adapters/index.js install --platform=...`
// for each platform the user picked. Output is JSON (one line per result)
// so the Python side can parse status without scraping logs.

import { ClaudeCodeAdapter } from "./claude-code";
import { CursorAdapter } from "./cursor";
import { CodexAdapter } from "./codex";
import { GeminiAdapter } from "./gemini";
import { OpenCodeAdapter } from "./opencode";
import {
  AdapterContext,
  AdapterResult,
  PlatformAdapter,
} from "./types";

export const ADAPTERS: PlatformAdapter[] = [
  new ClaudeCodeAdapter(),
  new CursorAdapter(),
  new CodexAdapter(),
  new GeminiAdapter(),
  new OpenCodeAdapter(),
];

export const ADAPTER_IDS = ADAPTERS.map((a) => a.id);

export function findAdapter(id: string): PlatformAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export function installPlatform(
  id: string,
  ctx: AdapterContext
): AdapterResult {
  const adapter = findAdapter(id);
  if (!adapter) {
    return {
      platform: id,
      configPath: "",
      ok: false,
      detail: `unknown platform: ${id} (valid: ${ADAPTER_IDS.join(", ")})`,
    };
  }
  return adapter.install(ctx);
}

export function installAll(ctx: AdapterContext): AdapterResult[] {
  return ADAPTERS.map((a) => a.install(ctx));
}

// ── CLI entry point ──
//
// Usage:
//   node dist/adapters/index.js install --server=<abs-path> --platform=<id>
//   node dist/adapters/index.js install --server=<abs-path> --platform=all [--dry-run]
//   node dist/adapters/index.js list
//
// Output: JSON, one result per line (newline-delimited JSON).

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) {
        out[a.slice(2)] = true;
      } else {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      }
    }
  }
  return out;
}

function runCli(argv: string[]): number {
  const cmd = argv[0];
  const opts = parseArgs(argv.slice(1));

  if (cmd === "list") {
    process.stdout.write(JSON.stringify({ adapters: ADAPTER_IDS }) + "\n");
    return 0;
  }

  if (cmd !== "install") {
    process.stderr.write(
      "usage: node dist/adapters/index.js {install|list} [--server=PATH] [--platform=ID|all] [--dry-run]\n"
    );
    return 2;
  }

  const serverPath = typeof opts.server === "string" ? opts.server : "";
  if (!serverPath) {
    process.stderr.write("error: --server=<absolute-path> is required\n");
    return 2;
  }

  const platform = typeof opts.platform === "string" ? opts.platform : "all";
  const dryRun = opts["dry-run"] === true;
  const ctx: AdapterContext = { serverPath, dryRun };

  const results: AdapterResult[] =
    platform === "all" ? installAll(ctx) : [installPlatform(platform, ctx)];

  for (const r of results) {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
  const allOk = results.every((r) => r.ok);
  return allOk ? 0 : 1;
}

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}
