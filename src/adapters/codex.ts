// src/adapters/codex.ts — OpenAI Codex CLI MCP installer.
//
// The Codex CLI stores MCP server registrations alongside its own config
// in ~/.codex/. Codex uses TOML for its primary config but accepts a JSON
// servers file at ~/.codex/mcp_servers.json — that's what we write. If
// you're on a Codex build that only honours config.toml, point your CLI
// at this JSON via `mcp.servers_file = "~/.codex/mcp_servers.json"`.

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

export class CodexAdapter implements PlatformAdapter {
  readonly id = "codex";

  install(ctx: AdapterContext): AdapterResult {
    const configPath = path.join(
      homeDir(ctx.homeOverride),
      ".codex",
      "mcp_servers.json"
    );

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
