#!/usr/bin/env python3
"""Display context-saving statistics across all skill executions.

Reads from the stats database to show total bytes saved, number of
calls made, average compression ratio, and session event counts.
"""

import json
import os
import sqlite3
import sys

DATA_DIR = os.environ.get("CONTEXT_COOLER_HOME", os.path.expanduser("~"))
STATS_DB = os.path.join(DATA_DIR, "context/stats.db")
SESSIONS_DB = os.path.join(DATA_DIR, "context/sessions.db")


def get_run_stats():
    """Gather execution statistics from the stats database."""
    stats = {
        "total_runs": 0,
        "total_raw_bytes": 0,
        "total_summary_bytes": 0,
        "total_bytes_saved": 0,
        "avg_savings_pct": 0,
        "top_skills": [],
        "indexed_documents": 0,
    }

    if not os.path.exists(STATS_DB):
        return stats

    conn = sqlite3.connect(STATS_DB)

    try:
        row = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(raw_bytes), 0), COALESCE(SUM(summary_bytes), 0), "
            "COALESCE(AVG(savings_pct), 0) FROM runs"
        ).fetchone()

        stats["total_runs"] = row[0]
        stats["total_raw_bytes"] = row[1]
        stats["total_summary_bytes"] = row[2]
        stats["total_bytes_saved"] = row[1] - row[2]
        stats["avg_savings_pct"] = round(row[3], 1)

        # Top skills by savings
        skill_rows = conn.execute(
            "SELECT skill, COUNT(*) as runs, SUM(raw_bytes - summary_bytes) as saved "
            "FROM runs GROUP BY skill ORDER BY saved DESC LIMIT 5"
        ).fetchall()
        stats["top_skills"] = [
            {"skill": r[0], "runs": r[1], "bytes_saved": r[2]} for r in skill_rows
        ]

        # Count indexed documents
        try:
            idx_count = conn.execute("SELECT COUNT(*) FROM fts_index").fetchone()[0]
            stats["indexed_documents"] = idx_count
        except sqlite3.OperationalError:
            pass

    except sqlite3.OperationalError:
        pass

    conn.close()
    return stats


def get_session_stats():
    """Gather session statistics from the sessions database."""
    stats = {
        "total_events": 0,
        "events_by_priority": {},
        "total_snapshots": 0,
        "total_event_bytes": 0,
    }

    if not os.path.exists(SESSIONS_DB):
        return stats

    conn = sqlite3.connect(SESSIONS_DB)

    try:
        stats["total_events"] = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]

        for row in conn.execute("SELECT priority, COUNT(*) FROM events GROUP BY priority").fetchall():
            stats["events_by_priority"][row[0]] = row[1]

        stats["total_event_bytes"] = conn.execute(
            "SELECT COALESCE(SUM(byte_size), 0) FROM events"
        ).fetchone()[0]

        stats["total_snapshots"] = conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]

    except sqlite3.OperationalError:
        pass

    conn.close()
    return stats


def format_bytes(n):
    """Format bytes into a human-readable string."""
    if n < 1024:
        return f"{n} B"
    elif n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    else:
        return f"{n / (1024 * 1024):.1f} MB"


def main():
    run_stats = get_run_stats()
    session_stats = get_session_stats()

    result = {
        "success": True,
        "execution": {
            "total_runs": run_stats["total_runs"],
            "total_raw_bytes": run_stats["total_raw_bytes"],
            "total_raw_human": format_bytes(run_stats["total_raw_bytes"]),
            "total_summary_bytes": run_stats["total_summary_bytes"],
            "total_summary_human": format_bytes(run_stats["total_summary_bytes"]),
            "total_bytes_saved": run_stats["total_bytes_saved"],
            "total_saved_human": format_bytes(run_stats["total_bytes_saved"]),
            "avg_savings_pct": run_stats["avg_savings_pct"],
            "top_skills": run_stats["top_skills"],
            "indexed_documents": run_stats["indexed_documents"],
        },
        "sessions": {
            "total_events": session_stats["total_events"],
            "events_by_priority": session_stats["events_by_priority"],
            "total_event_bytes": session_stats["total_event_bytes"],
            "total_event_bytes_human": format_bytes(session_stats["total_event_bytes"]),
            "total_snapshots": session_stats["total_snapshots"],
        },
    }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
