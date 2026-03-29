import { z } from "zod";
import { getStatsDb, getSessionsDb } from "../lib/db";
import { isFtsEnabled } from "../lib/env";

export const statsSchema = z.object({});

export type StatsInput = z.infer<typeof statsSchema>;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function handleStats(_args: StatsInput) {
  const statsDb = getStatsDb();

  // Execution stats
  const totals = statsDb
    .prepare(
      `SELECT
        COUNT(*) as total_runs,
        COALESCE(SUM(raw_bytes), 0) as total_raw,
        COALESCE(SUM(summary_bytes), 0) as total_summary,
        COALESCE(SUM(raw_bytes - summary_bytes), 0) as total_saved,
        COALESCE(AVG(savings_pct), 0) as avg_savings
      FROM runs`
    )
    .get() as {
    total_runs: number;
    total_raw: number;
    total_summary: number;
    total_saved: number;
    avg_savings: number;
  };

  // Top skills by bytes saved
  const topSkills = statsDb
    .prepare(
      `SELECT skill, COUNT(*) as runs, SUM(raw_bytes - summary_bytes) as bytes_saved
       FROM runs GROUP BY skill ORDER BY bytes_saved DESC LIMIT 10`
    )
    .all() as Array<{ skill: string; runs: number; bytes_saved: number }>;

  // Indexed documents count
  let indexedDocs = 0;
  if (isFtsEnabled()) {
    try {
      const row = statsDb
        .prepare("SELECT COUNT(*) as cnt FROM fts_index")
        .get() as { cnt: number } | undefined;
      indexedDocs = row?.cnt || 0;
    } catch {
      // FTS5 table might not exist
    }
  }

  // Session stats
  let sessionStats: Record<string, unknown> = {
    total_events: 0,
    events_by_priority: {},
    total_event_bytes: 0,
    total_event_bytes_human: "0 B",
    total_snapshots: 0,
  };

  try {
    const sessDb = getSessionsDb();

    const eventCounts = sessDb
      .prepare(
        "SELECT priority, COUNT(*) as cnt FROM events GROUP BY priority"
      )
      .all() as Array<{ priority: string; cnt: number }>;

    const totalEvents = eventCounts.reduce((sum, r) => sum + r.cnt, 0);
    const byPriority: Record<string, number> = {};
    for (const row of eventCounts) {
      byPriority[row.priority] = row.cnt;
    }

    const totalEventBytes = (
      sessDb
        .prepare("SELECT COALESCE(SUM(byte_size), 0) as total FROM events")
        .get() as { total: number }
    ).total;

    const snapshotCount = (
      sessDb.prepare("SELECT COUNT(*) as cnt FROM snapshots").get() as {
        cnt: number;
      }
    ).cnt;

    sessionStats = {
      total_events: totalEvents,
      events_by_priority: byPriority,
      total_event_bytes: totalEventBytes,
      total_event_bytes_human: formatBytes(totalEventBytes),
      total_snapshots: snapshotCount,
    };
  } catch {
    // Sessions DB might not exist yet
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          execution: {
            total_runs: totals.total_runs,
            total_raw_bytes: totals.total_raw,
            total_raw_human: formatBytes(totals.total_raw),
            total_summary_bytes: totals.total_summary,
            total_summary_human: formatBytes(totals.total_summary),
            total_bytes_saved: totals.total_saved,
            total_saved_human: formatBytes(totals.total_saved),
            avg_savings_pct: Math.round(totals.avg_savings * 10) / 10,
            top_skills: topSkills,
            indexed_documents: indexedDocs,
          },
          sessions: sessionStats,
        }),
      },
    ],
  };
}
