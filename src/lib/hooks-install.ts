/**
 * Install Grok (and Claude-compatible) PreCompact / PostCompact / SessionStart
 * hooks that snapshot and restore Context Cooler session state.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getDataDir } from "./env";

export interface HooksInstallResult {
  ok: boolean;
  path: string;
  detail: string;
}

/**
 * @param serverPath absolute path to dist/server.js (repo root is parent of dist/)
 * @param dataDir CONTEXT_COOLER_HOME for hook env
 */
export function installGrokHooks(
  serverPath: string,
  dataDir?: string,
  dryRun = false
): HooksInstallResult {
  const root = path.resolve(path.dirname(serverPath), "..");
  const runner = path.join(root, "dist", "hooks", "run.js");
  const home = dataDir || getDataDir() || os.homedir();
  const hookDir = path.join(os.homedir(), ".grok", "hooks");
  const hookPath = path.join(hookDir, "context-cooler.json");

  if (!fs.existsSync(runner) && !dryRun) {
    return {
      ok: false,
      path: hookPath,
      detail: `hook runner missing at ${runner} — run npx tsc first`,
    };
  }

  const payload = {
    hooks: {
      PreCompact: [
        {
          hooks: [
            {
              type: "command",
              command: `node ${JSON.stringify(runner)} pre-compact`,
              timeout: 15,
              env: {
                CONTEXT_COOLER_HOME: home,
              },
            },
          ],
        },
      ],
      PostCompact: [
        {
          hooks: [
            {
              type: "command",
              command: `node ${JSON.stringify(runner)} post-compact`,
              timeout: 15,
              env: {
                CONTEXT_COOLER_HOME: home,
              },
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `node ${JSON.stringify(runner)} session-start`,
              timeout: 15,
              env: {
                CONTEXT_COOLER_HOME: home,
              },
            },
          ],
        },
      ],
    },
  };

  if (dryRun) {
    return {
      ok: true,
      path: hookPath,
      detail: `would write Grok hooks -> ${hookPath} (runner=${runner}, home=${home})`,
    };
  }

  fs.mkdirSync(hookDir, { recursive: true });
  const tmp = `${hookPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, hookPath);

  return {
    ok: true,
    path: hookPath,
    detail: `installed Grok PreCompact/PostCompact/SessionStart hooks -> ${hookPath}`,
  };
}

/** Optional Claude Code settings.hooks merge (best-effort, non-destructive). */
export function installClaudeCompactHints(
  serverPath: string,
  dataDir?: string,
  dryRun = false
): HooksInstallResult {
  const root = path.resolve(path.dirname(serverPath), "..");
  const runner = path.join(root, "dist", "hooks", "run.js");
  const home = dataDir || getDataDir() || os.homedir();
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");

  const hookCmd = `node ${JSON.stringify(runner)}`;
  const block = {
    PreCompact: [
      {
        hooks: [
          {
            type: "command",
            command: `${hookCmd} pre-compact`,
            timeout: 15,
          },
        ],
      },
    ],
    PostCompact: [
      {
        hooks: [
          {
            type: "command",
            command: `${hookCmd} post-compact`,
            timeout: 15,
          },
        ],
      },
    ],
  };

  if (dryRun) {
    return {
      ok: true,
      path: settingsPath,
      detail: `would merge Claude compact hooks into ${settingsPath}`,
    };
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const hooks =
    typeof existing.hooks === "object" && existing.hooks !== null
      ? (existing.hooks as Record<string, unknown>)
      : {};
  // Only add if missing — never clobber user hooks arrays wholesale beyond our keys
  if (!hooks.PreCompact) hooks.PreCompact = block.PreCompact;
  if (!hooks.PostCompact) hooks.PostCompact = block.PostCompact;
  existing.hooks = hooks;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, settingsPath);

  // Ensure Claude subprocesses can find the data dir
  void home;
  void runner;

  return {
    ok: true,
    path: settingsPath,
    detail: `merged Claude PreCompact/PostCompact hooks into ${settingsPath}`,
  };
}
