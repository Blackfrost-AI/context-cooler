// src/adapters/util.ts — Helpers shared by every platform adapter.
//
// Atomic write (tmp + rename), JSON read with empty-default, and a tiny
// "merge a server entry into an mcpServers map" routine. Stdlib only.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export function homeDir(override?: string): string {
  return override ?? os.homedir();
}

export function readJsonOrEmpty(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, "utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function writeJsonAtomic(target: string, data: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, target);
}

// Build the standard stdio MCP server entry used by every adapter.
export function serverEntry(serverPath: string): Record<string, unknown> {
  return {
    type: "stdio",
    command: "node",
    args: [serverPath],
    env: {},
  };
}

// Splice a server entry into a JSON config under a top-level "mcpServers"
// (or alternative) key. Returns the mutated object.
export function spliceServer(
  config: Record<string, unknown>,
  topKey: string,
  serverKey: string,
  entry: Record<string, unknown>
): Record<string, unknown> {
  const servers =
    typeof config[topKey] === "object" && config[topKey] !== null
      ? (config[topKey] as Record<string, unknown>)
      : {};
  servers[serverKey] = entry;
  config[topKey] = servers;
  return config;
}
