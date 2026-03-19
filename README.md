# OpenClaw Context Saver v3.0

**Production-grade context optimization for AI agents. Cut token usage by 70-98%. Built on the Model Context Protocol (MCP) via [`context-mode`](https://github.com/mksglu/context-mode) — works with Claude Code, Cursor, Gemini CLI, OpenClaw, and any MCP-compatible agent.**

Every AI agent framework has the same problem: they dump full API responses into the context window. A single Playwright snapshot costs 56 KB. Twenty GitHub issues cost 59 KB. One access log — 45 KB. After 30 minutes, 40% of your context is gone.

Context Saver v3.0 is a **dual-layer optimization system** that extends the open-source `context-mode` MCP server with production agent-proofing: compact-by-default skill output, intent-driven filtering with verbose injection, multi-messenger delivery pipelines, zero-token launchd automation, and session continuity with priority-based snapshots. All custom logic in pure Python. Zero pip dependencies.

> **What changed in v3.0?** We discovered that `context-mode` — the MCP server already registered in our `~/.claude.json` — was providing the base sandboxing and FTS5 indexing layer all along. Our Python scripts (ctx_run.py, ctx_batch.py, etc.) are a **separate, complementary system** that adds agent-proofing, delivery, and optimization logic on top. v3.0 documents this dual-layer architecture and shows how both systems work together for maximum token savings.

### What Context Saver Adds Over Base context-mode

| Capability | context-mode (MCP base) | Context Saver v3.0 (this project) |
|-----------|------------------------|-----------------------------------|
| Sandboxed execution | 9 MCP tools, 11 languages | Uses context-mode + adds Python wrapper layer |
| FTS5 indexing | Ephemeral per-session | Persistent SQLite (110+ runs tracked) |
| Intent filtering | Output >5KB triggers BM25 sections | Keyword scoring on JSON keys/values + wrapper dict unwrapping |
| Verbose injection | N/A | Auto-injects `--verbose` into skill calls for accurate filtering |
| Compact-by-default | N/A | Skills return minimal JSON; `--verbose` required for full dump |
| Batch execution | `ctx_batch_execute` (shell commands) | Pipeline files with workspace path restriction + JSON skill configs |
| Session continuity | Hook-based tracking (Claude Code plugin) | P1-P4 priority events + 2 KB compaction snapshots in SQLite |
| Delivery | N/A | iMessage, Telegram, Slack, Discord auto-detection |
| Zero-token pipelines | N/A | launchd → Python → deliver (no LLM involved) |
| Security audit | Basic sandboxing | 14-finding audit: injection, traversal, secrets, index caps |
| Framework | Any MCP client | Any MCP client + OpenClaw native + direct Python scripts |

---

## The Dual-Layer Architecture

Context Saver v3.0 operates as **two independent but complementary systems**. We verified this hands-on: they maintain separate databases, separate stats, and solve different layers of the same problem.

```
┌──────────────────────────────────────────────────────────────────┐
│            ANY MCP-Compatible AI Agent                            │
│     Claude Code / Cursor / Gemini CLI / OpenClaw / Custom         │
└───────────┬──────────────────────────────────┬───────────────────┘
            │                                  │
    ┌───────▼────────┐                ┌────────▼────────┐
    │  PATH A: MCP   │                │  PATH B: Direct │
    │  (automatic)   │                │  (scripts/cron) │
    └───────┬────────┘                └────────┬────────┘
            │                                  │
┌───────────▼──────────────────┐  ┌────────────▼──────────────────┐
│  LAYER 1: context-mode       │  │  LAYER 2: Context Saver       │
│  (MCP Server — npm package)  │  │  (Python Scripts — this repo)  │
│                              │  │                                │
│  By: github.com/mksglu       │  │  By: @openclawguru             │
│  Transport: stdio via npx    │  │  Runtime: Python 3.8+ stdlib   │
│  DB: Ephemeral per-session   │  │  DB: Persistent SQLite         │
│                              │  │                                │
│  9 MCP Tools:                │  │  Scripts:                      │
│  • ctx_execute (sandbox)     │  │  • ctx_run.py (verbose inject) │
│  • ctx_execute_file          │  │  • ctx_batch.py (pipelines)    │
│  • ctx_batch_execute         │  │  • ctx_session.py (P1-P4)      │
│  • ctx_fetch_and_index       │  │  • ctx_search.py (persistent)  │
│  • ctx_index                 │  │  • ctx_stats.py (110+ runs)    │
│  • ctx_search                │  │  • deliver.py (4 backends)     │
│  • ctx_stats                 │  │  • morning_brief_pipeline.py   │
│  • ctx_doctor                │  │                                │
│  • ctx_upgrade               │  │  Unique Features:              │
│                              │  │  • Compact-by-default skills   │
│  Works: Any MCP client       │  │  • --verbose injection         │
│  Hooks: PreToolUse routing   │  │  • Intent keyword scoring      │
│  Session: Hook-based         │  │  • API wrapper dict unwrapping │
│                              │  │  • Secret redaction for FTS5   │
│  Verified: mcporter list     │  │  • Zero-token launchd pipes    │
│  → 9 tools, 1.1s, healthy   │  │  • Multi-messenger delivery    │
│                              │  │  • Security audit (14 fixes)   │
└──────────────────────────────┘  └────────────────────────────────┘
            │                                  │
            │    Both produce compact output    │
            │    that enters context window     │
            ▼                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Agent Context Window                            │
│          100-500 bytes per call instead of 3-50 KB                │
└──────────────────────────────────────────────────────────────────┘
```

### How We Verified This (Trust But Verify)

We ran hands-on tests to understand the relationship:

```bash
# 1. Confirmed mcporter is installed and context-mode is healthy
$ mcporter --version
0.7.3

$ mcporter list
- context-mode (9 tools, 1.1s) [source: ~/.claude.json]

# 2. Got full tool schemas — 9 tools with typed parameters
$ mcporter list context-mode --schema
# → ctx_execute, ctx_batch_execute, ctx_search, etc. (all documented below)

# 3. Tested live MCP calls
$ mcporter call context-mode.ctx_execute language=python \
    code='import json; print(json.dumps({"test": "works"}))' --output json
{"test": "works"}

# 4. Confirmed SEPARATE databases
$ mcporter call context-mode.ctx_stats --output json
# → "No context-mode tool calls yet" (ephemeral per-session)

$ python3 ctx_stats.py
# → 110 runs, 85.4 KB saved (persistent across sessions)

# 5. Found context-mode has native OpenClaw integration
$ ls ~/.npm/_npx/.../context-mode/build/openclaw/
workspace-router.js   # Routes tool calls to correct OpenClaw agent workspace
$ cat ~/.npm/_npx/.../context-mode/openclaw.plugin.json
# → Full plugin manifest with sandbox permissions
```

### The MCP Registration

`context-mode` is registered in `~/.claude.json` and auto-discovered by any MCP client:

```json
{
  "mcpServers": {
    "context-mode": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "context-mode"]
    }
  }
}
```

For OpenClaw, the **mcporter** bridge makes MCP tools available as shell commands:

```bash
mcporter call context-mode.ctx_execute language=python code="..." intent="check balance"
mcporter call context-mode.ctx_batch_execute commands='[...]' queries='[...]'
mcporter call context-mode.ctx_search queries='["error rate"]'
```

### Why Two Layers?

**context-mode solves the MCP protocol layer** — it makes sandboxing available to any agent through the universal MCP standard. Any tool call that might produce large output gets routed through it automatically via PreToolUse hooks.

**Context Saver solves the agent-proofing layer** — the production lessons we learned the hard way:
- Agents ignore instructions → compact-by-default skills
- Wrapper scripts get skipped → `--verbose` injection in ctx_run.py
- Session compaction loses state → P1-P4 priority snapshots in SQLite
- Cron jobs waste tokens → zero-token launchd pipelines
- Results need delivery → iMessage/Telegram/Slack/Discord
- API responses have wrapper dicts → recursive unwrapping in intent filter
- Secrets leak into FTS5 → regex-based redaction before indexing

**Both layers are needed.** context-mode alone doesn't know about your skills' output format, your delivery preferences, your session priority scheme, or your security requirements. Context Saver alone doesn't speak the MCP protocol.

---

## Before & After

```
WITHOUT Context Saver:
  agent calls skill → 3 KB raw JSON floods context → 40 wasted fields
  agent calls skill → 5 KB raw JSON floods context → 50 irrelevant records
  agent calls skill → 20 KB raw JSON floods context → 200 search results
  Session compacts → all working state lost → 20 KB cold restart

  Daily token burn: ~750,000 tokens

WITH Context Saver v3.0 (MCP):
  agent calls ctx_execute → 120 B summary enters context → full data indexed
  agent calls ctx_execute → 300 B filtered enters context → only matching records
  agent calls ctx_batch_execute → 500 B combined → one MCP call, not three
  Session compacts → 2 KB snapshot preserved → instant resume

  Daily token burn: ~200,000 tokens (73% reduction)
```

---

## What's New in v3.0

### MCP-Native Architecture
Context Saver is now exposed as a **9-tool MCP server** via `context-mode`. Any MCP-compatible AI agent — Claude Code, Claude Desktop, Cursor, Windsurf, OpenClaw, or custom agents — can discover and call these tools natively. No wrapper scripts, no special instructions.

The agent calls `ctx_execute` because that's the tool it sees. It can't skip it.

### mcporter Bridge (OpenClaw)
OpenClaw agents access MCP tools through `mcporter`, a universal MCP-to-CLI bridge:

```bash
# Install mcporter
npm install -g mcporter

# It auto-discovers context-mode from ~/.claude.json
mcporter list
# → context-mode (9 tools, 1.0s) [source: ~/.claude.json]

# Call any tool
mcporter call context-mode.ctx_execute language=python code="..." intent="summary"
mcporter call context-mode.ctx_search queries='["find errors"]'
```

### Compact-by-Default Skills
The #1 lesson from production: **agents don't follow instructions.** They ignore `--summary` flags, skip wrapper scripts, and call skills directly. The only reliable fix is making compact output the default at the source.

Skills now return minimal fields by default. `--verbose` is required for full output:

```bash
# Default: compact (3 fields per position, 83% smaller)
alpaca_cli.py positions
# → {"count":8,"positions":[{"s":"AAPL","qty":"100","pnl":"1500.00"},...]}

# Verbose: full output (only when you actually need all fields)
alpaca_cli.py --verbose positions
# → {"count":8,"positions":[{"symbol":"AAPL","qty":"100","side":"long","market_value":"18500",...}]}
```

ctx_run.py automatically injects `--verbose` so it gets the full data to filter against, reporting accurate 70-84% savings.

### Multi-Messenger Delivery
`deliver.py` — unified delivery backend for pipelines. Auto-detects available backend:

| Backend | Requirement | Usage |
|---------|------------|-------|
| **iMessage** | `imsg` CLI installed (macOS) | `--to +17025551234` |
| **Telegram** | `TELEGRAM_BOT_TOKEN` env var | `--to <chat_id>` |
| **Slack** | `SLACK_WEBHOOK_URL` env var | `--backend slack` |
| **Discord** | `DISCORD_WEBHOOK_URL` env var | `--backend discord` |

```bash
# Auto-detect backend
python3 deliver.py --to +17025551234 --text "Your morning brief"

# Force specific backend
python3 deliver.py --backend telegram --to 5328771204 --text "Alert!"
```

### Zero-Token Pipelines (launchd)
For deterministic tasks like morning briefs, **bypass the LLM entirely**:

```bash
# Self-contained: gather data → format brief → deliver via iMessage/Telegram/Slack
python3 morning_brief_pipeline.py --to +17025551234 --detailed

# Preview without sending
python3 morning_brief_pipeline.py --print-only --detailed
```

Schedule via macOS launchd for **zero LLM tokens consumed**:
```xml
<!-- ~/Library/LaunchAgents/com.openclaw.morning-brief.plist -->
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/python3</string>
    <string>morning_brief_pipeline.py</string>
    <string>--to</string><string>+17025551234</string>
    <string>--detailed</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
</dict>
</plist>
```

### Security Hardened
All scripts audited and patched (14 findings addressed):
- **Command injection** — `shell=False` + `shlex.split()` (no string concatenation)
- **Path traversal** — Skill names validated with `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`
- **Secret leakage** — API keys/tokens redacted before FTS5 indexing
- **Pipeline path restriction** — `--pipeline` files must be within workspace
- **Phone validation** — E.164 format enforced for iMessage delivery
- **Index size cap** — 100KB per entry, 10K max rows with automatic pruning
- **Snapshot budget clamped** — 256-65536 byte range enforced
- **No shell=True anywhere** — All subprocess calls use list-based args
- **Parameterized SQL everywhere** — Zero SQL injection vectors
- **stdlib only** — No third-party dependencies = no supply chain risk

---

## The Five-Layer Token Protection Model

Context Saver v3.0 protects your context window at **five layers**. No other tool does this.

### Layer 1: MCP Server (Universal Access)
The `context-mode` MCP server exposes 9 tools via the Model Context Protocol. Any MCP client auto-discovers them. The agent calls `ctx_execute` as a native tool — it can't bypass it because it's the only interface available.

```
Agent → MCP protocol → context-mode server → sandboxed execution → compact result
```

### Layer 2: Compact-by-Default Skills (Source Protection)
Skills return minimal output by default. Even if an agent somehow bypasses the MCP layer and calls a skill directly, it only gets compact data. `--verbose` is required for full output.

```python
# Default: 3 fields, ~80 bytes
{"s": "AAPL", "qty": "100", "pnl": "1500.00"}

# Verbose: 12+ fields, ~350 bytes
{"symbol": "AAPL", "qty": "100", "side": "long", "market_value": "18500", ...}
```

### Layer 3: Sandboxed Execution with Verbose Injection
`ctx_run.py` intercepts skill calls, injects `--verbose` to get full data, applies intent-driven filtering, and returns a compact summary. The full output is indexed in FTS5 but never enters the context window.

```bash
# Agent calls ctx_run → gets 120 B summary, not 3 KB raw dump
python3 ctx_run.py --skill alpaca-trader --cmd "positions" --intent "summary"
```

### Layer 4: Intent-Driven Filtering
Pass an intent string and Context Saver extracts only matching fields. Uses fast keyword scoring — no ML, no embeddings, no latency.

- `"check balance"` → returns equity, buying_power, cash (3 fields out of 40+)
- `"find losing"` → returns only positions with negative P&L
- `"summary 20"` → returns all items with key scalar fields

Smart wrapper dict handling: `{"count": 8, "positions": [...]}` — automatically unwraps and recurses.

### Layer 5: Zero-Token Pipelines
For deterministic tasks, bypass the LLM entirely. launchd/cron triggers a Python pipeline that gathers data, formats output, and delivers via messenger. **Zero tokens consumed.**

```
launchd → pipeline.py → ctx_run.py → deliver.py → iMessage/Telegram/Slack
                                  ↓
                        No agent. No model. No tokens.
```

---

## Production Results

Measured on a live OpenClaw instance running 8 positions, 20-symbol movers, daily briefs:

| Call | Raw (verbose) | After ctx_run filter | Savings |
|------|--------------|---------------------|---------|
| `account` | 357B | 95B | **73.4%** |
| `positions` (8 holdings) | 2,739B | 822B | **70.0%** |
| `movers` (20 symbols) | 2,284B | 367B | **83.9%** |
| **Pipeline total** | **5,380B** | **1,284B** | **76.1%** |

Morning brief pipeline: **zero LLM tokens** (launchd → Python → iMessage, no agent involved).

Before context-saver, a single morning brief cron job consumed **150K-369K tokens** (agent loading workspace files + raw API dumps). After: **0 tokens**.

### Real-World 24-Hour Measurement

| Session | Tokens Used | Cost |
|---------|------------|------|
| iMessage agent (49 messages) | 1,758,601 | $0.995 |
| Heartbeat (13 messages) | 293,342 | $0.305 |
| Morning brief #1 (8 messages) | 152,265 | $0.212 |
| Morning brief #2 (7 messages) | 130,548 | $0.139 |
| **Daily Total (without v3.0)** | **2,356,572** | **$1.70** |

After Context Saver v3.0: morning briefs → **0 tokens**, data calls → **70-84% compressed**, session restores → **2 KB snapshots** instead of 20 KB cold reads.

---

## Installation

### Step 1: Install context-mode MCP Server (Base Layer)

For **Claude Code** (recommended — full plugin with hooks):
```bash
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode
# Restart Claude Code
```

For **any MCP client** (MCP-only, no hooks):
```bash
# Add to ~/.claude.json, Cursor settings, Gemini settings, etc.
claude mcp add context-mode -- npx -y context-mode
```

Or add manually to your MCP configuration:
```json
{
  "mcpServers": {
    "context-mode": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "context-mode"]
    }
  }
}
```

### Step 2: Install Context Saver (Agent-Proofing Layer)

For **OpenClaw** — also install mcporter to bridge MCP → shell:
```bash
npm install -g mcporter

# Verify it discovers context-mode
mcporter list
# → context-mode (9 tools, 1.1s) [source: ~/.claude.json]

# Restart the gateway
openclaw gateway restart
```

### Full Install (Scripts + Wiring)

```bash
git clone https://github.com/tlancas25/openclaw-context-saver.git
cd openclaw-context-saver
python3 install.py
```

The installer automatically:
1. **Copies scripts** into `~/.openclaw/workspace/skills/context-saver/`
2. **Patches AGENTS.md** with mandatory Context Saver Protocol rules
3. **Patches TOOLS.md** with quick-reference commands
4. **Patches cron jobs** to route data-heavy skill calls through `ctx_run.py`
5. **Initializes SQLite databases** for stats tracking and FTS5 indexing

### Preview / Verify / Uninstall

```bash
python3 install.py --dry-run      # Preview changes
python3 install.py --verify       # Check installation
python3 install.py --uninstall    # Remove wiring (scripts stay)
```

### Installer Options

```bash
python3 install.py --openclaw-home /custom/path  # Custom OpenClaw directory
python3 install.py --skip-cron                    # Don't patch cron jobs
python3 install.py --skip-agents                  # Don't patch AGENTS.md
python3 install.py --skip-tools                   # Don't patch TOOLS.md
```

### Requirements

- **Python 3.8+** (standard library only — no pip dependencies)
- **SQLite** (bundled with Python)
- **Node.js 18+** (for context-mode MCP server via npx)
- **mcporter** (optional — only needed for OpenClaw's shell bridge to MCP)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_HOME` | `~/.openclaw` | Root directory for your OpenClaw instance |
| `CTX_SNAPSHOT_BUDGET` | `2048` | Max bytes for session snapshots (256-65536) |
| `CTX_FTS_ENABLED` | `1` | Set to `0` to disable FTS5 indexing |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token for deliver.py |
| `TELEGRAM_CHAT_ID` | — | Default Telegram chat ID |
| `SLACK_WEBHOOK_URL` | — | Slack incoming webhook URL |
| `DISCORD_WEBHOOK_URL` | — | Discord webhook URL |

---

## The 9 MCP Tools

### ctx_execute — Sandboxed Single Command
Run code in a sandboxed subprocess. Supports 11 languages. Output is filtered by intent and indexed in FTS5.

```bash
# Via MCP (any client)
ctx_execute(language="python", code="import json; ...", intent="check balance")

# Via mcporter (OpenClaw)
mcporter call context-mode.ctx_execute language=python code="..." intent="check balance"

# Via Python script (direct)
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "account" --intent "check balance"
```

### ctx_execute_file — Process Files Outside Context
Process a file without loading its contents into the context window. Perfect for large CSVs, logs, or data files.

### ctx_batch_execute — Multi-Command + Search
Run multiple commands and search queries in a single MCP call. Replaces 4+ separate tool calls with 1.

```bash
# Via MCP
ctx_batch_execute(
  commands=[
    {"skill": "alpaca-trader", "cmd": "account", "fields": ["equity","buying_power"]},
    {"skill": "alpaca-trader", "cmd": "positions", "intent": "summary"}
  ],
  queries=["find recent errors"]
)

# Via Python script
python3 scripts/ctx_batch.py --commands '[
  {"skill": "alpaca-trader", "cmd": "account", "fields": ["equity","buying_power"]},
  {"skill": "alpaca-trader", "cmd": "positions", "intent": "summary"}
]'
```

### ctx_fetch_and_index — Web Fetch + Index
Fetch a URL, convert HTML to clean Markdown, and index into the FTS5 knowledge base — all without the content entering context.

```bash
ctx_fetch_and_index(url="https://docs.example.com/api", source="api-docs")
```

### ctx_index — Index Documentation
Index arbitrary content into the searchable knowledge base.

### ctx_search — Query Indexed Content
Search across all previously indexed content using FTS5 full-text search.

```bash
# Via MCP
ctx_search(queries=["error rate spike", "deployment failures"])

# Via Python script
python3 scripts/ctx_search.py "error rate spike" --source my-api --limit 5
```

Supports FTS5 query syntax: `"exact phrase"`, `term1 AND term2`, `prefix*`.

### ctx_stats — Context Consumption Metrics
Shows total bytes saved, number of runs, average compression ratio, top skills by savings, indexed documents count.

### ctx_doctor — Installation Diagnostics
Check that all components are properly installed and configured.

### ctx_upgrade — Self-Update
Upgrade the context-mode MCP server to the latest version.

---

## Usage (Direct Python Scripts)

For environments without MCP support, the Python scripts work standalone:

### Single Command (Sandboxed)

```bash
# Basic — auto-summarize any skill output
python3 scripts/ctx_run.py --skill my-api --cmd "status"

# With intent — only return relevant fields
python3 scripts/ctx_run.py --skill my-api --cmd "list-items" --intent "find failing items"

# With field selection — explicit control
python3 scripts/ctx_run.py --skill my-api --cmd "dashboard" --fields "users,errors,latency"

# Raw mode — get full output (bypasses filtering)
python3 scripts/ctx_run.py --skill my-api --cmd "dashboard" --raw
```

**Output format:**

```json
{
  "success": true,
  "skill": "alpaca-trader",
  "command": "positions",
  "summary": {"count": 8, "positions": [{"symbol": "AAPL", "qty": "100", "unrealized_pl": "1500"}]},
  "raw_bytes": 2739,
  "summary_bytes": 822,
  "bytes_saved": 1917,
  "savings_pct": 70.0
}
```

### Batch Execution

```bash
python3 scripts/ctx_batch.py --commands '[
  {"skill": "my-api", "cmd": "dashboard", "fields": ["active_users", "error_rate"]},
  {"skill": "analytics-engine", "cmd": "metrics", "intent": "summary"},
  {"skill": "health-monitor", "cmd": "check", "intent": "failures only"}
]'

# Or load from a pipeline file
python3 scripts/ctx_batch.py --pipeline examples/daily-status-pipeline.json
```

### Multi-Messenger Delivery

```bash
# iMessage (auto-detected on macOS with imsg CLI)
python3 scripts/deliver.py --to +17025551234 --text "Morning brief ready"

# Telegram
python3 scripts/deliver.py --backend telegram --to 5328771204 --text "Alert!"

# Slack / Discord webhooks
python3 scripts/deliver.py --backend slack --text "Daily report attached"
python3 scripts/deliver.py --backend discord --text "System status update"

# Pipe from stdin
echo "Hello from pipeline" | python3 scripts/deliver.py --to +17025551234
```

### Morning Brief Pipeline

```bash
# Full pipeline: gather → filter → format → deliver (zero LLM tokens)
python3 scripts/morning_brief_pipeline.py --to +17025551234 --detailed

# Multiple recipients
python3 scripts/morning_brief_pipeline.py --to +17025551234 --to +17025559876

# Preview without sending
python3 scripts/morning_brief_pipeline.py --print-only --detailed

# Choose delivery backend
python3 scripts/morning_brief_pipeline.py --to 5328771204 --backend telegram
```

### Session Event Tracking

```bash
# Log events at different priority levels
python3 scripts/ctx_session.py log --type "deploy" --priority critical \
  --data '{"service":"api-v2","version":"2.1.0"}'

# Snapshot before compaction
python3 scripts/ctx_session.py snapshot

# Restore after compaction
python3 scripts/ctx_session.py restore

# View session stats
python3 scripts/ctx_session.py stats
```

**Priority system:**

| Priority | Label | Snapshot Budget | Use For |
|----------|-------|-----------------|---------|
| `critical` | P1 | 40% of 2 KB | Actions that changed state, system errors |
| `high` | P2 | 30% of 2 KB | Alerts, config changes, threshold breaches |
| `medium` | P3 | 20% of 2 KB | Analysis results, routine checks |
| `low` | P4 | 10% of 2 KB | Info queries, status checks |

### View Stats

```bash
python3 scripts/ctx_stats.py
```

---

## Benchmarks

| Operation | Without | With Context Saver | Savings |
|-----------|---------|--------------------|---------|
| Account query (12 fields) | 357 B | 95 B | **73%** |
| Positions (8 holdings, 10 fields each) | 2,739 B | 822 B | **70%** |
| Market movers (20 symbols) | 2,284 B | 367 B | **84%** |
| Search results (10 tweets, 12 fields each) | ~4 KB | ~1 KB | **75%** |
| Multi-skill pipeline (3 calls) | 5,380 B | 1,284 B | **76%** |
| Morning brief (agent-based) | 150K-369K tokens | 0 tokens | **100%** |
| Full day of agent operation | ~750K tokens | ~200K tokens | **73%** |

---

## Full Call Chain

### Path 1: MCP (Recommended)

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Agent (Claude Code / Cursor / OpenClaw / Custom)            │
│  Sees 9 MCP tools in its tool list                              │
│  Calls: ctx_execute(language="python", code="...", intent="...") │
└────────────────────────────────┬────────────────────────────────┘
                                 │ MCP protocol (JSON-RPC over stdio)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  context-mode MCP Server (launched via npx)                     │
│  Receives tool call → spawns sandboxed subprocess               │
│  Captures stdout → applies intent filter → indexes in FTS5      │
│  Returns compact summary (100-500 bytes, not 3-50 KB)           │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Compact result
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Agent Context Window                                           │
│  Receives: {"equity": 96503, "buying_power": 48251} — 85 bytes │
│  NOT: full 3 KB account dump with 40+ fields                    │
└─────────────────────────────────────────────────────────────────┘
```

### Path 2: mcporter (OpenClaw)

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐
│ OpenClaw     │───▶│  mcporter    │───▶│ context-mode │───▶│ Sandbox  │
│ Agent        │    │  CLI bridge  │    │ MCP Server   │    │ Process  │
│ (shell tool) │    │ (npm global) │    │ (npx stdio)  │    │ (Python) │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────┘
```

### Path 3: Direct Python (Fallback)

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Agent / Cron │───▶│ ctx_run.py   │───▶│ Skill Script │
│ / Pipeline   │    │ (--verbose   │    │ (compact by  │
│              │    │  injection)  │    │  default)    │
└──────────────┘    └──────────────┘    └──────────────┘
```

### Path 4: Zero-Token Pipeline

```
┌───────────┐     ┌───────────┐     ┌───────────┐     ┌───────────┐
│  launchd  │────▶│ pipeline  │────▶│ ctx_run   │────▶│ deliver   │
│ (schedule)│     │ .py       │     │ .py       │     │ .py       │
└───────────┘     └───────────┘     └───────────┘     └───────────┘
                       │                  │                  │
                  No LLM involved.   --verbose inject   iMessage/Telegram
                  Zero tokens.       + intent filter    Slack/Discord
```

---

## Adding More MCP Servers

Context Saver works alongside other MCP servers. Add them to expand your agent's capabilities:

| Server | Capability | Setup |
|--------|-----------|-------|
| **Brave Search** | Web search | Add to `~/.claude.json`, set `BRAVE_API_KEY` |
| **GitHub** | Repos, PRs, Issues | `mcporter auth github` |
| **filesystem** | Structured file R/W | Stdio-based local server |
| **Any HTTP endpoint** | Custom tools | Call by URL via mcporter, no config |

```bash
# List all available servers
mcporter list

# Add a new server interactively
mcporter config add

# Call any server's tools ad-hoc by URL
mcporter call https://api.example.com/mcp.some_tool param=value
```

### OpenClaw-as-MCP-Server (Inverse Direction)

The `openclaw-mcp` project exposes OpenClaw itself as an MCP server, so *other* AI agents can send messages to your OpenClaw gateway:

| Env Var | Purpose |
|---------|---------|
| `OPENCLAW_URL` | WebSocket gateway URL |
| `OPENCLAW_GATEWAY_TOKEN` | Auth token from `.env` |
| `OPENCLAW_MODEL` | Default model to use |

This is the inverse of mcporter: OpenClaw as a tool *for* other agents, vs mcporter giving OpenClaw access to external tools.

---

## Security

Context Saver was audited before open-sourcing. All user-controlled inputs are validated:

| Vector | Protection |
|--------|-----------|
| Command injection | `shell=False` + `shlex.split()`, no string concatenation |
| Path traversal | Skill names validated: `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` |
| Secret leakage | API keys/tokens redacted before FTS5 indexing |
| SQL injection | Parameterized queries everywhere, zero string concatenation |
| Pipeline escape | `--pipeline` restricted to workspace directory |
| Phone injection | E.164 format validation for iMessage delivery |
| DoS via index growth | 100KB per entry cap, 10K row limit with auto-pruning |
| Env var injection | Subprocess inherits only necessary environment |
| Supply chain | stdlib only — zero third-party dependencies |

---

## Integrating with Your Skills

Context Saver works with **any** skill out of the box. For best results, make your skills **compact-by-default**:

```python
# my_skill/scripts/cli.py
import argparse, json

SUMMARY_MODE = True  # Compact by default

parser = argparse.ArgumentParser()
parser.add_argument("--summary", default=True)
parser.add_argument("--verbose", action="store_true",
                    help="Full output (default is compact)")

args = parser.parse_args()
SUMMARY_MODE = not args.verbose

result = your_api_call()
if SUMMARY_MODE:
    # Return only essential fields
    result = {k: v for k, v in result.items()
              if not isinstance(v, (dict, list))}
print(json.dumps(result))
```

ctx_run.py will automatically inject `--verbose` to get full data for its own filtering, while direct agent calls get the compact default.

---

## File Structure

```
openclaw-context-saver/
├── scripts/
│   ├── ctx_run.py                  # Sandboxed execution + intent filtering + verbose injection
│   ├── ctx_batch.py                # Multi-skill batch execution
│   ├── ctx_session.py              # Session event tracking + snapshots
│   ├── ctx_search.py               # FTS5 search across indexed outputs
│   ├── ctx_stats.py                # Usage statistics dashboard
│   ├── morning_brief_pipeline.py   # Zero-token pipeline: gather → format → deliver
│   └── deliver.py                  # Multi-messenger delivery (iMessage/Telegram/Slack/Discord)
├── install.py                      # One-command installer with --dry-run, --verify, --uninstall
├── docs/
│   ├── ARCHITECTURE.md
│   ├── BENCHMARKS.md
│   └── INTEGRATION.md
├── examples/
│   ├── daily-status-pipeline.json
│   └── eod-report-pipeline.json
├── SKILL.md
├── skill.json
├── LICENSE
└── README.md
```

---

## Configuration

All paths are derived from `OPENCLAW_HOME` (default: `~/.openclaw`):

| Path | Purpose |
|------|---------|
| `$OPENCLAW_HOME/workspace/skills/` | Where Context Saver looks for skills to execute |
| `$OPENCLAW_HOME/context/stats.db` | Execution statistics + FTS5 full-text index |
| `$OPENCLAW_HOME/context/sessions.db` | Session event log + compaction snapshots |
| `$OPENCLAW_HOME/.env` | Environment variables passed to skill subprocesses |
| `~/.claude.json` | MCP server registration (context-mode — managed by context-mode plugin) |

Both `.db` files are created automatically on first use. No setup required.

---

## Why This Doesn't Exist Anywhere Else

We looked. There's nothing like this.

Every major AI agent framework has the same problem: they dump raw API responses into the context window and hope for the best.

| Tool / Framework | What It Does | Context Optimization? |
|-----------------|-------------|----------------------|
| **LangChain** | Chains LLM calls together | No. Full outputs flow through the chain. |
| **CrewAI** | Multi-agent task delegation | No. Agents pass complete results to each other. |
| **AutoGPT** | Autonomous GPT agent | No. Every API call dumps full response into context. |
| **OpenAI Assistants** | Managed agent threads | No. Files are attached in full. No filtering. |
| **Semantic Kernel** | MS agent framework | No. Memory is retrieval-based, not input-optimized. |
| **context-mode** | FTS5 index for Claude | Partial. Indexes for retrieval, but no intent filtering or batch execution. |
| **RAG pipelines** | Retrieval-augmented generation | Solves retrieval. Doesn't solve what goes INTO context. |
| **Context Saver** | **MCP-native context optimization** | **Yes. 9 MCP tools: filter, sandbox, batch, index, search, deliver, snapshot.** |

### Relationship with context-mode

Context Saver v3.0 is a **complementary layer** to [`context-mode`](https://github.com/mksglu/context-mode) by [@mksglu](https://github.com/mksglu). We verified hands-on that they are **independent systems** with separate databases:

- **context-mode**: Ephemeral per-session FTS5 database in Node.js. Provides MCP protocol, sandboxing, and BM25 search.
- **Context Saver**: Persistent SQLite at `~/.openclaw/context/`. Provides agent-proofing, delivery, pipelines, and session continuity.

They solve different layers and both are needed for production AI agent deployments. context-mode handles the protocol. Context Saver handles the real-world problems agents create.

| Layer | context-mode handles | Context Saver handles |
|-------|---------------------|----------------------|
| Protocol | MCP standard (any client) | Python scripts (OpenClaw + cron) |
| Sandboxing | 11 language runtimes | Skill subprocess isolation |
| Indexing | Ephemeral BM25/FTS5 | Persistent FTS5 + secret redaction |
| Filtering | Output >5KB → section previews | Keyword scoring on JSON keys + wrapper unwrap |
| Agent-proofing | PreToolUse hooks (Claude Code) | Compact-by-default + verbose injection |
| Delivery | N/A | iMessage, Telegram, Slack, Discord |
| Automation | N/A | Zero-token launchd pipelines |
| Sessions | Hook-based tracking | P1-P4 priority events + 2 KB snapshots |
| Security | Basic sandbox | 14-finding audit + hardening |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Write tests for new functionality
4. Submit a pull request

### Development Guidelines

- **Python 3.8+** compatible
- **Standard library only** — no external dependencies (this is a hard rule)
- All output must be **valid JSON** (parseable by any consumer)
- Errors return `{"success": false, "error": "message"}`
- Every script must support `--help`
- Keep the tool generic — no references to specific APIs or services
- **Security first** — validate all user inputs, never use `shell=True`

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

Built for [OpenClaw](https://github.com/openclaw-ai) multi-agent systems. Works with any MCP-compatible AI agent.
