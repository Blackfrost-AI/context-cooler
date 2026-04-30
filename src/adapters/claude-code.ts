// src/adapters/claude-code.ts — Claude Code MCP installer.
//
// Writes an "openclaw-context-saver" entry into ~/.claude.json under
// "mcpServers". This matches the existing install.py behaviour (the
// installer wrote to ~/.claude.json before v4.6); the adapter formalises
// it as a reusable, dry-run-aware unit.

import * as path from "path";
import {
  AdapterContext,
  AdapterResult,
  PlatformAdapter,
  SERVER_KEY,
} from "./types";
import {
  homeDir,
  readJsonOrEmpty,
  serverEntry,
  spliceServer,
  writeJsonAtomic,
} from "./util";

export class ClaudeCodeAdapter implements PlatformAdapter {
  readonly id = "claude-code";

  install(ctx: AdapterContext): AdapterResult {
    const configPath = path.join(homeDir(ctx.homeOverride), ".claude.json");

    if (ctx.dryRun) {
      return {
        platform: this.id,
        configPath,
        ok: true,
        detail: `would register ${SERVER_KEY} -> ${ctx.serverPath} in ${configPath}`,
      };
    }

    try {
      const config = readJsonOrEmpty(configPath);
      spliceServer(config, "mcpServers", SERVER_KEY, serverEntry(ctx.serverPath));
      writeJsonAtomic(configPath, config);
      return {
        platform: this.id,
        configPath,
        ok: true,
        detail: `registered ${SERVER_KEY} in ${configPath}`,
      };
    } catch (err) {
      return {
        platform: this.id,
        configPath,
        ok: false,
        detail: `failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
