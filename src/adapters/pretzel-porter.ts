// src/adapters/pretzel-porter.ts — Pretzel Porter MCP installer.
//
// Pretzel Porter (github.com/tlancas25/Pretzel-Porter) is a self-hosted-LLM
// terminal agent — a Claude Code-style agent that runs entirely on a local or
// privately-hosted Ollama model. It reads layered config from ~/.pretzel-porter/
// and connects to stdio MCP servers listed under the "mcpServers" key, so
// Context Cooler drops straight in.
//
// We write to ~/.pretzel-porter/agent.config.local.json — the per-user,
// gitignored config layer, which is the correct home for a machine-specific
// MCP server path (it is loaded last and overrides the committed config).

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

export class PretzelPorterAdapter implements PlatformAdapter {
  readonly id = "pretzel-porter";

  install(ctx: AdapterContext): AdapterResult {
    const configPath = path.join(
      homeDir(ctx.homeOverride),
      ".pretzel-porter",
      "agent.config.local.json"
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
