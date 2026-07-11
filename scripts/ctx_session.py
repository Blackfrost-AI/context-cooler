#!/usr/bin/env python3
"""Session event tracking with priority-based snapshot generation.

Logs critical events (actions, alerts, decisions) to a SQLite database
with priority levels. Generates compact 2 KB snapshots for conversation
compaction survival. Restores operational context on session resume.
"""

import argparse
import json
import os
import sqlite3
import sys
import time

DATA_DIR = os.environ.get("CONTEXT_COOLER_HOME", os.path.expanduser("~"))
DB_PATH = os.path.join(DATA_DIR, "context/sessions.db")
# v6: default 16KB (was 2KB) so coding-agent continuity fits; clamp 256–65536
SNAPSHOT_BUDGET = max(256, min(int(os.environ.get("CTX_SNAPSHOT_BUDGET", "16384")), 65536))

# Priority levels with budget allocation percentages
PRIORITIES = {
    "critical": {"level": 1, "label": "P1", "budget_pct": 0.40},
    "high": {"level": 2, "label": "P2", "budget_pct": 0.30},
    "medium": {"level": 3, "label": "P3", "budget_pct": 0.20},
    "low": {"level": 4, "label": "P4", "budget_pct": 0.10},
}


def ensure_db():
    """Create sessions database and tables if they don't exist."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'medium',
            priority_level INTEGER NOT NULL DEFAULT 3,
            data TEXT NOT NULL,
            byte_size INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            session_id TEXT NOT NULL,
            snapshot TEXT NOT NULL,
            byte_size INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_events_priority ON events(priority_level)
    """)
    conn.commit()
    return conn


def get_session_id():
    """Generate or retrieve the current session ID.

    v6: prefer CTX_SESSION_ID; migrate legacy trailing-dot sticky ids;
    format is always YYYYMMDD-HHMMSS (no fractional-second dot).
    """
    env_id = os.environ.get("CTX_SESSION_ID", "").strip()
    if env_id:
        return env_id

    session_file = os.path.join(DATA_DIR, "context/.session_id")
    if os.path.exists(session_file):
        with open(session_file, "r") as f:
            sid = f.read().strip()
        if sid.endswith("."):
            sid = sid.rstrip(".")
            if "-" not in sid and len(sid) >= 14:
                sid = f"{sid[:8]}-{sid[8:]}"
            if not sid:
                sid = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
            with open(session_file, "w") as f:
                f.write(sid)
        if sid:
            return sid
    session_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    os.makedirs(os.path.dirname(session_file), exist_ok=True)
    with open(session_file, "w") as f:
        f.write(session_id)
    return session_id


def cmd_log(args):
    """Log a session event."""
    conn = ensure_db()
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    session_id = get_session_id()

    priority = args.priority.lower()
    if priority not in PRIORITIES:
        print(json.dumps({"success": False, "error": f"Invalid priority: {priority}. Use: critical, high, medium, low"}))
        sys.exit(1)

    data_str = args.data or "{}"
    try:
        # Validate JSON
        json.loads(data_str)
    except json.JSONDecodeError:
        # Wrap non-JSON data
        data_str = json.dumps({"raw": data_str})

    byte_size = len(data_str.encode("utf-8"))
    priority_info = PRIORITIES[priority]

    conn.execute(
        "INSERT INTO events (timestamp, session_id, event_type, priority, priority_level, data, byte_size) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (timestamp, session_id, args.type, priority, priority_info["level"], data_str, byte_size),
    )
    conn.commit()

    result = {
        "success": True,
        "event_id": conn.execute("SELECT last_insert_rowid()").fetchone()[0],
        "session_id": session_id,
        "type": args.type,
        "priority": f"{priority_info['label']} ({priority})",
        "timestamp": timestamp,
        "byte_size": byte_size,
    }
    print(json.dumps(result))
    conn.close()


def cmd_snapshot(args):
    """Build a compaction snapshot from session events."""
    conn = ensure_db()
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    session_id = get_session_id()

    snapshot_parts = {
        "session_id": session_id,
        "snapshot_time": timestamp,
        "events": {},
    }

    # Allocate budget across priority levels
    for priority_name, info in PRIORITIES.items():
        budget = int(SNAPSHOT_BUDGET * info["budget_pct"])
        rows = conn.execute(
            "SELECT timestamp, event_type, data FROM events "
            "WHERE session_id = ? AND priority = ? "
            "ORDER BY timestamp DESC",
            (session_id, priority_name),
        ).fetchall()

        events = []
        used = 0
        for ts, etype, data in rows:
            entry = {"t": ts, "type": etype}
            try:
                parsed = json.loads(data)
                entry["d"] = parsed
            except json.JSONDecodeError:
                entry["d"] = data

            entry_str = json.dumps(entry, separators=(",", ":"))
            entry_size = len(entry_str.encode("utf-8"))
            if used + entry_size <= budget:
                events.append(entry)
                used += entry_size
            else:
                break

        if events:
            snapshot_parts["events"][info["label"]] = events

    snapshot_str = json.dumps(snapshot_parts, separators=(",", ":"))
    byte_size = len(snapshot_str.encode("utf-8"))

    # Store snapshot
    conn.execute(
        "INSERT INTO snapshots (timestamp, session_id, snapshot, byte_size) VALUES (?, ?, ?, ?)",
        (timestamp, session_id, snapshot_str, byte_size),
    )
    conn.commit()

    result = {
        "success": True,
        "session_id": session_id,
        "snapshot_bytes": byte_size,
        "budget_bytes": SNAPSHOT_BUDGET,
        "budget_used_pct": round(byte_size / SNAPSHOT_BUDGET * 100, 1),
        "events_included": sum(len(v) for v in snapshot_parts["events"].values()),
        "snapshot": snapshot_parts,
    }
    print(json.dumps(result))
    conn.close()


def cmd_restore(args):
    """Restore the most recent snapshot (current session, then any session)."""
    conn = ensure_db()
    session_id = get_session_id()

    row = conn.execute(
        "SELECT timestamp, snapshot, byte_size, session_id FROM snapshots "
        "WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    fallback = False

    if not row:
        # v6: fall back to latest snapshot across all sessions
        row = conn.execute(
            "SELECT timestamp, snapshot, byte_size, session_id FROM snapshots "
            "ORDER BY timestamp DESC LIMIT 1",
        ).fetchone()
        fallback = bool(row)

    if not row:
        print(json.dumps({
            "success": False,
            "error": "No snapshot found. Log events and call snapshot before compact.",
            "session_id": session_id,
        }))
        conn.close()
        sys.exit(1)

    ts, snapshot_str, byte_size, restored_sid = row
    try:
        snapshot = json.loads(snapshot_str)
    except json.JSONDecodeError:
        snapshot = {"raw": snapshot_str}

    result = {
        "success": True,
        "session_id": session_id,
        "restored_from_session": restored_sid,
        "fallback": fallback,
        "snapshot_time": ts,
        "snapshot_bytes": byte_size,
        "snapshot": snapshot,
    }
    print(json.dumps(result))
    conn.close()


def cmd_recent(args):
    """List recent session events (current session, else cross-session)."""
    conn = ensure_db()
    session_id = get_session_id()
    limit = getattr(args, "limit", 10) or 10

    rows = conn.execute(
        "SELECT timestamp, session_id, event_type, priority, data FROM events "
        "WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?",
        (session_id, limit),
    ).fetchall()
    cross = False
    if not rows:
        rows = conn.execute(
            "SELECT timestamp, session_id, event_type, priority, data FROM events "
            "ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        ).fetchall()
        cross = bool(rows)

    events = []
    for ts, sid, etype, prio, data in rows:
        try:
            d = json.loads(data)
        except json.JSONDecodeError:
            d = data
        events.append({"t": ts, "session_id": sid, "type": etype, "priority": prio, "d": d})

    print(json.dumps({
        "success": True,
        "session_id": session_id,
        "cross_session": cross,
        "count": len(events),
        "events": events,
    }))
    conn.close()


def cmd_new(args):
    """Rotate to a fresh session id."""
    session_file = os.path.join(DATA_DIR, "context/.session_id")
    session_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    os.makedirs(os.path.dirname(session_file), exist_ok=True)
    with open(session_file, "w") as f:
        f.write(session_id)
    print(json.dumps({"success": True, "session_id": session_id}))


def cmd_stats(args):
    """Show session statistics."""
    conn = ensure_db()
    session_id = get_session_id()

    total_events = conn.execute(
        "SELECT COUNT(*) FROM events WHERE session_id = ?", (session_id,)
    ).fetchone()[0]

    events_by_priority = {}
    for row in conn.execute(
        "SELECT priority, COUNT(*) FROM events WHERE session_id = ? GROUP BY priority",
        (session_id,),
    ).fetchall():
        events_by_priority[row[0]] = row[1]

    total_bytes = conn.execute(
        "SELECT COALESCE(SUM(byte_size), 0) FROM events WHERE session_id = ?",
        (session_id,),
    ).fetchone()[0]

    snapshot_count = conn.execute(
        "SELECT COUNT(*) FROM snapshots WHERE session_id = ?", (session_id,)
    ).fetchone()[0]

    last_snapshot = conn.execute(
        "SELECT timestamp, byte_size FROM snapshots WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1",
        (session_id,),
    ).fetchone()

    result = {
        "success": True,
        "session_id": session_id,
        "total_events": total_events,
        "events_by_priority": events_by_priority,
        "total_event_bytes": total_bytes,
        "snapshots_created": snapshot_count,
        "last_snapshot": {
            "timestamp": last_snapshot[0],
            "byte_size": last_snapshot[1],
        } if last_snapshot else None,
        "snapshot_budget": SNAPSHOT_BUDGET,
    }
    print(json.dumps(result))
    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Session event tracking with priority-based snapshot generation.",
    )
    subparsers = parser.add_subparsers(dest="action", help="Action to perform")

    # log subcommand
    log_parser = subparsers.add_parser("log", help="Log a session event")
    log_parser.add_argument("--type", required=True, help="Event type (e.g., action, alert, decision)")
    log_parser.add_argument(
        "--priority",
        default="medium",
        choices=["critical", "high", "medium", "low"],
        help="Event priority level (default: medium)",
    )
    log_parser.add_argument("--data", help="JSON data for the event")

    # snapshot subcommand
    subparsers.add_parser("snapshot", help="Build a compaction snapshot")

    # restore subcommand
    subparsers.add_parser("restore", help="Restore the most recent snapshot (falls back across sessions)")

    # stats subcommand
    subparsers.add_parser("stats", help="Show session statistics")

    # recent subcommand
    recent_parser = subparsers.add_parser("recent", help="List recent session events")
    recent_parser.add_argument("--limit", type=int, default=10, help="Max events (default 10)")

    # new subcommand
    subparsers.add_parser("new", help="Rotate to a fresh session id")

    args = parser.parse_args()

    if not args.action:
        parser.print_help()
        sys.exit(1)

    actions = {
        "log": cmd_log,
        "snapshot": cmd_snapshot,
        "restore": cmd_restore,
        "stats": cmd_stats,
        "recent": cmd_recent,
        "new": cmd_new,
    }
    actions[args.action](args)


if __name__ == "__main__":
    main()
