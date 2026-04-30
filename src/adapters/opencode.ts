// src/adapters/opencode.ts — OpenCode MCP installer.
//
// OpenCode (sst/opencode) reads its config from ~/.config/opencode/opencode.json
// and looks for MCP servers under the top-level "mcp" key. The entry shape
// we write is the same stdio { command, args } object every other adapter
// uses; OpenCode tolerates extra fields.

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

export class OpenCodeAdapter implements PlatformAdapter {
  readonly id = "opencode";

  install(ctx: AdapterContext): AdapterResult {
    const configPath = path.join(
      homeDir(ctx.homeOverride),
      ".config",
      "opencode",
      "opencode.json"
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
      spliceServer(config, "mcp", SERVER_KEY, serverEntry(ctx.serverPath));
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
