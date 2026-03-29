import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { getSessionsDb } from "../lib/db";
import { getContextDir, getSnapshotBudget } from "../lib/env";
import { PRIORITY_CONFIG } from "../types";
import type { Priority } from "../types";

export const sessionSchema = z.object({
  action: z
    .enum(["log", "snapshot", "restore", "stats"])
    .describe("Session action: log an event, create/restore snapshot, or view stats"),
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
});

export type SessionInput = z.infer<typeof sessionSchema>;

function getSessionId(): string {
  const idFile = path.join(getContextDir(), ".session_id");
  if (fs.existsSync(idFile)) {
    return fs.readFileSync(idFile, "utf-8").trim();
  }
  const id = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 15);
  fs.writeFileSync(idFile, id);
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
  };
}

function createSnapshot(): Record<string, unknown> {
  const db = getSessionsDb();
  const sessionId = getSessionId();
  const budget = getSnapshotBudget();

  const events: Record<string, unknown[]> = {};
  let totalBytes = 0;

  // Fill each priority bucket
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
      const entry = {
        t: row.timestamp,
        type: row.event_type,
        d: JSON.parse(row.data),
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
  };
}

function restoreSnapshot(): Record<string, unknown> {
  const db = getSessionsDb();
  const sessionId = getSessionId();

  const row = db
    .prepare(
      `SELECT snapshot, byte_size, timestamp FROM snapshots
       WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`
    )
    .get(sessionId) as
    | { snapshot: string; byte_size: number; timestamp: string }
    | undefined;

  if (!row) {
    return {
      success: false,
      error: "No snapshot found for current session",
      session_id: sessionId,
    };
  }

  return {
    success: true,
    session_id: sessionId,
    snapshot: JSON.parse(row.snapshot),
    byte_size: row.byte_size,
    created: row.timestamp,
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
    events_by_priority: byPriority,
    total_event_bytes: totalBytes,
    snapshots_created: snapshotCount,
    snapshot_budget: getSnapshotBudget(),
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
      result = restoreSnapshot();
      break;
    case "stats":
      result = getStats();
      break;
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
