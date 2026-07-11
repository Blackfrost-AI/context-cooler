import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { getSessionsDb } from "../lib/db";
import { getContextDir, getDataDir, getSnapshotBudget } from "../lib/env";
import { PRIORITY_CONFIG } from "../types";
import type { Priority } from "../types";

export const sessionSchema = z.object({
  action: z
    .enum(["log", "snapshot", "restore", "stats", "recent", "new"])
    .describe(
      "Session action: log an event, create/restore snapshot, view stats, list recent events, or start a new session id"
    ),
  event_type: z
    .string()
    .optional()
    .describe("Event type for 'log' action (e.g., 'deploy', 'alert', 'decision')"),
  priority: z
    .enum(["critical", "high", "medium", "low"])
    .default("medium")
    .describe("Event priority for 'log' action"),
  data: z
    .string()
    .optional()
    .describe("JSON data payload for 'log' action"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Max events for 'recent' action"),
  session_id: z
    .string()
    .optional()
    .describe("Optional session id override for restore/recent (default: current)"),
});

export type SessionInput = z.infer<typeof sessionSchema>;

function sessionIdPath(): string {
  return path.join(getContextDir(), ".session_id");
}

/**
 * Build a clean session id: YYYYMMDD-HHMMSS (UTC).
 * v6 fix: the previous ISO slice left a trailing '.' from fractional seconds
 * ("20260711155340.") which poisoned restore lookups forever.
 */
export function generateSessionId(date: Date = new Date()): string {
  const iso = date.toISOString(); // 2026-07-11T15:53:40.731Z
  const d = iso.slice(0, 10).replace(/-/g, "");
  const t = iso.slice(11, 19).replace(/:/g, "");
  return `${d}-${t}`;
}

/**
 * Resolve the active session id.
 * Priority: CTX_SESSION_ID env (host conversation id) → sticky file → generate.
 * If the sticky file holds a legacy trailing-dot id, migrate it in place.
 */
export function getSessionId(): string {
  const fromEnv = process.env.CTX_SESSION_ID?.trim();
  if (fromEnv) return fromEnv;

  const idFile = sessionIdPath();
  if (fs.existsSync(idFile)) {
    let id = fs.readFileSync(idFile, "utf-8").trim();
    // migrate broken trailing-dot ids written by the pre-v6 generator
    if (id.endsWith(".")) {
      id = id.replace(/\.+$/, "");
      if (!id.includes("-") && id.length >= 14) {
        // 20260703201901 → 20260703-201901
        id = `${id.slice(0, 8)}-${id.slice(8)}`;
      }
      if (!id) id = generateSessionId();
      fs.writeFileSync(idFile, id);
    }
    if (id) return id;
  }
  const id = generateSessionId();
  fs.writeFileSync(idFile, id);
  return id;
}

/** Force a new session id (for action=new). Returns the new id. */
export function rotateSessionId(): string {
  const id = generateSessionId();
  fs.writeFileSync(sessionIdPath(), id);
  return id;
}

function logEvent(
  eventType: string,
  priority: Priority,
  data: unknown
): Record<string, unknown> {
  const db = getSessionsDb();
  const sessionId = getSessionId();
  const config = PRIORITY_CONFIG[priority];
  const dataStr = typeof data === "string" ? data : JSON.stringify(data ?? {});
  const byteSize = Buffer.byteLength(dataStr, "utf-8");

  db.prepare(`
    INSERT INTO events (timestamp, session_id, event_type, priority, priority_level, data, byte_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    sessionId,
    eventType,
    priority,
    config.level,
    dataStr,
    byteSize
  );

  return {
    success: true,
    session_id: sessionId,
    event_type: eventType,
    priority: `${config.label} (${priority})`,
    byte_size: byteSize,
    data_dir: getDataDir(),
  };
}

/**
 * Programmatic log used by ctx_execute auto-log. Swallows errors so a session
 * DB glitch never fails an execute call.
 */
export function tryAutoLogEvent(
  eventType: string,
  priority: Priority,
  data: unknown
): void {
  try {
    logEvent(eventType, priority, data);
  } catch {
    // non-fatal
  }
}

function createSnapshot(): Record<string, unknown> {
  const db = getSessionsDb();
  const sessionId = getSessionId();
  const budget = getSnapshotBudget();

  const events: Record<string, unknown[]> = {};
  let totalBytes = 0;

  for (const [priority, config] of Object.entries(PRIORITY_CONFIG)) {
    const bucketBudget = Math.floor(budget * config.budget_pct);
    let bucketBytes = 0;
    const bucketEvents: unknown[] = [];

    const rows = db
      .prepare(
        `SELECT timestamp, event_type, data FROM events
         WHERE session_id = ? AND priority = ?
         ORDER BY timestamp DESC`
      )
      .all(sessionId, priority) as Array<{
      timestamp: string;
      event_type: string;
      data: string;
    }>;

    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        parsed = row.data;
      }
      const entry = {
        t: row.timestamp,
        type: row.event_type,
        d: parsed,
      };
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf-8");

      if (bucketBytes + entryBytes > bucketBudget) break;

      bucketEvents.push(entry);
      bucketBytes += entryBytes;
    }

    if (bucketEvents.length > 0) {
      events[config.label] = bucketEvents;
    }
    totalBytes += bucketBytes;
  }

  const snapshot = {
    session_id: sessionId,
    snapshot_time: new Date().toISOString(),
    events,
  };

  const snapshotStr = JSON.stringify(snapshot);
  const snapshotBytes = Buffer.byteLength(snapshotStr, "utf-8");

  db.prepare(`
    INSERT INTO snapshots (timestamp, session_id, snapshot, byte_size)
    VALUES (?, ?, ?, ?)
  `).run(new Date().toISOString(), sessionId, snapshotStr, snapshotBytes);

  return {
    success: true,
    session_id: sessionId,
    snapshot_bytes: snapshotBytes,
    budget_bytes: budget,
    events_included: Object.values(events).reduce(
      (sum, arr) => sum + (arr as unknown[]).length,
      0
    ),
    data_dir: getDataDir(),
  };
}

function restoreSnapshot(preferredSessionId?: string): Record<string, unknown> {
  const db = getSessionsDb();
  const sessionId = preferredSessionId || getSessionId();

  // 1) Prefer snapshot for the requested/current session
  let row = db
    .prepare(
      `SELECT snapshot, byte_size, timestamp, session_id FROM snapshots
       WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`
    )
    .get(sessionId) as
    | { snapshot: string; byte_size: number; timestamp: string; session_id: string }
    | undefined;

  let fallback = false;

  // 2) v6: fall back to the latest snapshot on any session — sticky/broken
  //    session ids previously made restore permanently empty.
  if (!row) {
    row = db
      .prepare(
        `SELECT snapshot, byte_size, timestamp, session_id FROM snapshots
         ORDER BY timestamp DESC LIMIT 1`
      )
      .get() as
      | { snapshot: string; byte_size: number; timestamp: string; session_id: string }
      | undefined;
    fallback = !!row;
  }

  if (!row) {
    // 3) No snapshots at all — synthesize a "soft restore" from recent events
    const recent = listRecent(15, undefined);
    if ((recent.events as unknown[]).length > 0) {
      return {
        success: true,
        session_id: sessionId,
        source: "recent_events",
        snapshot: {
          session_id: sessionId,
          snapshot_time: new Date().toISOString(),
          events: { recent: recent.events },
        },
        data_dir: getDataDir(),
        note: "No snapshots found; returned recent events instead. Call action=snapshot before compact next time.",
      };
    }
    return {
      success: false,
      error: "No snapshot or events found. Log events (or enable CTX_AUTO_LOG) and call snapshot before compact.",
      session_id: sessionId,
      data_dir: getDataDir(),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshot);
  } catch {
    parsed = { raw: row.snapshot };
  }

  return {
    success: true,
    session_id: sessionId,
    restored_from_session: row.session_id,
    fallback,
    snapshot: parsed,
    byte_size: row.byte_size,
    created: row.timestamp,
    data_dir: getDataDir(),
  };
}

function listRecent(limit: number, sessionId?: string): Record<string, unknown> {
  const db = getSessionsDb();
  const sid = sessionId || getSessionId();

  let rows = db
    .prepare(
      `SELECT timestamp, session_id, event_type, priority, data, byte_size
       FROM events WHERE session_id = ?
       ORDER BY timestamp DESC LIMIT ?`
    )
    .all(sid, limit) as Array<{
    timestamp: string;
    session_id: string;
    event_type: string;
    priority: string;
    data: string;
    byte_size: number;
  }>;

  // If this session is empty, show latest across all sessions
  let crossSession = false;
  if (rows.length === 0) {
    rows = db
      .prepare(
        `SELECT timestamp, session_id, event_type, priority, data, byte_size
         FROM events ORDER BY timestamp DESC LIMIT ?`
      )
      .all(limit) as typeof rows;
    crossSession = rows.length > 0;
  }

  const events = rows.map((r) => {
    let d: unknown;
    try {
      d = JSON.parse(r.data);
    } catch {
      d = r.data;
    }
    return {
      t: r.timestamp,
      session_id: r.session_id,
      type: r.event_type,
      priority: r.priority,
      d,
    };
  });

  return {
    success: true,
    session_id: sid,
    cross_session: crossSession,
    count: events.length,
    events,
    data_dir: getDataDir(),
  };
}

function getStats(): Record<string, unknown> {
  const db = getSessionsDb();
  const sessionId = getSessionId();

  const eventCounts = db
    .prepare(
      `SELECT priority, COUNT(*) as cnt FROM events
       WHERE session_id = ? GROUP BY priority`
    )
    .all(sessionId) as Array<{ priority: string; cnt: number }>;

  const totalEvents = eventCounts.reduce((sum, r) => sum + r.cnt, 0);
  const byPriority: Record<string, number> = {};
  for (const row of eventCounts) {
    byPriority[row.priority] = row.cnt;
  }

  const allEvents = (
    db.prepare(`SELECT COUNT(*) as cnt FROM events`).get() as { cnt: number }
  ).cnt;

  const totalBytes = (
    db
      .prepare(
        `SELECT COALESCE(SUM(byte_size), 0) as total FROM events WHERE session_id = ?`
      )
      .get(sessionId) as { total: number }
  ).total;

  const snapshotCount = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM snapshots WHERE session_id = ?`
      )
      .get(sessionId) as { cnt: number }
  ).cnt;

  const lastSnapshot = db
    .prepare(
      `SELECT timestamp, byte_size FROM snapshots
       WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`
    )
    .get(sessionId) as
    | { timestamp: string; byte_size: number }
    | undefined;

  return {
    success: true,
    session_id: sessionId,
    total_events: totalEvents,
    all_sessions_events: allEvents,
    events_by_priority: byPriority,
    total_event_bytes: totalBytes,
    snapshots_created: snapshotCount,
    snapshot_budget: getSnapshotBudget(),
    data_dir: getDataDir(),
    ...(lastSnapshot
      ? {
          last_snapshot: {
            timestamp: lastSnapshot.timestamp,
            byte_size: lastSnapshot.byte_size,
          },
        }
      : {}),
  };
}

export async function handleSession(args: SessionInput) {
  let result: Record<string, unknown>;

  switch (args.action) {
    case "log":
      if (!args.event_type) {
        result = { success: false, error: "event_type is required for 'log' action" };
      } else {
        result = logEvent(
          args.event_type,
          args.priority as Priority,
          args.data ?? "{}"
        );
      }
      break;
    case "snapshot":
      result = createSnapshot();
      break;
    case "restore":
      result = restoreSnapshot(args.session_id);
      break;
    case "stats":
      result = getStats();
      break;
    case "recent":
      result = listRecent(args.limit ?? 10, args.session_id);
      break;
    case "new": {
      const id = rotateSessionId();
      result = {
        success: true,
        session_id: id,
        message: "New session id written. Prior events remain queryable via action=recent (cross-session) or restore fallback.",
        data_dir: getDataDir(),
      };
      break;
    }
    default:
      result = { success: false, error: `Unknown action: ${args.action}` };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result),
      },
    ],
  };
}
