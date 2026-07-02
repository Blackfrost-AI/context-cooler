// src/adapters/util.ts — Helpers shared by every platform adapter.
//
// Atomic write (tmp + rename), JSON read/write, TOML text read/write + section
// splice for Grok's ~/.grok/config.toml (no third-party deps). Stdlib only.

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
export function serverEntry(
  serverPath: string,
  env: Record<string, string> = {},
): Record<string, unknown> {
  return {
    type: "stdio",
    command: "node",
    args: [serverPath],
    env,
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

// ── TOML helpers for Grok CLI adapter (stdlib only, narrow scope) ──

/** Read a TOML file as raw text (or "" if missing/unreadable). */
export function readTomlOrEmpty(p: string): string {
  if (!fs.existsSync(p)) return "";
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

/** Atomically write a TOML string (mkdir -p + tmp + rename). */
export function writeTomlAtomic(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const out = content.endsWith("\n") ? content : content + "\n";
  fs.writeFileSync(tmp, out, "utf-8");
  fs.renameSync(tmp, target);
}

/**
 * Remove any existing [mcp_servers.<serverKey>] block (text), then append
 * a freshly formatted block for the stdio entry. Preserves all other content.
 * Uses the [mcp_servers.name] header style that Grok docs recommend.
 */
export function spliceTomlServer(
  tomlText: string,
  serverKey: string,
  entry: Record<string, unknown>
): string {
  const sectionHeader = `[mcp_servers.${serverKey}]`;
  const lines = tomlText.split(/\r?\n/);
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === sectionHeader) {
      // skip header + all following non-[ lines (the block body)
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("[")) {
        i++;
      }
      continue;
    }
    kept.push(line);
    i++;
  }

  // drop trailing blank lines for cleanliness
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
    kept.pop();
  }

  const section = formatTomlMcpSection(serverKey, entry);
  let result = kept.join("\n").trimEnd();
  if (result.length > 0) {
    result += "\n\n";
  }
  result += section;
  return result;
}

/** Format just the [mcp_servers.<key>] block (command/args/env/enabled etc). */
function formatTomlMcpSection(serverKey: string, entry: Record<string, unknown>): string {
  let out = `[mcp_servers.${serverKey}]\n`;

  // Preferred key order for readability
  const preferred = ["command", "args", "env", "enabled", "startup_timeout_sec", "tool_timeout_sec"];
  const keys = [
    ...preferred.filter((k) => k in entry),
    ...Object.keys(entry).filter((k) => !preferred.includes(k)),
  ];

  for (const k of keys) {
    const v = entry[k];
    if (v === undefined || v === null) continue;

    if (k === "args" && Array.isArray(v)) {
      const arr = v.map((x) => JSON.stringify(String(x))).join(", ");
      out += `args = [${arr}]\n`;
    } else if (typeof v === "object" && !Array.isArray(v)) {
      const pairs = Object.entries(v as Record<string, unknown>)
        .map(([ek, ev]) => `${ek} = ${JSON.stringify(ev)}`)
        .join(", ");
      out += pairs ? `${k} = { ${pairs} }\n` : `${k} = {}\n`;
    } else if (typeof v === "boolean") {
      out += `${k} = ${v}\n`;
    } else if (typeof v === "number") {
      out += `${k} = ${v}\n`;
    } else {
      out += `${k} = ${JSON.stringify(v)}\n`;
    }
  }
  return out;
}
