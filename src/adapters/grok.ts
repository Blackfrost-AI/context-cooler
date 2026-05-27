// src/adapters/grok.ts — Grok CLI (xAI) MCP installer.
//
// Grok CLI stores MCP server config in ~/.grok/config.toml under a
// [mcp_servers.<name>] table (TOML). We use the same stdio entry shape as
// every other adapter. Grok also auto-loads ~/.claude.json for compatibility
// (so context-cooler already "just works" for many users), but writing the
// native TOML makes Grok treat it as a first-class configured server and
// allows project-scoped overrides in repo/.grok/config.toml later.
//
// Atomic write + dry-run support, stdlib + our tiny TOML helpers only.

import * as path from "path";
import {
  AdapterContext,
  AdapterResult,
  PlatformAdapter,
  SERVER_KEY,
} from "./types";
import {
  homeDir,
  readTomlOrEmpty,
  serverEntry,
  spliceTomlServer,
  writeTomlAtomic,
} from "./util";

export class GrokAdapter implements PlatformAdapter {
  readonly id = "grok";

  install(ctx: AdapterContext): AdapterResult {
    const configPath = path.join(homeDir(ctx.homeOverride), ".grok", "config.toml");

    if (ctx.dryRun) {
      return {
        platform: this.id,
        configPath,
        ok: true,
        detail: `would register ${SERVER_KEY} -> ${ctx.serverPath} in ${configPath}`,
      };
    }

    try {
      const existing = readTomlOrEmpty(configPath);
      // Start from the standard entry and add Grok-specific niceties
      const base = serverEntry(ctx.serverPath);
      const entry: Record<string, unknown> = {
        ...base,
        enabled: true,
      };
      delete entry.type; // Grok toml uses command/args shape; type is for JSON platforms
      const newContent = spliceTomlServer(existing, SERVER_KEY, entry);
      writeTomlAtomic(configPath, newContent);
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
