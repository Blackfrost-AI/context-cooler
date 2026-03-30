# OpenClaw Context Saver v4.5

**Standalone MCP server for AI agent context optimization. Cut token usage by 70-98%. Built from scratch on the Model Context Protocol — works with Claude Code, Cursor, Gemini CLI, OpenClaw, and any MCP-compatible agent.**

Every AI agent framework has the same problem: they dump full API responses into the context window. A single Playwright snapshot costs 56 KB. Twenty GitHub issues cost 59 KB. One access log — 45 KB. After 30 minutes, 40% of your context is gone.

Context Saver v4.5 is a **standalone Node.js MCP server** with 10 tools: sandboxed execution in 11 languages, intent-driven filtering, FTS5 knowledge indexing, P1-P4 session continuity, multi-messenger delivery (iMessage, Telegram, Slack, Discord), and secret redaction — all in one self-contained package.

---

## Installation & Updates

### macOS / Linux

**First-time install:**
```bash
git clone https://github.com/tlancas25/openclaw-context-saver.git
cd openclaw-context-saver
python3 install.py
```

**Update to the latest version:**
```bash
cd openclaw-context-saver
python3 install.py --update
```

### Windows

**First-time install:**
```powershell
git clone https://github.com/tlancas25/openclaw-context-saver.git
cd openclaw-context-saver
python install.py
```

**Update to the latest version:**
```powershell
cd openclaw-context-saver
python install.py --update
```

> **Windows notes:** iMessage delivery is macOS-only. Telegram, Slack, and Discord work on all platforms. For full shell sandboxing support, install WSL (`wsl --install`) and run the installer from inside WSL.

### Installer Options

```bash
python3 install.py --dry-run            # Preview changes without writing
python3 install.py --verify             # Check installation status
python3 install.py --uninstall          # Remove context-saver wiring
python3 install.py --accept-disclaimer  # Skip disclaimer prompt (CI/scripts)
python3 install.py --skip-cron          # Don't patch cron jobs
python3 install.py --skip-agents        # Don't patch AGENTS.md
python3 install.py --skip-tools         # Don't patch TOOLS.md
python3 install.py --openclaw-home /custom/path  # Custom OpenClaw directory
```

### What the Installer Does

1. Builds the MCP server (`npm install` + `npx tsc`)
2. Registers `openclaw-context-saver` in `~/.claude.json` as a stdio MCP server
3. Copies scripts into `~/.openclaw/workspace/skills/context-saver/`
4. Initializes SQLite databases (`stats.db` + `sessions.db`)
5. Patches `AGENTS.md` with mandatory Context Saver Protocol rules
6. Patches `TOOLS.md` with quick-reference commands
7. Patches cron jobs to route data-heavy skill calls through context-saver

### Requirements

- **Node.js 18+** (for the MCP server)
- **Python 3.8+** (for the installer and helper scripts — stdlib only, no pip dependencies)
- **SQLite** (bundled with Python and Node.js via better-sqlite3)

---

## Architecture

Context Saver is a single MCP server that any MCP-compatible agent auto-discovers. When the agent needs to run code, search data, or deliver messages, it calls our tools directly — there's nothing to skip or bypass.

```
┌──────────────────────────────────────────────────────────────────┐
│              ANY MCP-Compatible AI Agent                         │
│       Claude Code / Cursor / Gemini CLI / OpenClaw / Custom      │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                    MCP Protocol (stdio)
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│            openclaw-context-saver (Node.js MCP Server)           │
│                                                                  │
│   10 Tools:                        Core Libraries:               │
│   • ctx_execute      (sandbox)     • sandbox.ts  (11 languages)  │
│   • ctx_execute_file (file inject) • filter.ts   (intent scoring)│
│   • ctx_batch        (multi-cmd)   • db.ts       (SQLite + FTS5) │
│   • ctx_search       (FTS5 query)  • chunker.ts  (markdown/JSON) │
│   • ctx_index        (store data)  • redact.ts   (secret strip)  │
│   • ctx_fetch_index  (HTTP→index)  • env.ts      (config loader) │
│   • ctx_session      (P1-P4 state)                               │
│   • ctx_stats        (aggregation)                               │
│   • ctx_deliver      (4 backends)                                │
│   • ctx_doctor       (health check)                              │
│                                                                  │
│   Databases:                                                     │
│   • stats.db    (runs + fts_index)                               │
│   • sessions.db (events + snapshots)                             │
└──────────────────────────────────────────────────────────────────┘
                            │
                    Compact output (100-500 B)
                    instead of raw dump (3-50 KB)
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Agent Context Window                        │
│               70-98% smaller than raw API responses              │
└──────────────────────────────────────────────────────────────────┘
```

### MCP Registration

The installer registers the server in `~/.claude.json`:

```json
{
  "mcpServers": {
    "openclaw-context-saver": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/openclaw-context-saver/dist/server.js"]
    }
  }
}
```

Any MCP client (Claude Code, Cursor, Gemini CLI, etc.) auto-discovers the 10 tools and calls them natively.

---

## The 10 MCP Tools

### ctx_execute — Sandboxed Code Execution

Run code in 11 languages with intent-driven output filtering. Full output is indexed in FTS5; only the filtered summary enters the context window.

**Supported languages:** Python, Node.js, Bash, Ruby, PHP, Perl, Go, Rust, Java, C, TypeScript

```
ctx_execute(language="python", code="...", intent="check balance")
→ 120 B summary instead of 3 KB raw dump
```

### ctx_execute_file — File-Aware Execution

Same as `ctx_execute` but injects a file's content as a variable (`FILE_CONTENT`) into the execution environment.

### ctx_batch — Multi-Command Pipeline

Run multiple commands and/or search queries in a single MCP call. Each command is executed sequentially with its own intent filter.

```
ctx_batch(commands=[
  {"language": "python", "code": "...", "intent": "summary"},
  {"language": "bash", "code": "...", "intent": "top 5"}
], queries=["previous error rates"])
```

### ctx_search — FTS5 Knowledge Base Query

Search previously indexed data using SQLite FTS5 with BM25 ranking. Supports phrase matching, boolean operators, and prefix queries.

```
ctx_search(queries=["deployment errors", "position changes"])
```

### ctx_index — Store Data in Knowledge Base

Index content (text, JSON, or file paths) into FTS5 with automatic chunking. Markdown is chunked by headings, JSON by key paths, plain text by 50-line blocks. 4096 byte max per chunk, 100KB per entry, 10K max rows with auto-pruning.

### ctx_fetch_index — HTTP Fetch + Index

Fetch a URL, convert HTML to markdown (via Turndown), and index the content. Follows redirects, enforces 1MB cap.

```
ctx_fetch_index(url="https://docs.example.com/api", label="API docs")
```

### ctx_session — Session Continuity

Log events with P1-P4 priority, take snapshots before compaction, and restore state after. Snapshots fit within a strict 2KB budget (40% P1 / 30% P2 / 20% P3 / 10% P4).

```
ctx_session(action="log", event_type="decision", priority="high", data={...})
ctx_session(action="snapshot")   # Before compaction
ctx_session(action="restore")    # After compaction
ctx_session(action="stats")      # Event counts and sizes
```

### ctx_stats — Usage Aggregation

Aggregate stats across both `stats.db` and `sessions.db`. Shows total runs, bytes saved, compression ratios, and session event counts.

### ctx_deliver — Multi-Messenger Delivery

Send messages via iMessage (macOS), Telegram, Slack, or Discord. Auto-detects available backend based on environment variables.

| Backend | Requirement | Platform |
|---------|------------|----------|
| **iMessage** | `imsg` CLI | macOS only |
| **Telegram** | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | All |
| **Slack** | `SLACK_WEBHOOK_URL` | All |
| **Discord** | `DISCORD_WEBHOOK_URL` | All |

### ctx_doctor — Health Check

Checks OPENCLAW_HOME, databases, FTS5 tables, skills directory, 5 language runtimes, mcporter availability, and all 4 delivery backends. Returns a pass/fail report.

---

## Token Protection Layers

### Layer 1: Sandboxed Execution + Filtering

Every code execution goes through `ctx_execute`. The full output is captured, filtered by intent, and indexed. Only the compact summary (100-500 bytes) enters the context window.

```
Agent → ctx_execute → sandbox (11 langs) → intent filter → 120 B summary
                                     ↓
                              FTS5 index (full data preserved)
```

### Layer 2: Compact-by-Default Skills

Skills return minimal output by default. `--verbose` is required for full data. `ctx_execute` auto-injects `--verbose` so it gets the full data to filter, but only returns the compact result.

```python
# Default: 3 fields per item (~80 bytes)
{"s": "AAPL", "qty": "100", "pnl": "1500.00"}

# Verbose (only ctx_execute sees this): 12+ fields (~350 bytes)
{"symbol": "AAPL", "qty": "100", "side": "long", "market_value": "18500", ...}
```

### Layer 3: Intent-Driven Filtering

Pass an intent string and Context Saver extracts only matching fields using fast keyword scoring:

- `"check balance"` → returns equity, buying_power, cash (3 fields out of 40+)
- `"find losing"` → returns only positions with negative P&L
- `"top 5 movers"` → returns top 5 items sorted by change

Smart wrapper dict handling: `{"count": 8, "positions": [...]}` → automatically unwraps and recurses.

### Layer 4: Session Continuity

P1-P4 priority events survive conversation compaction via 2KB snapshots stored in SQLite. Critical decisions and alerts are always preserved; informational queries are dropped first.

### Layer 5: Zero-Token Pipelines

For deterministic tasks, bypass the LLM entirely. Schedule pipelines via launchd/cron:

```
launchd → python3 pipeline.py → ctx_execute → ctx_deliver → iMessage/Telegram
                              No agent. No model. No tokens.
```

---

## Production Results

Measured on a live OpenClaw instance running 8 positions, 20-symbol movers, daily briefs:

| Call | Raw Output | After Filtering | Savings |
|------|-----------|----------------|---------|
| `account` | 357 B | 95 B | **73.4%** |
| `positions` (8 holdings) | 2,739 B | 822 B | **70.0%** |
| `movers` (20 symbols) | 2,284 B | 367 B | **83.9%** |
| **Pipeline total** | **5,380 B** | **1,284 B** | **76.1%** |

Zero-token morning brief pipeline: launchd triggers Python directly — **no LLM tokens consumed**.

### Before & After

```
WITHOUT Context Saver:
  agent calls skill → 3 KB raw JSON floods context → 40 wasted fields
  agent calls skill → 5 KB raw JSON floods context → 50 irrelevant records
  agent calls skill → 20 KB raw JSON floods context → 200 search results
  Session compacts → all working state lost → 20 KB cold restart
  Daily token burn: ~750,000 tokens

WITH Context Saver v4.5:
  agent calls ctx_execute → 120 B summary enters context → full data indexed
  agent calls ctx_execute → 300 B filtered enters context → only matching records
  agent calls ctx_batch → 500 B combined → one MCP call, not three
  Session compacts → 2 KB snapshot preserved → instant resume
  Daily token burn: ~200,000 tokens (73% reduction)
```

---

## Security

All code is audited and hardened:

- **Sandboxed execution** — Subprocess isolation with env var denylist (30+ dangerous vars), process group kills on Unix, 100MB output cap
- **No shell=True** — All subprocess calls use list-based args (`shell=False`)
- **Secret redaction** — API keys, Bearer tokens, Stripe/Alpaca prefixes, and long base64 strings stripped before FTS5 indexing
- **Path traversal protection** — Skill names validated with `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`
- **Index size caps** — 100KB per entry, 10K max rows with automatic pruning
- **Parameterized SQL** — Zero SQL injection vectors
- **Snapshot budget clamped** — 256-65536 byte range enforced
- **Phone validation** — E.164 format enforced for iMessage delivery
- **No third-party runtime dependencies** — Node.js stdlib + better-sqlite3 + @modelcontextprotocol/sdk only

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_HOME` | `~/.openclaw` | Root directory for OpenClaw |
| `CTX_SNAPSHOT_BUDGET` | `2048` | Max bytes for session snapshots (256-65536) |
| `CTX_FTS_ENABLED` | `1` | Set to `0` to disable FTS5 indexing |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token for ctx_deliver |
| `TELEGRAM_CHAT_ID` | — | Default Telegram chat ID |
| `SLACK_WEBHOOK_URL` | — | Slack incoming webhook URL |
| `DISCORD_WEBHOOK_URL` | — | Discord webhook URL |

---

## Project Structure

```
openclaw-context-saver/
├── src/
│   ├── server.ts           # MCP server entry point (stdio transport)
│   ├── tools/
│   │   ├── execute.ts      # ctx_execute — sandboxed execution
│   │   ├── execute-file.ts # ctx_execute_file — file-aware execution
│   │   ├── batch.ts        # ctx_batch — multi-command pipeline
│   │   ├── search.ts       # ctx_search — FTS5 knowledge query
│   │   ├── index.ts        # ctx_index — content indexing
│   │   ├── fetch-index.ts  # ctx_fetch_index — HTTP fetch + index
│   │   ├── session.ts      # ctx_session — P1-P4 session continuity
│   │   ├── stats.ts        # ctx_stats — usage aggregation
│   │   ├── deliver.ts      # ctx_deliver — multi-messenger delivery
│   │   └── doctor.ts       # ctx_doctor — health check
│   └── lib/
│       ├── sandbox.ts      # Subprocess runner (11 languages)
│       ├── filter.ts       # Intent-driven keyword scoring
│       ├── db.ts           # SQLite + FTS5 connection management
│       ├── chunker.ts      # Markdown/JSON/text chunking
│       ├── redact.ts       # Secret redaction patterns
│       └── env.ts          # Environment and config loader
├── install.py              # Cross-platform installer
├── package.json            # Node.js dependencies
├── tsconfig.json           # TypeScript configuration
├── skill.json              # MCP server manifest
└── docs/
    └── ARCHITECTURE.md     # Detailed architecture documentation
```

---

## License

MIT
