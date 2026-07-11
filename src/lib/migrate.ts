/**
 * Discover fragmented Context Cooler data dirs and merge into the active one.
 * Multiple installs historically wrote to ~/context, ~/.context-cooler/context,
 * ~/.openclaw/context, ~/craig/context — agents then "forgot" across homes.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import { getDataDir, getContextDir } from "./env";

export interface FragmentInfo {
  path: string;
  runs: number;
  fts_rows: number;
  events: number;
  snapshots: number;
  exists: boolean;
}

export function candidateContextDirs(extra: string[] = []): string[] {
  const home = os.homedir();
  const defaults = [
    path.join(home, "context"),
    path.join(home, ".context-cooler", "context"),
    path.join(home, ".openclaw", "context"),
    path.join(home, "craig", "context"),
    path.join(home, ".shadow", "context"),
  ];
  const active = getContextDir();
  const all = new Set<string>([...defaults, ...extra, active]);
  return [...all].map((p) => path.resolve(p));
}

function countTable(dbPath: string, table: string): number {
  if (!fs.existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      return row?.c ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

export function inspectFragment(contextDir: string): FragmentInfo {
  const stats = path.join(contextDir, "stats.db");
  const sessions = path.join(contextDir, "sessions.db");
  const exists = fs.existsSync(stats) || fs.existsSync(sessions);
  return {
    path: contextDir,
    exists,
    runs: countTable(stats, "runs"),
    fts_rows: countTable(stats, "fts_index"),
    events: countTable(sessions, "events"),
    snapshots: countTable(sessions, "snapshots"),
  };
}

export function listFragments(): FragmentInfo[] {
  return candidateContextDirs()
    .map(inspectFragment)
    .filter((f) => f.exists && (f.runs + f.fts_rows + f.events + f.snapshots > 0));
}

function ensureTargetTables(targetCtx: string): void {
  fs.mkdirSync(targetCtx, { recursive: true });
  const statsPath = path.join(targetCtx, "stats.db");
  const sessPath = path.join(targetCtx, "sessions.db");

  const stats = new Database(statsPath);
  stats.pragma("journal_mode = WAL");
  stats.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      skill TEXT NOT NULL,
      command TEXT NOT NULL,
      intent TEXT,
      raw_bytes INTEGER NOT NULL,
      summary_bytes INTEGER NOT NULL,
      savings_pct REAL NOT NULL
    );
  `);
  try {
    stats.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_index USING fts5(
        source, label, content, timestamp, tokenize='porter'
      );
    `);
  } catch {
    /* FTS may already exist */
  }
  stats.close();

  const sess = new Database(sessPath);
  sess.pragma("journal_mode = WAL");
  sess.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      priority TEXT NOT NULL,
      priority_level INTEGER NOT NULL,
      data TEXT NOT NULL,
      byte_size INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      byte_size INTEGER NOT NULL
    );
  `);
  sess.close();
}

export interface MergeResult {
  source: string;
  target: string;
  runs_copied: number;
  fts_copied: number;
  events_copied: number;
  snapshots_copied: number;
  skipped: boolean;
  detail: string;
}

/**
 * Copy rows from source context dir into target (active) context dir.
 * Does not delete source. Dedups FTS by (source,label) last-write-wins.
 */
export function mergeFragment(
  sourceCtx: string,
  targetCtx: string,
  dryRun = false
): MergeResult {
  const base: MergeResult = {
    source: sourceCtx,
    target: targetCtx,
    runs_copied: 0,
    fts_copied: 0,
    events_copied: 0,
    snapshots_copied: 0,
    skipped: false,
    detail: "",
  };

  if (path.resolve(sourceCtx) === path.resolve(targetCtx)) {
    return { ...base, skipped: true, detail: "source is the active data dir" };
  }

  const srcStats = path.join(sourceCtx, "stats.db");
  const srcSess = path.join(sourceCtx, "sessions.db");
  if (!fs.existsSync(srcStats) && !fs.existsSync(srcSess)) {
    return { ...base, skipped: true, detail: "no databases in source" };
  }

  if (dryRun) {
    const info = inspectFragment(sourceCtx);
    return {
      ...base,
      runs_copied: info.runs,
      fts_copied: info.fts_rows,
      events_copied: info.events,
      snapshots_copied: info.snapshots,
      detail: "dry-run — would copy these counts",
    };
  }

  ensureTargetTables(targetCtx);
  const tgtStats = new Database(path.join(targetCtx, "stats.db"));
  const tgtSess = new Database(path.join(targetCtx, "sessions.db"));

  try {
    if (fs.existsSync(srcStats)) {
      const src = new Database(srcStats, { readonly: true });
      try {
        // runs
        try {
          const runs = src.prepare("SELECT timestamp, skill, command, intent, raw_bytes, summary_bytes, savings_pct FROM runs").all() as Array<{
            timestamp: string;
            skill: string;
            command: string;
            intent: string | null;
            raw_bytes: number;
            summary_bytes: number;
            savings_pct: number;
          }>;
          const ins = tgtStats.prepare(
            `INSERT INTO runs (timestamp, skill, command, intent, raw_bytes, summary_bytes, savings_pct)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          );
          const tx = tgtStats.transaction(() => {
            for (const r of runs) {
              ins.run(r.timestamp, r.skill, r.command, r.intent, r.raw_bytes, r.summary_bytes, r.savings_pct);
              base.runs_copied++;
            }
          });
          tx();
        } catch {
          /* table missing */
        }

        // fts
        try {
          const rows = src
            .prepare("SELECT source, label, content, timestamp FROM fts_index")
            .all() as Array<{ source: string; label: string; content: string; timestamp: string }>;
          const del = tgtStats.prepare("DELETE FROM fts_index WHERE source = ? AND label = ?");
          const ins = tgtStats.prepare(
            "INSERT INTO fts_index (source, label, content, timestamp) VALUES (?, ?, ?, ?)"
          );
          const tx = tgtStats.transaction(() => {
            for (const r of rows) {
              del.run(r.source, r.label);
              ins.run(r.source, r.label, r.content, r.timestamp);
              base.fts_copied++;
            }
          });
          tx();
        } catch {
          /* no fts */
        }
      } finally {
        src.close();
      }
    }

    if (fs.existsSync(srcSess)) {
      const src = new Database(srcSess, { readonly: true });
      try {
        try {
          const events = src
            .prepare(
              "SELECT timestamp, session_id, event_type, priority, priority_level, data, byte_size FROM events"
            )
            .all() as Array<{
            timestamp: string;
            session_id: string;
            event_type: string;
            priority: string;
            priority_level: number;
            data: string;
            byte_size: number;
          }>;
          const ins = tgtSess.prepare(
            `INSERT INTO events (timestamp, session_id, event_type, priority, priority_level, data, byte_size)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          );
          const tx = tgtSess.transaction(() => {
            for (const e of events) {
              ins.run(
                e.timestamp,
                e.session_id,
                e.event_type,
                e.priority,
                e.priority_level,
                e.data,
                e.byte_size
              );
              base.events_copied++;
            }
          });
          tx();
        } catch {
          /* */
        }
        try {
          const snaps = src
            .prepare("SELECT timestamp, session_id, snapshot, byte_size FROM snapshots")
            .all() as Array<{
            timestamp: string;
            session_id: string;
            snapshot: string;
            byte_size: number;
          }>;
          const ins = tgtSess.prepare(
            `INSERT INTO snapshots (timestamp, session_id, snapshot, byte_size) VALUES (?, ?, ?, ?)`
          );
          const tx = tgtSess.transaction(() => {
            for (const s of snaps) {
              ins.run(s.timestamp, s.session_id, s.snapshot, s.byte_size);
              base.snapshots_copied++;
            }
          });
          tx();
        } catch {
          /* */
        }
      } finally {
        src.close();
      }
    }

    base.detail = "merged into active data dir (source left intact)";
    return base;
  } finally {
    tgtStats.close();
    tgtSess.close();
  }
}

export function mergeAllFragments(dryRun = false): {
  target: string;
  data_dir: string;
  merges: MergeResult[];
} {
  const dataDir = getDataDir();
  const target = getContextDir();
  const fragments = listFragments().filter(
    (f) => path.resolve(f.path) !== path.resolve(target)
  );
  const merges = fragments.map((f) => mergeFragment(f.path, target, dryRun));
  return { target, data_dir: dataDir, merges };
}
