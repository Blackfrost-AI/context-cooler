#!/usr/bin/env python3
"""
OpenClaw Context Saver — Automated Installer

Usage:
    python3 install.py              # Install with defaults (~/.openclaw)
    python3 install.py --dry-run    # Preview changes without writing
    python3 install.py --uninstall  # Remove context-saver wiring
    python3 install.py --openclaw-home /path/to/openclaw  # Custom path

What it does:
    1. Copies/symlinks scripts into ~/.openclaw/workspace/skills/context-saver/
    2. Patches AGENTS.md with the Context Saver Protocol (mandatory rules)
    3. Patches TOOLS.md with quick-reference commands
    4. Patches existing cron jobs to route data-heavy skill calls through ctx_run.py
    5. Creates the context/ directory and initializes SQLite databases
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path
from textwrap import dedent

SCRIPT_DIR = Path(__file__).resolve().parent
VERSION = "4.0.0"

# Skills whose output should be routed through context-saver
DATA_HEAVY_SKILLS = [
    "alpaca-trader",
    "analytics-engine",
    "cost-tracker",
    "x-analytics",
    "x-search",
    "health-monitor",
    "plaid",
]

# Skills that should NOT be wrapped (write ops / small outputs)
SKIP_SKILLS = [
    "x-post",
    "x-content-manager",
    "notification-router",
    "secret-manager",
    "memory-manager",
    "context-saver",  # don't wrap yourself
]

# ─────────────────────────────────────────────
# Patch content blocks
# ─────────────────────────────────────────────

AGENTS_MD_MARKER = "### 🪶 Context Saver Protocol — MANDATORY for Data-Heavy Skills"

AGENTS_MD_PATCH = '''### 🪶 Context Saver Protocol — MANDATORY for Data-Heavy Skills

> **THIS IS NOT OPTIONAL.** Raw API responses (3-50 KB) entering context get re-read every turn via cache, burning thousands of tokens per message. Context Saver reduces this by 70-98%.

**The Rule:** If a skill returns JSON data (positions, account info, options chains, analytics, search results), **wrap it in context-saver**. Never call data-heavy skills directly.

#### How to Use

**Single skill command:**
```bash
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_run.py \\
  --skill <skill-name> --cmd "<command>" --fields "field1,field2,field3"
```

**With intent filtering (smarter than field lists):**
```bash
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_run.py \\
  --skill <skill-name> --cmd "<command>" --intent "find relevant items"
```

**Multiple commands in one call (batch mode):**
```bash
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_batch.py --commands '[
  {"skill": "skill-a", "cmd": "command1", "fields": ["field1","field2"]},
  {"skill": "skill-b", "cmd": "command2", "intent": "summary"},
  {"skill": "skill-c", "cmd": "command3", "intent": "top 5"}
]'
```

#### Which Skills MUST Go Through Context Saver

| Skill | Why | Typical Savings |
|-------|-----|-----------------|
| `alpaca-trader` | Account, positions, chains = 3-50 KB each | 94-97% |
| `analytics-engine` | Metrics dumps | 90%+ |
| `cost-tracker` | Usage/billing data | 85%+ |
| `x-analytics` | Engagement data arrays | 90%+ |
| `x-search` | Search result arrays | 85%+ |
| `health-monitor` | System check JSON | 80%+ |
| `plaid` | Financial data | 95%+ |

#### Skills That DON'T Need Context Saver

- `x-post`, `x-content-manager` — write operations, small responses
- `notification-router` — routing commands, not data
- `secret-manager` — small key/value lookups
- `memory-manager` — already optimized
- Any skill returning < 500 bytes

#### Intent Keywords

- `"summary"` or `"brief"` — scalars only, no nested objects
- `"top N"` — first N items from arrays
- `"find X"` — filter array items matching keyword
- `"check X"` — extract fields matching keyword

#### 🔁 Propagation Rules — Cron Jobs & Subagents

**When CREATING new cron jobs**, always wrap data-heavy skill calls through context-saver in the job prompt. Example:
```
❌ "Use alpaca-trader to get account and positions"
✅ "Use context-saver to wrap ALL data skill calls:
    python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_batch.py --commands '[
      {"skill":"alpaca-trader","cmd":"account","fields":["equity","buying_power","cash"]},
      {"skill":"alpaca-trader","cmd":"positions","intent":"summary"}
    ]'"
```

**When SPAWNING subagents**, include context-saver instructions in the task envelope:
```
❌ task: "Get trading positions and analyze them"
✅ task: "Get trading positions via context-saver (ctx_run.py --skill alpaca-trader --cmd positions --intent summary) and analyze the summary"
```

**The propagation rule:** Any instruction you write that will be executed by another agent or future session MUST include context-saver wrapping for data-heavy skills. If you create a cron job, subagent task, or HEARTBEAT.md check that calls a data-heavy skill without context-saver, you are creating token waste.

#### Anti-Pattern ❌
```
User: "How are my positions?"
You: *calls alpaca-trader positions directly*
→ 5 KB raw JSON enters context, gets re-read every turn = thousands of wasted tokens
```

#### Correct Pattern ✅
```
User: "How are my positions?"
You: *calls ctx_run.py --skill alpaca-trader --cmd "positions" --intent "summary"*
→ 300 byte summary enters context, full data indexed in FTS5 if needed later
```'''

TOOLS_MD_MARKER = "## 🪶 Context Saver — Token Optimization Layer"

TOOLS_MD_PATCH = '''## 🪶 Context Saver — Token Optimization Layer

**Always use context-saver when calling data-heavy skills in chat.** See AGENTS.md § "Context Saver Protocol" for full rules.

Quick reference:
```bash
# Single command
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_run.py \\
  --skill <skill-name> --cmd "<command>" --intent "<filter>"

# Batch (multiple commands at once)
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_batch.py \\
  --commands '[{"skill":"...","cmd":"...","intent":"..."}]'

# Search previously indexed data
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_search.py "<query>"

# Check savings stats
python3 ~/.openclaw/workspace/skills/context-saver/scripts/ctx_stats.py
```

**Wrap these skills:** alpaca-trader, analytics-engine, cost-tracker, x-analytics, x-search, health-monitor, plaid
**Skip for:** x-post, notification-router, secret-manager, memory-manager (small outputs)'''


# ─────────────────────────────────────────────
# Installer logic
# ─────────────────────────────────────────────

def log(msg, level="INFO"):
    icons = {"INFO": "→", "OK": "✅", "SKIP": "⏭️", "WARN": "⚠️", "ERR": "❌", "DRY": "🔍"}
    print(f"  {icons.get(level, '→')} {msg}")


def install_scripts(openclaw_home: Path, dry_run: bool) -> bool:
    """Copy or symlink context-saver scripts into the skills directory."""
    skills_dir = openclaw_home / "workspace" / "skills" / "context-saver"
    source_dir = SCRIPT_DIR

    if skills_dir.resolve() == source_dir.resolve():
        log("Scripts already in place (same directory)", "SKIP")
        return True

    # Check if it's a symlink pointing to us
    if skills_dir.is_symlink() and skills_dir.resolve() == source_dir.resolve():
        log("Symlink already points to repo", "SKIP")
        return True

    if dry_run:
        log(f"Would install scripts: {source_dir} → {skills_dir}", "DRY")
        return True

    # Create skills dir structure
    skills_dir.mkdir(parents=True, exist_ok=True)

    # Copy key files
    for subdir in ["scripts"]:
        src = source_dir / subdir
        dst = skills_dir / subdir
        if src.exists():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
            log(f"Copied {subdir}/ → {dst}", "OK")

    # Copy manifest files
    for fname in ["SKILL.md", "skill.json"]:
        src = source_dir / fname
        dst = skills_dir / fname
        if src.exists():
            shutil.copy2(src, dst)

    log(f"Scripts installed to {skills_dir}", "OK")
    return True


def init_databases(openclaw_home: Path, dry_run: bool) -> bool:
    """Create context/ directory and initialize SQLite databases."""
    context_dir = openclaw_home / "context"

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


def patch_file(filepath: Path, marker: str, patch: str, insert_before: str = None, dry_run: bool = False) -> bool:
    """Insert a patch block into a file if the marker isn't already present."""
    if not filepath.exists():
        log(f"File not found: {filepath}", "WARN")
        return False

    content = filepath.read_text()

    if marker in content:
        log(f"Already patched: {filepath.name}", "SKIP")
        return True

    if dry_run:
        log(f"Would patch {filepath.name} with Context Saver Protocol", "DRY")
        return True

    if insert_before and insert_before in content:
        # Insert before a specific section
        content = content.replace(insert_before, patch + "\n\n" + insert_before)
    else:
        # Append before the last "---" separator, or at the end
        last_separator = content.rfind("\n---\n")
        if last_separator != -1:
            content = content[:last_separator] + "\n\n" + patch + content[last_separator:]
        else:
            content = content.rstrip() + "\n\n" + patch + "\n"

    filepath.write_text(content)
    log(f"Patched {filepath.name}", "OK")
    return True


def patch_agents_md(openclaw_home: Path, dry_run: bool) -> bool:
    """Add Context Saver Protocol to AGENTS.md."""
    agents_md = openclaw_home / "workspace" / "AGENTS.md"
    return patch_file(
        agents_md,
        AGENTS_MD_MARKER,
        AGENTS_MD_PATCH,
        insert_before="### Subagent Protocol",
        dry_run=dry_run,
    )


def patch_tools_md(openclaw_home: Path, dry_run: bool) -> bool:
    """Add quick-reference section to TOOLS.md."""
    tools_md = openclaw_home / "workspace" / "TOOLS.md"
    return patch_file(
        tools_md,
        TOOLS_MD_MARKER,
        TOOLS_MD_PATCH,
        dry_run=dry_run,
    )


def patch_cron_jobs(openclaw_home: Path, dry_run: bool) -> bool:
    """Patch existing cron jobs to route data-heavy skills through context-saver."""
    jobs_file = openclaw_home / "cron" / "jobs.json"

    if not jobs_file.exists():
        log("No cron/jobs.json found — skipping cron patching", "SKIP")
        return True

    try:
        jobs = json.loads(jobs_file.read_text())
    except json.JSONDecodeError as e:
        log(f"Failed to parse jobs.json: {e}", "ERR")
        return False

    if not isinstance(jobs, list):
        log("jobs.json is not a list — skipping", "WARN")
        return True

    patched_count = 0
    ctx_run_path = "~/.openclaw/workspace/skills/context-saver/scripts/ctx_run.py"
    ctx_batch_path = "~/.openclaw/workspace/skills/context-saver/scripts/ctx_batch.py"

    for job in jobs:
        message = job.get("message", "")

        # Skip if already wired
        if "context-saver" in message or "ctx_run" in message or "ctx_batch" in message:
            continue

        # Check if this job references any data-heavy skills
        mentions_data_skill = False
        for skill in DATA_HEAVY_SKILLS:
            if skill in message:
                mentions_data_skill = True
                break

        if not mentions_data_skill:
            continue

        if dry_run:
            label = job.get("label", job.get("id", "unknown"))
            log(f"Would patch cron job: {label}", "DRY")
            patched_count += 1
            continue

        # Add context-saver instruction to the job message
        ctx_instruction = (
            f"\n\n⚠️ IMPORTANT: Route ALL data-heavy skill calls through context-saver to reduce token usage.\n"
            f"Instead of calling skills directly, use:\n"
            f"  python3 {ctx_run_path} --skill <skill-name> --cmd '<command>' --intent '<filter>'\n"
            f"For multiple calls, use batch mode:\n"
            f"  python3 {ctx_batch_path} --commands '[{{\"skill\":\"...\",\"cmd\":\"...\",\"intent\":\"...\"}}]'\n"
            f"This applies to: alpaca-trader, analytics-engine, cost-tracker, x-analytics, x-search, health-monitor, plaid."
        )
        job["message"] = message + ctx_instruction
        patched_count += 1

    if patched_count > 0 and not dry_run:
        jobs_file.write_text(json.dumps(jobs, indent=2) + "\n")
        log(f"Patched {patched_count} cron job(s) in jobs.json", "OK")
    elif patched_count == 0:
        log("All cron jobs already wired or no data-heavy skills found", "SKIP")

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

    # npm install (skip if node_modules exists)
    if not node_modules.exists():
        log("Running npm install...")
        result = subprocess.run(
            ["npm", "install"],
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
        ["npx", "tsc"],
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


def register_mcp_server(dry_run: bool) -> bool:
    """Register openclaw-context-saver in ~/.claude.json as an MCP server."""
    claude_json = Path.home() / ".claude.json"
    server_js = SCRIPT_DIR / "dist" / "server.js"

    if not server_js.exists() and not dry_run:
        log("dist/server.js not found — build first", "ERR")
        return False

    server_path = str(server_js)

    if dry_run:
        log(f"Would register MCP server in {claude_json}", "DRY")
        return True

    # Read existing config
    config = {}
    if claude_json.exists():
        try:
            config = json.loads(claude_json.read_text())
        except json.JSONDecodeError:
            log(f"Failed to parse {claude_json}", "WARN")
            config = {}

    servers = config.setdefault("mcpServers", {})

    # Check if already registered with same path
    existing = servers.get("openclaw-context-saver", {})
    existing_args = existing.get("args", [])
    if existing_args and existing_args[-1] == server_path:
        log("MCP server already registered with correct path", "SKIP")
        return True

    # Register
    servers["openclaw-context-saver"] = {
        "type": "stdio",
        "command": "node",
        "args": [server_path],
        "env": {},
    }

    claude_json.write_text(json.dumps(config, indent=2) + "\n")
    log(f"Registered openclaw-context-saver in {claude_json}", "OK")
    return True


def uninstall(openclaw_home: Path, dry_run: bool) -> bool:
    """Remove context-saver wiring from AGENTS.md, TOOLS.md, and cron jobs."""
    print("\n🗑️  Uninstalling Context Saver wiring...\n")

    # Remove from AGENTS.md
    agents_md = openclaw_home / "workspace" / "AGENTS.md"
    if agents_md.exists():
        content = agents_md.read_text()
        if AGENTS_MD_MARKER in content:
            # Find the section and remove it (from marker to next ### or end of section)
            start = content.index(AGENTS_MD_MARKER)
            # Find the next ### heading that isn't part of our block
            rest = content[start + len(AGENTS_MD_MARKER):]
            next_section = re.search(r'\n### (?!🪶)', rest)
            if next_section:
                end = start + len(AGENTS_MD_MARKER) + next_section.start()
            else:
                end = len(content)

            if dry_run:
                log("Would remove Context Saver Protocol from AGENTS.md", "DRY")
            else:
                content = content[:start].rstrip() + "\n\n" + content[end:].lstrip()
                agents_md.write_text(content)
                log("Removed Context Saver Protocol from AGENTS.md", "OK")

    # Remove from TOOLS.md
    tools_md = openclaw_home / "workspace" / "TOOLS.md"
    if tools_md.exists():
        content = tools_md.read_text()
        if TOOLS_MD_MARKER in content:
            start = content.index(TOOLS_MD_MARKER)
            # Find next ## heading or ---
            rest = content[start + len(TOOLS_MD_MARKER):]
            next_section = re.search(r'\n(?:## |---)', rest)
            if next_section:
                end = start + len(TOOLS_MD_MARKER) + next_section.start()
            else:
                end = len(content)

            if dry_run:
                log("Would remove Context Saver section from TOOLS.md", "DRY")
            else:
                content = content[:start].rstrip() + "\n\n" + content[end:].lstrip()
                tools_md.write_text(content)
                log("Removed Context Saver section from TOOLS.md", "OK")

    # Remove from cron jobs
    jobs_file = openclaw_home / "cron" / "jobs.json"
    if jobs_file.exists():
        try:
            jobs = json.loads(jobs_file.read_text())
            patched = 0
            for job in jobs:
                msg = job.get("message", "")
                if "⚠️ IMPORTANT: Route ALL data-heavy skill calls through context-saver" in msg:
                    idx = msg.index("\n\n⚠️ IMPORTANT: Route ALL data-heavy skill calls")
                    job["message"] = msg[:idx]
                    patched += 1
            if patched:
                if dry_run:
                    log(f"Would remove context-saver from {patched} cron job(s)", "DRY")
                else:
                    jobs_file.write_text(json.dumps(jobs, indent=2) + "\n")
                    log(f"Removed context-saver from {patched} cron job(s)", "OK")
        except (json.JSONDecodeError, ValueError):
            log("Failed to parse jobs.json during uninstall", "WARN")

    return True


def verify_installation(openclaw_home: Path) -> dict:
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
            report["mcp_registered"] = "openclaw-context-saver" in config.get("mcpServers", {})
        except json.JSONDecodeError:
            report["mcp_registered"] = False
    else:
        report["mcp_registered"] = False

    # Check scripts
    scripts_dir = openclaw_home / "workspace" / "skills" / "context-saver" / "scripts"
    scripts = ["ctx_run.py", "ctx_batch.py", "ctx_search.py", "ctx_session.py", "ctx_stats.py"]
    report["python_scripts"] = all((scripts_dir / s).exists() for s in scripts)

    # Check databases
    report["stats_db"] = (openclaw_home / "context" / "stats.db").exists()
    report["sessions_db"] = (openclaw_home / "context" / "sessions.db").exists()

    # Check AGENTS.md
    agents_md = openclaw_home / "workspace" / "AGENTS.md"
    report["agents_md"] = agents_md.exists() and AGENTS_MD_MARKER in agents_md.read_text()

    # Check TOOLS.md
    tools_md = openclaw_home / "workspace" / "TOOLS.md"
    report["tools_md"] = tools_md.exists() and TOOLS_MD_MARKER in tools_md.read_text()

    # Check cron jobs
    jobs_file = openclaw_home / "cron" / "jobs.json"
    if jobs_file.exists():
        content = jobs_file.read_text()
        report["cron_jobs"] = "ctx_run" in content or "ctx_batch" in content or "context-saver" in content
    else:
        report["cron_jobs"] = None  # No cron jobs file

    return report


def main():
    parser = argparse.ArgumentParser(
        description="OpenClaw Context Saver — Automated Installer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=dedent("""
        Examples:
            python3 install.py                          # Install with defaults
            python3 install.py --dry-run                # Preview changes
            python3 install.py --uninstall              # Remove wiring
            python3 install.py --openclaw-home /custom  # Custom path
            python3 install.py --verify                 # Check status
        """),
    )
    parser.add_argument(
        "--openclaw-home",
        type=Path,
        default=Path(os.environ.get("OPENCLAW_HOME", Path.home() / ".openclaw")),
        help="Path to OpenClaw home directory (default: ~/.openclaw)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    parser.add_argument("--uninstall", action="store_true", help="Remove context-saver wiring")
    parser.add_argument("--verify", action="store_true", help="Check installation status")
    parser.add_argument("--skip-cron", action="store_true", help="Skip cron job patching")
    parser.add_argument("--skip-agents", action="store_true", help="Skip AGENTS.md patching")
    parser.add_argument("--skip-tools", action="store_true", help="Skip TOOLS.md patching")
    args = parser.parse_args()

    openclaw_home = args.openclaw_home.expanduser().resolve()

    if not openclaw_home.exists():
        print(f"❌ OpenClaw home not found: {openclaw_home}")
        print("   Set OPENCLAW_HOME or use --openclaw-home /path/to/openclaw")
        sys.exit(1)

    # Verify mode
    if args.verify:
        print(f"\n🔍 Context Saver Installation Status ({openclaw_home})\n")
        report = verify_installation(openclaw_home)
        for key, status in report.items():
            icon = "✅" if status else ("⏭️" if status is None else "❌")
            print(f"  {icon} {key.replace('_', ' ').title()}")
        all_ok = all(v is True or v is None for v in report.values())
        print(f"\n{'✅ Fully installed' if all_ok else '⚠️  Incomplete — run install.py'}\n")
        sys.exit(0 if all_ok else 1)

    # Uninstall mode
    if args.uninstall:
        uninstall(openclaw_home, args.dry_run)
        if args.dry_run:
            print("\n🔍 Dry run complete. No files were modified.\n")
        else:
            print("\n✅ Context Saver wiring removed. Scripts are still in place.\n")
        sys.exit(0)

    # Install mode
    mode = "DRY RUN" if args.dry_run else "INSTALL"
    print(f"\n🪶 Context Saver Installer v{VERSION} [{mode}]")
    print(f"   Target: {openclaw_home}\n")

    steps = [
        ("Building MCP server", lambda: build_mcp_server(args.dry_run)),
        ("Registering MCP server", lambda: register_mcp_server(args.dry_run)),
        ("Installing scripts", lambda: install_scripts(openclaw_home, args.dry_run)),
        ("Initializing databases", lambda: init_databases(openclaw_home, args.dry_run)),
    ]
    if not args.skip_agents:
        steps.append(("Patching AGENTS.md", lambda: patch_agents_md(openclaw_home, args.dry_run)))
    if not args.skip_tools:
        steps.append(("Patching TOOLS.md", lambda: patch_tools_md(openclaw_home, args.dry_run)))
    if not args.skip_cron:
        steps.append(("Patching cron jobs", lambda: patch_cron_jobs(openclaw_home, args.dry_run)))

    all_ok = True
    for label, fn in steps:
        print(f"\n  [{label}]")
        if not fn():
            all_ok = False

    print()
    if args.dry_run:
        print("🔍 Dry run complete. No files were modified.")
        print("   Run without --dry-run to apply changes.\n")
    elif all_ok:
        print("✅ Context Saver installed and wired!")
        print("   Restart your OpenClaw gateway to pick up changes:")
        print("   launchctl stop ai.openclaw.gateway && launchctl start ai.openclaw.gateway\n")
    else:
        print("⚠️  Installation completed with warnings. Check output above.\n")

    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
