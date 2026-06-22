// src/adapters/shadow.ts — Shadow CLI MCP installer.
//
// Shadow (github.com/Blackfrost-AI/shadow-cli) is a provider-neutral, Claude
// Code-style terminal agent. It reads global config from ~/.shadow/config.json
// and auto-registers every stdio/http server listed under the "mcpServers" key
// at startup, so Context Cooler drops straight in — no harness changes needed.
//
// We write to ~/.shadow/config.json (the global, per-user config layer), which
// is the correct home for a machine-specific MCP server path. Shadow's config
// schema accepts { command, args, env } and ignores the extra "type" field.

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

export class ShadowAdapter implements PlatformAdapter {
  readonly id = "shadow";

  install(ctx: AdapterContext): AdapterResult {
    const configPath = path.join(homeDir(ctx.homeOverride), ".shadow", "config.json");

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
