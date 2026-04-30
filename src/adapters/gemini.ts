// src/adapters/gemini.ts — Gemini CLI MCP installer.
//
// The Gemini CLI keeps its settings (including MCP servers) in
// ~/.gemini/settings.json, with the MCP map under "mcpServers" — same
// shape as Claude Code.

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

export class GeminiAdapter implements PlatformAdapter {
  readonly id = "gemini";

  install(ctx: AdapterContext): AdapterResult {
    const configPath = path.join(
      homeDir(ctx.homeOverride),
      ".gemini",
      "settings.json"
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
