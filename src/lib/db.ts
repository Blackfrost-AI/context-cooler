import Database from "better-sqlite3";
import * as path from "path";
import { getContextDir, isFtsEnabled } from "./env";

let _statsDb: Database.Database | null = null;
let _sessionsDb: Database.Database | null = null;

export function getStatsDb(): Database.Database {
  if (_statsDb) return _statsDb;

  const dbPath = path.join(getContextDir(), "stats.db");
  _statsDb = new Database(dbPath);
  _statsDb.pragma("journal_mode = WAL");
  _statsDb.pragma("synchronous = NORMAL");

  // Create runs table
  _statsDb.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      skill TEXT NOT NULL,
      command TEXT NOT NULL,
      intent TEXT,
      raw_bytes INTEGER NOT NULL,
      summary_bytes INTEGER NOT NULL,
      savings_pct REAL NOT NULL
    )
  `);

  // Create FTS5 index if enabled
  if (isFtsEnabled()) {
    try {
      // Check if fts_index already exists (may have old schema: skill,command,content,timestamp)
      const existing = _statsDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index'")
        .get();

      if (!existing) {
        _statsDb.exec(`
          CREATE VIRTUAL TABLE fts_index USING fts5(
            source,
            label,
            content,
            timestamp,
            tokenize='porter'
          )
        `);
      } else {
        // Detect old schema (skill,command) vs new (source,label)
        // by trying a query with 'source' column
        try {
          _statsDb.prepare("SELECT source FROM fts_index LIMIT 0").get();
        } catch {
          // Old schema — migrate by recreating
          _statsDb.exec("DROP TABLE fts_index");
          _statsDb.exec(`
            CREATE VIRTUAL TABLE fts_index USING fts5(
              source,
              label,
              content,
              timestamp,
              tokenize='porter'
            )
          `);
        }
      }
    } catch {
      // FTS5 might not be available — skip
    }
  }

  return _statsDb;
}

export function getSessionsDb(): Database.Database {
  if (_sessionsDb) return _sessionsDb;

  const dbPath = path.join(getContextDir(), "sessions.db");
  _sessionsDb = new Database(dbPath);
  _sessionsDb.pragma("journal_mode = WAL");
  _sessionsDb.pragma("synchronous = NORMAL");

  _sessionsDb.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      priority TEXT NOT NULL,
      priority_level INTEGER NOT NULL,
      data TEXT NOT NULL,
      byte_size INTEGER NOT NULL
    )
  `);

  _sessionsDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_session
    ON events(session_id)
  `);

  _sessionsDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_priority
    ON events(priority_level)
  `);

  _sessionsDb.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      byte_size INTEGER NOT NULL
    )
  `);

  return _sessionsDb;
}

export function recordRun(
  skill: string,
  command: string,
  intent: string | null,
  rawBytes: number,
  summaryBytes: number,
  savingsPct: number
): void {
  const db = getStatsDb();
  const stmt = db.prepare(`
    INSERT INTO runs (timestamp, skill, command, intent, raw_bytes, summary_bytes, savings_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(new Date().toISOString(), skill, command, intent, rawBytes, summaryBytes, savingsPct);
}

const MAX_INDEX_CONTENT = 100 * 1024; // 100KB per entry
const MAX_INDEX_ROWS = 10000;

export function indexContent(
  source: string,
  label: string,
  content: string
): void {
  if (!isFtsEnabled()) return;

  const db = getStatsDb();

  // Check if fts_index exists
  const tableCheck = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index'"
    )
    .get();
  if (!tableCheck) return;

  // Truncate content if too large
  const truncated =
    content.length > MAX_INDEX_CONTENT
      ? content.slice(0, MAX_INDEX_CONTENT)
      : content;

  // Prune old entries if at limit
  const count = db
    .prepare("SELECT COUNT(*) as cnt FROM fts_index")
    .get() as { cnt: number };
  if (count && count.cnt >= MAX_INDEX_ROWS) {
    db.exec(`
      DELETE FROM fts_index WHERE rowid IN (
        SELECT rowid FROM fts_index ORDER BY rowid ASC LIMIT 100
      )
    `);
  }

  // Delete existing entries with same source+label for dedup
  db.prepare("DELETE FROM fts_index WHERE source = ? AND label = ?").run(
    source,
    label
  );

  db.prepare(
    "INSERT INTO fts_index (source, label, content, timestamp) VALUES (?, ?, ?, ?)"
  ).run(source, label, truncated, new Date().toISOString());
}

export function searchIndex(
  query: string,
  source?: string,
  limit: number = 10
): Array<{ source: string; label: string; content: string; timestamp: string }> {
  const db = getStatsDb();

  const tableCheck = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index'"
    )
    .get();
  if (!tableCheck) return [];

  try {
    let sql: string;
    let params: unknown[];

    if (source) {
      sql = `SELECT source, label, content, timestamp, rank
             FROM fts_index WHERE fts_index MATCH ? AND source = ?
             ORDER BY rank LIMIT ?`;
      params = [query, source, limit];
    } else {
      sql = `SELECT source, label, content, timestamp, rank
             FROM fts_index WHERE fts_index MATCH ?
             ORDER BY rank LIMIT ?`;
      params = [query, limit];
    }

    return db.prepare(sql).all(...params) as Array<{
      source: string;
      label: string;
      content: string;
      timestamp: string;
    }>;
  } catch {
    // FTS5 syntax error — try wrapping in quotes
    try {
      const escaped = `"${query.replace(/"/g, '""')}"`;
      const sql = `SELECT source, label, content, timestamp, rank
                   FROM fts_index WHERE fts_index MATCH ?
                   ORDER BY rank LIMIT ?`;
      return db.prepare(sql).all(escaped, limit) as Array<{
        source: string;
        label: string;
        content: string;
        timestamp: string;
      }>;
    } catch {
      return [];
    }
  }
}

export function closeAll(): void {
  if (_statsDb) {
    _statsDb.close();
    _statsDb = null;
  }
  if (_sessionsDb) {
    _sessionsDb.close();
    _sessionsDb = null;
  }
}
