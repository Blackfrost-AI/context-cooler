#!/usr/bin/env python3
"""Full-text search across indexed skill outputs.

Queries the FTS5 index built by ctx_run.py to retrieve previously
captured skill outputs without re-executing commands. Returns
matching results ranked by relevance.
"""

import argparse
import json
import os
import sqlite3
import sys

DATA_DIR = os.environ.get("CONTEXT_COOLER_HOME", os.path.expanduser("~"))
DB_PATH = os.path.join(DATA_DIR, "context/stats.db")


def search(query, source=None, limit=10):
    """Search the FTS5 index for matching content."""
    if not os.path.exists(DB_PATH):
        return {"success": False, "error": "No index database found. Run ctx_run.py first to index data."}

    conn = sqlite3.connect(DB_PATH)

    # Check if FTS table exists
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index'"
    ).fetchone()
    if not tables:
        conn.close()
        return {"success": False, "error": "FTS index table not found. Run ctx_run.py first."}

    try:
        if source:
            if source == "last-run":
                rows = conn.execute(
                    "SELECT skill, command, content, timestamp FROM fts_index "
                    "WHERE fts_index MATCH ? "
                    "ORDER BY rank LIMIT ?",
                    (query, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT skill, command, content, timestamp FROM fts_index "
                    "WHERE fts_index MATCH ? AND skill = ? "
                    "ORDER BY rank LIMIT ?",
                    (query, source, limit),
                ).fetchall()
        else:
            rows = conn.execute(
                "SELECT skill, command, content, timestamp FROM fts_index "
                "WHERE fts_index MATCH ? "
                "ORDER BY rank LIMIT ?",
                (query, limit),
            ).fetchall()
    except sqlite3.OperationalError as e:
        conn.close()
        # FTS5 query syntax error -- try escaping
        escaped_query = '"' + query.replace('"', '""') + '"'
        conn = sqlite3.connect(DB_PATH)
        try:
            rows = conn.execute(
                "SELECT skill, command, content, timestamp FROM fts_index "
                "WHERE fts_index MATCH ? "
                "ORDER BY rank LIMIT ?",
                (escaped_query, limit),
            ).fetchall()
        except sqlite3.OperationalError as e2:
            conn.close()
            return {"success": False, "error": f"Search query error: {e2}"}

    results = []
    for skill, command, content, timestamp in rows:
        # Try to parse content as JSON for cleaner output
        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            parsed = content

        # Truncate large results
        content_str = json.dumps(parsed) if isinstance(parsed, (dict, list)) else str(parsed)
        if len(content_str) > 1000:
            content_str = content_str[:1000] + "... (truncated)"
            parsed = content_str

        results.append({
            "skill": skill,
            "command": command,
            "timestamp": timestamp,
            "content": parsed,
        })

    conn.close()

    return {
        "success": True,
        "query": query,
        "source": source,
        "results_count": len(results),
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Search indexed skill outputs using full-text search.",
        epilog="Example: ctx_search.py 'error rate spike' --source my-api",
    )
    parser.add_argument("query", help="Search query (supports FTS5 syntax)")
    parser.add_argument("--source", help="Filter by skill name or 'last-run'")
    parser.add_argument("--limit", type=int, default=10, help="Maximum results to return (default: 10)")
    args = parser.parse_args()

    result = search(args.query, args.source, args.limit)
    print(json.dumps(result))

    if not result["success"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
