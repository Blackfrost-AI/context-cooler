#!/usr/bin/env python3
"""
Context Cooler — Automated Installer

Usage:
    python3 install.py              # Build + register MCP server (works on any machine)
    python3 install.py --dry-run    # Preview changes without writing
    python3 install.py --verify     # Check installation status
    python3 install.py --data-dir /path/to/data  # Override data directory

What it does (every install):
    1. Builds the standalone MCP server (npm install + tsc → dist/server.js)
    2. Registers the MCP server with the AI agents you select
       (claude-code / cursor / codex / gemini / opencode / pretzel-porter / grok)
    3. Initializes the SQLite databases under the data dir (default: your home
       directory, override with $CONTEXT_COOLER_HOME or --data-dir)
    4. Records an upgrade timestamp consulted by ctx_doctor
"""

import argparse
import datetime
import json
import os
import platform
import shutil
import sqlite3
import sys
from pathlib import Path
from textwrap import dedent

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")

SCRIPT_DIR = Path(__file__).resolve().parent
VERSION = "5.2.0"

# v4.6: Local timestamp consulted by ctx_doctor for the "you haven't
# upgraded in 30+ days" reminder. We touch this on every install/upgrade.
# Lives under <home>/context/ so install.py and doctor.ts agree on one location.
LAST_UPGRADE_PATH = Path.home() / "context" / "last-upgrade.txt"

# Platform adapters supported by `node dist/adapters/index.js`.
# Keep this list in sync with src/adapters/index.ts.
SUPPORTED_PLATFORMS = [
    "claude-code",
    "cursor",
    "codex",
    "gemini",
    "opencode",
    "pretzel-porter",
    "grok",
]


# ─────────────────────────────────────────────
# Disclaimer & platform checks
# ─────────────────────────────────────────────

DISCLAIMER = """\
================================================================================
                  Context Cooler — Disclaimer & Intended Use
================================================================================

This software is an MCP (Model Context Protocol) server designed to optimize
AI agent context windows through sandboxed code execution, intent-driven
filtering, FTS5 knowledge indexing, session continuity, and multi-messenger
delivery.

INTENDED USE:
  - Reducing token consumption when AI agents interact with data-heavy APIs
  - Sandboxed execution of code snippets in 11 supported languages
  - Indexing and searching structured/unstructured data via SQLite FTS5
  - Session snapshot and restore for context continuity across conversations
  - Message delivery via iMessage, Telegram, Slack, and Discord

BY PROCEEDING YOU ACKNOWLEDGE:
  1. This tool executes code in sandboxed subprocesses on your machine.
     While env vars are filtered and output is capped, you are responsible
     for reviewing what code your AI agents run through it.
  2. SQLite database files are created under the data directory (default:
     your home directory, override with --data-dir) to persist indexed data
     and session state across conversations.
  3. This software is provided "AS IS" under the MIT License, without
     warranty of any kind.
  4. iMessage delivery (macOS only) uses AppleScript to send messages.
     Telegram/Slack/Discord delivery requires your own API tokens.

Source: https://github.com/tlancas25/context-cooler
License: MIT
================================================================================
"""


def show_disclaimer(skip_prompt: bool = False) -> bool:
    """Display disclaimer and ask for user consent. Returns True if accepted."""
    print(DISCLAIMER)

    if skip_prompt:
        return True

    while True:
        try:
            answer = input("Do you accept and wish to continue? [yes/no]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\n\nInstallation cancelled.\n")
            return False

        if answer in ("yes", "y"):
            print()
            return True
        elif answer in ("no", "n"):
            print("\nInstallation cancelled.\n")
            return False
        else:
            print("  Please type 'yes' or 'no'.")


def update_from_git() -> bool:
    """Pull the latest version from the remote git repository."""
    import subprocess

    git_dir = SCRIPT_DIR / ".git"
    if not git_dir.exists():
        print("  This is not a git repository — cannot auto-update.")
        print("  Re-clone from: https://github.com/tlancas25/context-cooler.git\n")
        return False

    print("  Checking for updates...\n")

    # Fetch first to see if there are changes
    result = subprocess.run(
        ["git", "fetch"],
        cwd=str(SCRIPT_DIR),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        print(f"  git fetch failed: {result.stderr.strip()}")
        return False

    # Check if we're behind
    result = subprocess.run(
        ["git", "status", "-uno"],
        cwd=str(SCRIPT_DIR),
        capture_output=True,
        text=True,
        timeout=10,
    )
    if "Your branch is up to date" in result.stdout:
        print("  Already on the latest version.\n")
        # Still run the install to re-build and re-register
        return True

    # Pull changes
    print("  Pulling latest changes...")
    result = subprocess.run(
        ["git", "pull", "--ff-only"],
        cwd=str(SCRIPT_DIR),
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        print(f"  git pull failed: {result.stderr.strip()}")
        print("  You may have local changes. Try: git stash && git pull && git stash pop")
        return False

    print(f"  Updated successfully.\n")
    # Show what changed
    for line in result.stdout.strip().split("\n"):
        if line.strip():
            print(f"    {line}")
    print()
    return True


def show_windows_post_install():
    """Display Windows-specific post-installation notes."""
    print("""
================================================================================
                    Windows Post-Installation Notes
================================================================================

  1. WSL (Windows Subsystem for Linux) RECOMMENDED
     ─────────────────────────────────────────────
     Shell sandboxing (bash, python3, ruby, etc.) works best under WSL.
     If you don't have WSL installed, many sandbox features will be limited
     to languages available natively on Windows (node, python, go, rust).

     To install WSL:
       wsl --install

     Then re-run this installer from inside your WSL terminal for full
     shell sandboxing support.

  2. iMessage Delivery NOT AVAILABLE
     ─────────────────────────────────
     iMessage delivery uses macOS AppleScript and is not available on
     Windows. You can still use Telegram, Slack, and Discord delivery
     backends. Set up your tokens in your data directory's .env:
       TELEGRAM_BOT_TOKEN=your_token
       TELEGRAM_CHAT_ID=your_chat_id
       SLACK_WEBHOOK_URL=https://hooks.slack.com/...
       DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

  3. Python Command
     ──────────────
     On Windows, use 'python' instead of 'python3' for running scripts:
       python install.py
       python scripts/ctx_run.py --skill ...

  4. Path Separators
     ────────────────
     All internal paths use forward slashes and resolve correctly on
     Windows via Python's pathlib. No manual path conversion needed.

================================================================================
""")


# ─────────────────────────────────────────────
# Installer logic
# ─────────────────────────────────────────────

def log(msg, level="INFO"):
    icons = {"INFO": "→", "OK": "✅", "SKIP": "⏭️", "WARN": "⚠️", "ERR": "❌", "DRY": "🔍"}
    print(f"  {icons.get(level, '→')} {msg}")


def init_databases(data_dir: Path, dry_run: bool) -> bool:
    """Create context/ directory and initialize SQLite databases."""
    context_dir = data_dir / "context"

    if dry_run:
        log(f"Would create {context_dir} and initialize databases", "DRY")
        return True

    context_dir.mkdir(parents=True, exist_ok=True)

    # Stats + FTS5 index
    stats_db = context_dir / "stats.db"
    conn = sqlite3.connect(str(stats_db))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ctx_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
            skill TEXT,
            command TEXT,
            raw_bytes INTEGER,
            summary_bytes INTEGER,
            bytes_saved INTEGER,
            compression_pct REAL
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS ctx_index USING fts5(
            source, content, tokenize='porter'
        )
    """)
    conn.commit()
    conn.close()
    log(f"Initialized {stats_db}", "OK")

    # Session events
    sessions_db = context_dir / "sessions.db"
    conn = sqlite3.connect(str(sessions_db))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ctx_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
            event_type TEXT,
            priority TEXT DEFAULT 'medium',
            data TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ctx_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
            snapshot TEXT
        )
    """)
    conn.commit()
    conn.close()
    log(f"Initialized {sessions_db}", "OK")

    return True


def build_mcp_server(dry_run: bool) -> bool:
    """Install npm dependencies and build the MCP server."""
    package_json = SCRIPT_DIR / "package.json"
    if not package_json.exists():
        log("No package.json found — skipping MCP server build", "SKIP")
        return True

    node_modules = SCRIPT_DIR / "node_modules"
    dist_dir = SCRIPT_DIR / "dist"

    if dry_run:
        if not node_modules.exists():
            log("Would run: npm install", "DRY")
        log("Would run: npx tsc", "DRY")
        return True

    import subprocess

    # On Windows, npm/npx may need .cmd extension
    npm_cmd = "npm.cmd" if IS_WINDOWS else "npm"
    npx_cmd = "npx.cmd" if IS_WINDOWS else "npx"

    # npm install (skip if node_modules exists)
    if not node_modules.exists():
        log("Running npm install...")
        result = subprocess.run(
            [npm_cmd, "install"],
            cwd=str(SCRIPT_DIR),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            log(f"npm install failed: {result.stderr[:200]}", "ERR")
            return False
        log("npm install complete", "OK")
    else:
        log("node_modules exists — skipping npm install", "SKIP")

    # TypeScript build
    log("Building TypeScript...")
    result = subprocess.run(
        [npx_cmd, "tsc"],
        cwd=str(SCRIPT_DIR),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        log(f"TypeScript build failed: {result.stderr[:500]}", "ERR")
        return False

    server_js = dist_dir / "server.js"
    if server_js.exists():
        log(f"MCP server built: {server_js}", "OK")
        return True
    else:
        log("Build completed but dist/server.js not found", "ERR")
        return False


def register_mcp_server(dry_run: bool, platforms: list) -> bool:
    """Register context-cooler via the v5 platform adapters.

    Shells out to `node dist/adapters/index.js install ...`, one call per
    platform. Each adapter writes a JSON line to stdout describing what it
    did (or would do under --dry-run); we surface those as installer logs.
    """
    server_js = SCRIPT_DIR / "dist" / "server.js"
    adapter_js = SCRIPT_DIR / "dist" / "adapters" / "index.js"

    if not dry_run and not server_js.exists():
        log("dist/server.js not found — build first", "ERR")
        return False
    if not dry_run and not adapter_js.exists():
        log("dist/adapters/index.js not found — build first", "ERR")
        return False

    if not platforms:
        log("No platforms selected for MCP registration", "SKIP")
        return True

    import subprocess

    all_ok = True
    for platform_id in platforms:
        if platform_id not in SUPPORTED_PLATFORMS:
            log(f"Unknown platform '{platform_id}' — skipping", "WARN")
            continue

        cmd = [
            "node",
            str(adapter_js),
            "install",
            f"--server={server_js}",
            f"--platform={platform_id}",
        ]
        if dry_run:
            cmd.append("--dry-run")

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=15
            )
        except (subprocess.TimeoutExpired, FileNotFoundError) as err:
            log(f"adapter call failed for {platform_id}: {err}", "ERR")
            all_ok = False
            continue

        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                log(f"adapter output unparseable: {line}", "WARN")
                continue
            level = "DRY" if dry_run else ("OK" if payload.get("ok") else "ERR")
            log(f"[{payload.get('platform')}] {payload.get('detail')}", level)
            if not payload.get("ok"):
                all_ok = False

        if result.returncode != 0:
            if result.stderr.strip():
                log(result.stderr.strip(), "WARN")
            all_ok = False

    return all_ok


def record_last_upgrade(dry_run: bool) -> bool:
    """Write the current ISO timestamp to <home>/context/last-upgrade.txt.

    ctx_doctor reads this file (purely locally — no network call) and
    surfaces a reminder when the timestamp is older than 30 days.
    """
    if dry_run:
        log(f"Would update {LAST_UPGRADE_PATH}", "DRY")
        return True

    try:
        LAST_UPGRADE_PATH.parent.mkdir(parents=True, exist_ok=True)
        LAST_UPGRADE_PATH.write_text(
            datetime.datetime.now(datetime.timezone.utc).isoformat() + "\n"
        )
        log(f"Wrote upgrade timestamp to {LAST_UPGRADE_PATH}", "OK")
        return True
    except OSError as err:
        log(f"Could not write {LAST_UPGRADE_PATH}: {err}", "WARN")
        return False


def prompt_platforms(non_interactive: bool, default_all: bool = True) -> list:
    """Interactive picker for the v4.6 platform adapter list.

    Stdlib only (input()). Honoured under TTY; if non-interactive (or
    --accept-disclaimer), falls back to default_all → SUPPORTED_PLATFORMS.
    """
    if non_interactive or not sys.stdin.isatty():
        return SUPPORTED_PLATFORMS if default_all else ["claude-code"]

    print("\n  Which AI coding agents should we register the MCP server with?")
    for i, p in enumerate(SUPPORTED_PLATFORMS, 1):
        print(f"    {i}. {p}")
    print(f"    {len(SUPPORTED_PLATFORMS) + 1}. all (recommended)")

    while True:
        try:
            answer = input(
                f"  Pick one or comma-separated [default: all]: "
            ).strip()
        except (EOFError, KeyboardInterrupt):
            print("\n  Defaulting to all.\n")
            return SUPPORTED_PLATFORMS

        if not answer or answer.lower() == "all":
            return SUPPORTED_PLATFORMS

        # Parse a list of names or 1-based indices.
        picked = []
        ok = True
        for tok in answer.replace(",", " ").split():
            tok = tok.strip().lower()
            if tok.isdigit():
                idx = int(tok)
                if idx == len(SUPPORTED_PLATFORMS) + 1:
                    return SUPPORTED_PLATFORMS
                if 1 <= idx <= len(SUPPORTED_PLATFORMS):
                    picked.append(SUPPORTED_PLATFORMS[idx - 1])
                else:
                    ok = False
                    break
            elif tok in SUPPORTED_PLATFORMS:
                picked.append(tok)
            elif tok == "all":
                return SUPPORTED_PLATFORMS
            else:
                ok = False
                break

        if ok and picked:
            # Dedupe while preserving order.
            seen = set()
            return [p for p in picked if not (p in seen or seen.add(p))]

        print("  Didn't recognise that — try again (e.g. '1,2' or 'claude-code,cursor,grok').")


def confirm_install_path(default_path: Path, non_interactive: bool) -> Path:
    """Confirm or override the data directory (where SQLite DBs live)."""
    if non_interactive or not sys.stdin.isatty():
        return default_path

    try:
        answer = input(
            f"  Data directory [{default_path}]: "
        ).strip()
    except (EOFError, KeyboardInterrupt):
        return default_path

    if not answer:
        return default_path
    return Path(answer).expanduser().resolve()


def uninstall(dry_run: bool) -> bool:
    """Nothing to unwire — the installer only builds/registers/inits.

    The MCP server registration lives in each agent's own config; remove it
    there if desired. SQLite databases and scripts are left in place.
    """
    print("\n🗑️  Context Cooler uninstall\n")
    log("Built scripts and SQLite databases remain in place.", "SKIP")
    log("To unregister the MCP server, remove the 'context-cooler' entry "
        "from your AI agent's MCP config.", "SKIP")
    return True


def verify_installation(data_dir: Path) -> dict:
    """Check installation status and return a report."""
    report = {}

    # Check MCP server build
    server_js = SCRIPT_DIR / "dist" / "server.js"
    report["mcp_server_built"] = server_js.exists()

    # Check MCP registration
    claude_json = Path.home() / ".claude.json"
    if claude_json.exists():
        try:
            config = json.loads(claude_json.read_text())
            report["mcp_registered"] = "context-cooler" in config.get("mcpServers", {})
        except json.JSONDecodeError:
            report["mcp_registered"] = False
    else:
        report["mcp_registered"] = False

    # Check databases
    report["stats_db"] = (data_dir / "context" / "stats.db").exists()
    report["sessions_db"] = (data_dir / "context" / "sessions.db").exists()

    return report


def main():
    py_cmd = "python" if IS_WINDOWS else "python3"

    parser = argparse.ArgumentParser(
        description="Context Cooler — Automated Installer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=dedent(f"""
        Examples:
            {py_cmd} install.py                       # Install with defaults
            {py_cmd} install.py --update              # Pull latest + re-install
            {py_cmd} install.py --dry-run             # Preview changes
            {py_cmd} install.py --data-dir /custom    # Custom data directory
            {py_cmd} install.py --verify              # Check status
        """),
    )
    parser.add_argument(
        "--data-dir",
        dest="data_dir",
        type=Path,
        default=Path(os.environ.get("CONTEXT_COOLER_HOME", Path.home())),
        help="Data directory for SQLite DBs (default: $CONTEXT_COOLER_HOME or your home directory, auto-created)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    parser.add_argument("--uninstall", action="store_true", help="Show uninstall notes")
    parser.add_argument("--verify", action="store_true", help="Check installation status")
    parser.add_argument("--update", action="store_true", help="Pull latest from git and re-install")
    parser.add_argument("--accept-disclaimer", action="store_true", help="Accept disclaimer without prompt (for CI/scripted installs)")
    parser.add_argument(
        "--platform",
        action="append",
        choices=SUPPORTED_PLATFORMS + ["all"],
        help="Target an AI coding agent (repeatable). Use 'all' to register everywhere. Default: prompt interactively, fall back to all in non-TTY.",
    )
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Skip every interactive prompt — use defaults (all platforms, default data directory).",
    )
    args = parser.parse_args()

    # ── Disclaimer screen (always shown first, except --verify) ──
    if not args.verify:
        if not show_disclaimer(skip_prompt=args.accept_disclaimer):
            sys.exit(1)

    # ── Update mode: git pull then continue to install ──
    if args.update:
        if not update_from_git():
            sys.exit(1)
        # Force rebuild after update (node_modules stays, but dist gets rebuilt)
        dist_dir = SCRIPT_DIR / "dist"
        if dist_dir.exists():
            shutil.rmtree(dist_dir)

    data_dir = args.data_dir.expanduser().resolve()

    # v4.6: confirm the install path interactively unless suppressed.
    non_interactive = args.non_interactive or args.accept_disclaimer
    if not args.verify and not args.uninstall:
        data_dir = confirm_install_path(data_dir, non_interactive)

    # Data directory: reused by the TS runtime to store stats.db / sessions.db.
    # Defaults to the user's home directory; auto-created if missing.
    if not data_dir.exists():
        if args.dry_run:
            print(f"  Would create data dir: {data_dir}")
        else:
            try:
                data_dir.mkdir(parents=True, exist_ok=True)
                print(f"  Created data dir: {data_dir}")
            except OSError as err:
                print(f"  Could not create data dir {data_dir}: {err}")
                sys.exit(1)

    # Verify mode
    if args.verify:
        print(f"\n🔍 Context Cooler Installation Status ({data_dir})\n")
        report = verify_installation(data_dir)
        for key, status in report.items():
            icon = "✅" if status else ("⏭️" if status is None else "❌")
            print(f"  {icon} {key.replace('_', ' ').title()}")
        all_ok = all(v is True or v is None for v in report.values())
        print(f"\n{'✅ Fully installed' if all_ok else '⚠️  Incomplete — run install.py'}\n")
        sys.exit(0 if all_ok else 1)

    # Uninstall mode
    if args.uninstall:
        uninstall(args.dry_run)
        sys.exit(0)

    # Install mode
    mode = "DRY RUN" if args.dry_run else "INSTALL"
    plat = "Windows" if IS_WINDOWS else ("macOS" if IS_MACOS else ("Linux" if IS_LINUX else sys.platform))
    print(f"\n  Context Cooler Installer v{VERSION} [{mode}]")
    print(f"   Platform: {plat}")
    print(f"   Data dir: {data_dir}\n")

    # v4.6: resolve which AI agent platforms we're registering with.
    # CLI flags > interactive prompt > "all" default.
    if args.platform:
        platforms = (
            list(SUPPORTED_PLATFORMS)
            if "all" in args.platform
            else list(dict.fromkeys(args.platform))  # dedupe, preserve order
        )
    else:
        platforms = prompt_platforms(non_interactive)

    steps = [
        ("Building MCP server", lambda: build_mcp_server(args.dry_run)),
        (
            f"Registering MCP server ({', '.join(platforms) or 'none'})",
            lambda: register_mcp_server(args.dry_run, platforms),
        ),
        ("Initializing databases", lambda: init_databases(data_dir, args.dry_run)),
        ("Recording upgrade timestamp", lambda: record_last_upgrade(args.dry_run)),
    ]

    all_ok = True
    for label, fn in steps:
        print(f"\n  [{label}]")
        if not fn():
            all_ok = False

    print()
    if args.dry_run:
        print("  Dry run complete. No files were modified.")
        print(f"   Run without --dry-run to apply changes.\n")
    elif all_ok:
        print("  Context Cooler installed!")
        if IS_WINDOWS:
            show_windows_post_install()
        else:
            print("   Restart your AI agent (Claude Code, Cursor, etc.) to pick up the MCP server.\n")
    else:
        print("  Installation completed with warnings. Check output above.\n")

    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
