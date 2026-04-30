// src/adapters/types.ts — Shared types for platform adapters.
//
// Each adapter knows how to write a single MCP-server entry into the
// configuration file used by its host (Claude Code, Cursor, Codex, etc.).
// Adapters are deliberately small: they read an existing JSON file, splice
// in our server entry, and write atomically (tmp + rename).

export interface AdapterContext {
  // Absolute path to dist/server.js — this is what the host will spawn.
  serverPath: string;
  // If true, no files are written; the adapter logs what it would do.
  dryRun: boolean;
  // Override $HOME (only used by tests). Defaults to os.homedir().
  homeOverride?: string;
}

export interface AdapterResult {
  // Stable platform id (claude-code | cursor | codex | gemini | opencode).
  platform: string;
  // Absolute path the adapter wrote (or would write) to.
  configPath: string;
  // True if the adapter succeeded (or would succeed under --dry-run).
  ok: boolean;
  // Human-readable summary suitable for printing to a terminal.
  detail: string;
}

export interface PlatformAdapter {
  readonly id: string;
  install(ctx: AdapterContext): AdapterResult;
}

export const SERVER_KEY = "openclaw-context-saver";
