#!/usr/bin/env python3
"""Sandboxed skill execution with intent filtering and FTS5 indexing.

Runs an OpenClaw skill command in a subprocess, captures the full output,
applies intent-driven filtering or field selection, indexes the result in
SQLite FTS5, and returns a compact summary to stdout.

The full output never enters the context window. Use ctx_search.py to
query indexed data on demand.
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

OPENCLAW_HOME = os.environ.get("OPENCLAW_HOME", os.path.expanduser("~/.openclaw"))
SKILLS_DIR = os.path.join(OPENCLAW_HOME, "workspace/skills")
ENV_FILE = os.path.join(OPENCLAW_HOME, ".env")
DB_PATH = os.path.join(OPENCLAW_HOME, "context/stats.db")


def ensure_db():
    """Create stats database and tables if they don't exist."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
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
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_index USING fts5(
            skill, command, content, timestamp
        )
    """)
    conn.commit()
    return conn


def load_env():
    """Load environment variables from .env file."""
    env = os.environ.copy()
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env[key.strip()] = value.strip().strip("\"'")
    return env


def find_skill_script(skill_name):
    """Locate the main CLI script for a skill.

    Priority order:
    1. <skill_name>_cli.py (explicit CLI entry point)
    2. cli.py
    3. main.py
    4. <skill_name>.py (underscore-normalized)
    5. First alphabetical .py file as fallback
    """
    skill_dir = os.path.join(SKILLS_DIR, skill_name)
    if not os.path.isdir(skill_dir):
        return None
    scripts_dir = os.path.join(skill_dir, "scripts")
    if not os.path.isdir(scripts_dir):
        return None

    normalized = skill_name.replace("-", "_")
    candidates = [
        f"{normalized}_cli.py",
        "cli.py",
        "main.py",
        f"{normalized}.py",
    ]

    # Try priority candidates first
    for candidate in candidates:
        path = os.path.join(scripts_dir, candidate)
        if os.path.isfile(path):
            return path

    # Fallback: first .py file alphabetically (excluding private files)
    py_files = sorted(f for f in os.listdir(scripts_dir)
                      if f.endswith(".py") and not f.startswith("_"))
    if py_files:
        return os.path.join(scripts_dir, py_files[0])
    return None


def _sanitize_skill_name(name):
    """Validate skill name to prevent path traversal.

    Only allows alphanumeric characters, hyphens, and underscores.
    Blocks: .., /, backslash, null bytes, and any other path manipulation.
    """
    import re
    if not re.match(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$', name):
        raise ValueError(f"Invalid skill name: {name!r} (only alphanumeric, hyphens, underscores)")
    if '..' in name or '/' in name or '\\' in name:
        raise ValueError(f"Path traversal blocked in skill name: {name!r}")
    return name


def run_skill(skill_name, command, env):
    """Execute a skill command in a subprocess and capture output."""
    # SECURITY: Validate skill name to prevent path traversal
    skill_name = _sanitize_skill_name(skill_name)

    script = find_skill_script(skill_name)
    if not script:
        return None, f"Skill not found: {skill_name}"

    # SECURITY: Use list-based subprocess (no shell=True) to prevent command injection.
    # The command string is split into arguments safely via shlex.
    import shlex
    cmd_parts = shlex.split(command)

    # Always request verbose output from skills so ctx_run can apply its own
    # intent filtering against the full data. Skills that default to compact
    # output would otherwise pre-compress the data, making ctx_run's filtering
    # redundant and understating the true savings.
    if "--verbose" not in cmd_parts and "--raw" not in cmd_parts:
        cmd_parts = ["--verbose"] + cmd_parts

    cmd_args = ["python3", script] + cmd_parts
    try:
        result = subprocess.run(
            cmd_args,
            shell=False,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
            cwd=os.path.join(SKILLS_DIR, skill_name),
        )
        if result.returncode != 0:
            return None, result.stderr.strip() or f"Command exited with code {result.returncode}"
        return result.stdout.strip(), None
    except subprocess.TimeoutExpired:
        return None, "Command timed out after 30 seconds"
    except Exception as e:
        return None, str(e)


def filter_by_fields(data, fields):
    """Extract only specified fields from a JSON object."""
    if isinstance(data, dict):
        return {k: v for k, v in data.items() if k in fields}
    if isinstance(data, list):
        return [filter_by_fields(item, fields) for item in data]
    return data


def filter_by_intent(data, intent):
    """Apply intent-driven filtering to extract relevant data.

    Uses keyword matching against JSON keys and values. Deliberately
    simple -- no ML, no embeddings, just fast keyword matching.
    """
    intent_lower = intent.lower()
    keywords = intent_lower.split()

    # Extract count from intent (e.g. "top 5")
    limit = 5
    for kw in keywords:
        try:
            limit = int(kw)
            break
        except ValueError:
            pass

    # --- List: score and filter items ---
    if isinstance(data, list):
        return _filter_list_by_intent(data, intent_lower, keywords, limit)

    # --- Dict: check if it's a wrapper around a list (e.g. {"count":8,"positions":[...]}) ---
    if isinstance(data, dict):
        # Look for a nested list value — common API wrapper pattern
        nested_list = None
        nested_key = None
        scalar_fields = {}
        for key, value in data.items():
            if isinstance(value, list) and nested_list is None:
                nested_list = value
                nested_key = key
            elif not isinstance(value, (dict, list)):
                scalar_fields[key] = value

        if nested_list is not None:
            # Recurse into the nested list with the same intent
            filtered_list = _filter_list_by_intent(nested_list, intent_lower, keywords, limit)
            # Return compact wrapper: scalar fields + filtered list
            result = dict(scalar_fields)
            result[nested_key] = filtered_list
            return result

        # No nested list — score dict keys directly
        scored = {}
        for key, value in data.items():
            score = 0
            key_lower = key.lower()
            val_str = str(value).lower()
            for kw in keywords:
                if kw in key_lower:
                    score += 2
                if kw in val_str:
                    score += 1
            if score > 0:
                scored[key] = (value, score)

        if scored:
            sorted_fields = sorted(scored.items(), key=lambda x: x[1][1], reverse=True)
            return {k: v[0] for k, v in sorted_fields[:10]}
        # Fallback: scalars only (no giant nested objects)
        scalars = {k: v for k, v in data.items() if not isinstance(v, (dict, list))}
        return scalars if scalars else {k: v for i, (k, v) in enumerate(data.items()) if i < 5}

    return data


def _filter_list_by_intent(items, intent_lower, keywords, limit):
    """Score and filter a list of items by intent keywords."""
    # "summary" intent: return compact per-item dicts (key scalars only)
    if "summary" in intent_lower or "brief" in intent_lower:
        summary_keys = ("symbol", "s", "qty", "unrealized_pl", "unrealized_plpc",
                        "current_price", "price", "market_value", "side", "name",
                        "pnl", "change", "chg", "change_pct", "percent_change")
        result = []
        for item in items:
            if isinstance(item, dict):
                compact = {k: v for k, v in item.items()
                           if k in summary_keys and not isinstance(v, (dict, list))}
                if compact:
                    result.append(compact)
            else:
                result.append(item)
        return result[:limit]

    scored_items = []
    for item in items:
        score = 0
        item_str = json.dumps(item).lower()
        for kw in keywords:
            if kw in item_str:
                score += 1
        # Special handling for common intents
        if isinstance(item, dict):
            if "losing" in intent_lower or "loss" in intent_lower:
                for k in ("unrealized_pl", "pnl", "profit_loss", "pl"):
                    if k in item:
                        try:
                            if float(item[k]) < 0:
                                score += 5
                        except (ValueError, TypeError):
                            pass
            if "top" in intent_lower or "best" in intent_lower:
                for k in ("change_pct", "percent_change", "change"):
                    if k in item:
                        try:
                            score += abs(float(item[k]))
                        except (ValueError, TypeError):
                            pass
        scored_items.append((item, score))

    scored_items.sort(key=lambda x: x[1], reverse=True)
    return [item for item, score in scored_items[:limit] if score > 0] or \
           [item for item, _ in scored_items[:limit]]


def _redact_secrets(text):
    """Redact potential secrets/API keys from text before indexing.

    Matches common secret patterns: API keys, tokens, passwords, etc.
    This prevents sensitive data from leaking into the FTS5 index.
    """
    import re
    patterns = [
        # API keys / tokens (long alphanumeric strings that look like keys)
        (r'(?i)(api[_-]?key|secret[_-]?key|access[_-]?token|bearer|password|auth[_-]?token)'
         r'[\s:=]+["\']?([A-Za-z0-9_\-/.+]{20,})["\']?', r'\1=***REDACTED***'),
        # Generic long base64-ish strings (likely tokens) in JSON values
        (r'"([^"]{0,30}(?:key|secret|token|password|credential)[^"]{0,10})"'
         r'\s*:\s*"([^"]{20,})"', r'"\1":"***REDACTED***"'),
        # PK-prefixed keys (Alpaca, Stripe, etc.)
        (r'(?:PK|SK|pk|sk)[A-Za-z0-9]{16,}', '***REDACTED***'),
        # Bearer tokens in raw output
        (r'Bearer\s+[A-Za-z0-9_\-/.+]{20,}', 'Bearer ***REDACTED***'),
    ]
    result = text
    for pattern, replacement in patterns:
        result = re.sub(pattern, replacement, result)
    return result


MAX_INDEX_CONTENT = 100_000  # 100 KB per entry
MAX_INDEX_ROWS = 10_000  # Prune oldest entries beyond this


def index_output(conn, skill, command, content, timestamp):
    """Index the full output in FTS5 for later search.

    Content is redacted for secrets and truncated before indexing.
    Old entries are pruned to prevent unbounded database growth.
    """
    try:
        safe_content = _redact_secrets(content)
        if len(safe_content) > MAX_INDEX_CONTENT:
            safe_content = safe_content[:MAX_INDEX_CONTENT] + "\n[TRUNCATED]"
        conn.execute(
            "INSERT INTO fts_index (skill, command, content, timestamp) VALUES (?, ?, ?, ?)",
            (skill, command, safe_content, timestamp),
        )
        # Prune old entries to prevent unbounded growth
        conn.execute(
            "DELETE FROM fts_index WHERE rowid IN "
            "(SELECT rowid FROM fts_index ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
            (MAX_INDEX_ROWS,),
        )
        conn.commit()
    except Exception as e:
        print(f"Warning: FTS indexing failed: {e}", file=sys.stderr)


def record_stats(conn, skill, command, intent, raw_bytes, summary_bytes, timestamp):
    """Record execution stats."""
    savings = ((raw_bytes - summary_bytes) / raw_bytes * 100) if raw_bytes > 0 else 0
    conn.execute(
        "INSERT INTO runs (timestamp, skill, command, intent, raw_bytes, summary_bytes, savings_pct) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (timestamp, skill, command, intent, raw_bytes, summary_bytes, savings),
    )
    conn.commit()
    return savings


def main():
    parser = argparse.ArgumentParser(
        description="Run an OpenClaw skill command in a sandbox with automatic summarization.",
        epilog="Example: ctx_run.py --skill my-api --cmd 'dashboard' --intent 'check error rate'",
    )
    parser.add_argument("--skill", required=True, help="Name of the skill to execute")
    parser.add_argument("--cmd", required=True, help="Command to pass to the skill script")
    parser.add_argument("--intent", help="Intent string for filtering (e.g., 'find failing items')")
    parser.add_argument("--fields", help="Comma-separated list of fields to extract")
    parser.add_argument("--raw", action="store_true", help="Return full output without filtering")
    args = parser.parse_args()

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    env = load_env()
    conn = ensure_db()

    try:
        raw_output, error = run_skill(args.skill, args.cmd, env)
        if error:
            result = {"success": False, "error": error, "skill": args.skill, "command": args.cmd}
            print(json.dumps(result))
            sys.exit(1)

        raw_bytes = len(raw_output.encode("utf-8"))

        # Index full output
        index_output(conn, args.skill, args.cmd, raw_output, timestamp)

        if args.raw:
            print(raw_output)
            record_stats(conn, args.skill, args.cmd, args.intent, raw_bytes, raw_bytes, timestamp)
            return

        # Parse and filter
        try:
            data = json.loads(raw_output)
        except json.JSONDecodeError:
            # Non-JSON output: return as-is but truncated
            summary = raw_output[:500]
            summary_bytes = len(summary.encode("utf-8"))
            savings = record_stats(conn, args.skill, args.cmd, args.intent, raw_bytes, summary_bytes, timestamp)
            result = {
                "success": True,
                "summary": summary,
                "bytes_saved": raw_bytes - summary_bytes,
                "savings_pct": round(savings, 1),
            }
            print(json.dumps(result))
            return

        # Apply filtering
        if args.fields:
            fields = [f.strip() for f in args.fields.split(",")]
            filtered = filter_by_fields(data, fields)
        elif args.intent:
            filtered = filter_by_intent(data, args.intent)
        else:
            # Default: extract top-level keys with scalar values
            if isinstance(data, dict):
                filtered = {k: v for k, v in data.items() if not isinstance(v, (dict, list))}
                if not filtered:
                    filtered = {k: v for i, (k, v) in enumerate(data.items()) if i < 5}
            elif isinstance(data, list):
                filtered = data[:5]
            else:
                filtered = data

        summary = json.dumps(filtered, separators=(",", ":"))
        summary_bytes = len(summary.encode("utf-8"))
        savings = record_stats(conn, args.skill, args.cmd, args.intent, raw_bytes, summary_bytes, timestamp)

        result = {
            "success": True,
            "skill": args.skill,
            "command": args.cmd,
            "summary": filtered,
            "raw_bytes": raw_bytes,
            "summary_bytes": summary_bytes,
            "bytes_saved": raw_bytes - summary_bytes,
            "savings_pct": round(savings, 1),
        }
        print(json.dumps(result))

    finally:
        conn.close()


if __name__ == "__main__":
    main()
