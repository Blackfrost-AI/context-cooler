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
