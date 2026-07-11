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

// v6: default raised from 2KB → 16KB. Coding-agent continuity (decisions,
// next steps, file paths) cannot survive in 2KB; ops-only installs can still
// set CTX_SNAPSHOT_BUDGET=2048. Clamp remains 256–65536.
export function getSnapshotBudget(): number {
  const budget = parseInt(process.env.CTX_SNAPSHOT_BUDGET || "16384", 10);
  return Math.min(Math.max(budget, 256), 65536);
}

/** When true (default), successful ctx_execute* calls auto-log a compact event. */
export function isAutoLogEnabled(): boolean {
  return process.env.CTX_AUTO_LOG !== "0";
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
  // Confine to the workspace subtree (mirrors the Python twin's
  // <DATA_DIR>/workspace guard) + the current project dir — NOT the whole data
  // dir, which defaults to os.homedir() and would otherwise leave ~/.ssh, ~/.aws
  // readable in a default (no CONTEXT_COOLER_HOME) deployment. (Adversarial-review
  // catch on CC-S4-005.)
  const roots = [path.join(getDataDir(), "workspace"), process.cwd()];
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
