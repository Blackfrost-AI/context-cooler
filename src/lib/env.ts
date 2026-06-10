import * as path from "path";
import * as fs from "fs";
import * as os from "os";

let _dataDir: string | null = null;
let _envLoaded = false;

export function getDataDir(): string {
  if (_dataDir) return _dataDir;
  _dataDir = process.env.CONTEXT_COOLER_HOME || os.homedir();
  return _dataDir;
}

export function getContextDir(): string {
  const dir = path.join(getDataDir(), "context");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getSkillsDir(): string {
  return path.join(getDataDir(), "workspace", "skills");
}

export function loadEnv(): Record<string, string> {
  if (_envLoaded) return process.env as Record<string, string>;

  const envPath = path.join(getDataDir(), ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
  _envLoaded = true;
  return process.env as Record<string, string>;
}

export function getSnapshotBudget(): number {
  const budget = parseInt(process.env.CTX_SNAPSHOT_BUDGET || "2048", 10);
  return Math.min(Math.max(budget, 256), 65536);
}

export function isFtsEnabled(): boolean {
  return process.env.CTX_FTS_ENABLED !== "0";
}

// CC-S4-005 fix: confine arbitrary-path reads (ctx_execute_file, ctx_index) to
// an allowlist of roots, mirroring the Python twin's realpath-prefix guard
// (ctx_batch.py:99-104). Default roots: the data dir tree and the current
// working directory (so legitimate project-file reads still work). The operator
// can add roots via CTX_FS_ALLOW (path-separator or comma delimited). Symlink
// escapes are blocked by resolving realpath before the prefix check.
export function allowedReadRoots(): string[] {
  const roots = [getDataDir(), process.cwd()];
  const extra = (process.env.CTX_FS_ALLOW || "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const e of extra) roots.push(e);
  return roots.map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return path.resolve(r);
    }
  });
}

export function assertPathAllowed(p: string): { ok: boolean; reason?: string } {
  let resolved: string;
  try {
    resolved = fs.realpathSync(p); // resolves symlinks; requires the file exist
  } catch {
    resolved = path.resolve(p);
  }
  const roots = allowedReadRoots();
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    reason: `path '${p}' is outside the allowed read roots. Allowed: ${roots.join(
      ", "
    )}. Add roots with CTX_FS_ALLOW.`,
  };
}
