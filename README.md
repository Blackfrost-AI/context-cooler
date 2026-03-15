# OpenClaw Context Saver

**The first tool built specifically to solve the AI agent context window waste problem. Cut your agent's token usage by 70-98%. Zero dependencies. Drop-in install.**

No other tool does this. Every AI agent framework — AutoGPT, CrewAI, LangChain, OpenAI Assistants — dumps full API responses into the context window and burns through tokens. Nobody built a solution. So we did.

Your agent calls an API skill and gets back 3-50 KB of raw JSON. It needed 120 bytes. The rest? Wasted tokens burning through your context window. Every single call. Every single day. That's thousands of dollars in unnecessary API costs for production agent systems.

Context Saver is **the first purpose-built context optimization layer for AI agents**. It fixes this with four mechanisms: **sandboxed execution**, **intent-driven filtering**, **compact-by-default skills**, and **session continuity** — all in pure Python with no external dependencies.

> **Why does this matter?** Because context windows are the #1 bottleneck for autonomous AI agents. Models get slower, dumber, and more expensive as context fills up. Every framework talks about RAG and embeddings for *retrieval* — but nobody optimized what goes *into* the context in the first place. Until now.

---

## Before & After

```
WITHOUT Context Saver:
  agent calls skill → 3 KB raw JSON floods context → 40 wasted fields
  agent calls skill → 5 KB raw JSON floods context → 50 irrelevant records
  agent calls skill → 20 KB raw JSON floods context → 200 search results
  Session compacts → all working state lost → 20 KB cold restart

  Daily token burn: ~750,000 tokens

WITH Context Saver:
  agent calls ctx_run → 120 B summary enters context → full data indexed for later
  agent calls ctx_run → 300 B filtered enters context → only matching records
  agent calls ctx_batch → 500 B combined enters context → one call, not three
  Session compacts → 2 KB snapshot preserved → instant resume

  Daily token burn: ~200,000 tokens (73% reduction)
```

---

## What's New in v2.0

### Compact-by-Default Skills
The #1 lesson from production: **agents don't follow instructions.** They ignore `--summary` flags, skip wrapper scripts, and call skills directly. The only reliable fix is making compact output the default at the source.

Skills now return minimal fields by default. `--verbose` is required for full output:

```bash
# Default: compact (3 fields per position, 83% smaller)
alpaca_cli.py positions
→ {"count":8,"positions":[{"s":"AAPL","qty":"100","pnl":"1500.00"},...]}

# Verbose: full output (only when you actually need all fields)
alpaca_cli.py --verbose positions
→ {"count":8,"positions":[{"symbol":"AAPL","qty":"100","side":"long","market_value":"18500",...}]}
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

# Pipe from stdin
echo "Hello" | python3 deliver.py --to +17025551234
```

### Zero-Token Pipelines (launchd)
For deterministic tasks like morning briefs, **bypass the LLM entirely**:

```bash
# Self-contained: gather data → format brief → deliver via iMessage/Telegram/Slack
python3 morning_brief_pipeline.py --to +17025551234 --detailed

# Preview without sending
python3 morning_brief_pipeline.py --print-only --detailed

# JSON output for pipeline consumers
python3 morning_brief_pipeline.py --json
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

---

## Installation

### One-Command Install (Recommended)

```bash
git clone https://github.com/tlancas25/openclaw-context-saver.git
cd openclaw-context-saver
python3 install.py
```

That's it. The installer automatically:
1. **Copies scripts** into `~/.openclaw/workspace/skills/context-saver/`
2. **Patches AGENTS.md** with mandatory Context Saver Protocol rules
3. **Patches TOOLS.md** with quick-reference commands
4. **Patches cron jobs** to route data-heavy skill calls through `ctx_run.py`
5. **Initializes SQLite databases** for stats tracking and FTS5 indexing

No pip install, no node_modules, no build step. Pure Python standard library.

### Preview Before Installing

```bash
python3 install.py --dry-run
```

### Verify Installation

```bash
python3 install.py --verify
```

### Uninstall

```bash
python3 install.py --uninstall
```

Removes all wiring from AGENTS.md, TOOLS.md, and cron jobs. Scripts remain in place.

### Installer Options

```bash
python3 install.py --openclaw-home /custom/path  # Custom OpenClaw directory
python3 install.py --skip-cron                    # Don't patch cron jobs
python3 install.py --skip-agents                  # Don't patch AGENTS.md
python3 install.py --skip-tools                   # Don't patch TOOLS.md
```

### Manual Install (Alternative)

If you prefer manual control:

```bash
git clone https://github.com/tlancas25/openclaw-context-saver.git
cp -r openclaw-context-saver ~/.openclaw/workspace/skills/context-saver
```

Then follow the [Wiring Into Your Agent](#wiring-into-your-agent-important) section below to manually configure your agent.

### Requirements

- **Python 3.8+** (standard library only — no pip dependencies)
- **SQLite** (bundled with Python)
- **OpenClaw** instance with a `workspace/skills/` directory

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

## Wiring Into Your Agent (IMPORTANT)

Context Saver doesn't work automatically — you need to tell your agent to route skill calls through it. Here's how:

### For Cron Jobs / Scheduled Tasks

Instead of telling your agent to call skills directly:

```
❌ "Use alpaca-trader skill to get account and positions"
```

Tell it to wrap calls through context-saver:

```
✅ "Use context-saver to wrap ALL skill calls:
    python3 workspace/skills/context-saver/scripts/ctx_run.py \
      --skill alpaca-trader --cmd 'account' \
      --fields 'equity,buying_power,cash,day_pnl'
    python3 workspace/skills/context-saver/scripts/ctx_run.py \
      --skill alpaca-trader --cmd 'positions' --intent 'summary'"
```

Or use batch mode for multiple calls in one shot:

```
✅ python3 workspace/skills/context-saver/scripts/ctx_batch.py --commands '[
    {"skill": "alpaca-trader", "cmd": "account", "fields": ["equity","buying_power"]},
    {"skill": "alpaca-trader", "cmd": "positions", "intent": "summary"},
    {"skill": "alpaca-trader", "cmd": "movers", "intent": "top 5"}
  ]'
```

### For Deterministic Tasks (Best Approach)

**Don't use an agent at all.** For tasks like morning briefs that don't need reasoning, use a self-contained pipeline script scheduled via launchd/cron:

```bash
# Zero tokens — pure Python pipeline
python3 morning_brief_pipeline.py --to +17025551234 --to +17025559876 --detailed
```

This is the most reliable approach. We proved through testing that agents burn 150K-369K tokens on morning briefs even when explicitly told to use ctx_run.py — they read SKILL.md and call skills directly, ignoring wrapper instructions.

### The Key Insight

> **Agents can't be trusted to follow instructions about tool usage.** The only reliable approaches are:
> 1. **Compact-by-default** — Skills return minimal output regardless of how they're called
> 2. **Pipeline scripts** — Bypass the agent entirely for deterministic tasks
> 3. **ctx_run.py** — For agent-driven tasks, wrap calls and inject `--verbose` automatically

### Real-World Impact

We measured a 24-hour period on a production OpenClaw instance **without** context-saver wired in:

| Session | Tokens Used | Cost |
|---------|------------|------|
| iMessage agent (49 messages) | 1,758,601 | $0.995 |
| Heartbeat (13 messages) | 293,342 | $0.305 |
| Morning brief #1 (8 messages) | 152,265 | $0.212 |
| Morning brief #2 (7 messages) | 130,548 | $0.139 |
| **Daily Total** | **2,356,572** | **$1.70** |

After context-saver v2.0: morning briefs dropped to **0 tokens** (launchd pipeline), data calls in chat compressed by 70-84%.

---

## How It Works

Context Saver has four layers that work together:

### Layer 1: Compact-by-Default Skills

Skills return minimal output by default. `--verbose` required for full dump. This is the **only approach that reliably saves tokens** because it works even when agents ignore all other instructions.

```python
# In your skill CLI:
parser.add_argument("--summary", default=True)
parser.add_argument("--verbose", action="store_true")

# Default output: {"s": "AAPL", "qty": "100", "pnl": "1500"}
# Verbose output: {"symbol": "AAPL", "qty": "100", "side": "long", "market_value": "18500", ...}
```

### Layer 2: Sandboxed Execution with Verbose Injection

ctx_run.py automatically injects `--verbose` into skill commands, gets the full output, applies intent-driven filtering, and returns a compact summary. The full output is indexed in FTS5 but never enters the context window.

```bash
# Without Context Saver: raw 3 KB JSON enters context
python3 skills/my-api/scripts/cli.py dashboard

# With Context Saver: 120 B summary enters context, full output indexed
python3 skills/context-saver/scripts/ctx_run.py --skill my-api --cmd "dashboard"
```

### Layer 3: Intent-Driven Filtering

Pass an `--intent` string and Context Saver extracts only the fields that match your question. Uses fast keyword scoring against JSON keys and values — no ML, no embeddings, no latency.

```bash
# Returns only fields related to errors (3 fields instead of 40+)
python3 scripts/ctx_run.py --skill my-api --cmd "dashboard" --intent "check error rate"

# Returns only losing positions
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "positions" --intent "find losing"

# Compact summary with all items
python3 scripts/ctx_run.py --skill alpaca-trader --cmd "positions" --intent "summary 20"
```

Smart handling of API wrapper dicts: `{"count": 8, "positions": [...]}` — automatically unwraps, recurses into the nested list, and filters each item.

### Layer 4: Session Continuity

Critical events are logged to SQLite with priority levels (P1-P4). Before conversation compaction wipes your context, a **2 KB snapshot** captures everything that matters. On resume, the snapshot restores full operational context without re-fetching anything.

```bash
# Log events as they happen
python3 scripts/ctx_session.py log --type "deploy" --priority critical \
  --data '{"service":"api-v2","version":"2.1.0"}'

# Before compaction: save state
python3 scripts/ctx_session.py snapshot

# After compaction: restore state
python3 scripts/ctx_session.py restore
```

---

## Usage

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

### Batch Execution (Multiple Skills, One Call)

Replace 4 separate skill calls (23 KB, 4 context insertions) with 1 batch call (2 KB, 1 insertion):

```bash
python3 scripts/ctx_batch.py --commands '[
  {"skill": "my-api", "cmd": "dashboard", "fields": ["active_users", "error_rate"]},
  {"skill": "analytics-engine", "cmd": "metrics", "intent": "summary"},
  {"skill": "health-monitor", "cmd": "check", "intent": "failures only"}
]'
```

You can also load from a pipeline file:

```bash
python3 scripts/ctx_batch.py --pipeline examples/daily-status-pipeline.json
```

### Multi-Messenger Delivery

```bash
# iMessage (auto-detected on macOS with imsg CLI)
python3 scripts/deliver.py --to +17025551234 --text "Morning brief ready"

# Telegram
python3 scripts/deliver.py --backend telegram --to 5328771204 --text "Alert!"

# Slack webhook
python3 scripts/deliver.py --backend slack --text "Daily report attached"

# Discord webhook
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

# JSON output for downstream processing
python3 scripts/morning_brief_pipeline.py --json

# Choose delivery backend
python3 scripts/morning_brief_pipeline.py --to 5328771204 --backend telegram
```

### Search Indexed Data

Every `ctx_run` execution indexes the full output in SQLite FTS5. Query it later without re-running commands:

```bash
# Search all indexed outputs
python3 scripts/ctx_search.py "error rate spike"

# Scoped to a specific skill
python3 scripts/ctx_search.py "failed deployments" --source my-api

# Limit results
python3 scripts/ctx_search.py "timeout" --limit 5
```

Supports FTS5 query syntax: `"exact phrase"`, `term1 AND term2`, `prefix*`.

### Session Event Tracking

```bash
# Log events at different priority levels
python3 scripts/ctx_session.py log --type "deploy" --priority critical \
  --data '{"service":"api-v2","version":"2.1.0"}'

python3 scripts/ctx_session.py log --type "alert" --priority high \
  --data '{"service":"cache","msg":"memory at 92%"}'

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

Shows total bytes saved, number of runs, average compression ratio, top skills by savings, indexed documents count, and session event stats.

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

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  Claude Context Window                    │
│                                                          │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐           │
│   │  120 B   │   │  300 B   │   │   2 KB   │           │
│   │ summary  │   │ filtered │   │ snapshot │           │
│   └────┬─────┘   └────┬─────┘   └────┬─────┘           │
│        │              │              │                  │
└────────┼──────────────┼──────────────┼──────────────────┘
         │              │              │
   ┌─────┴──────────────┴──────────────┴──────┐
   │           Context Saver Layer             │
   │                                           │
   │  ┌──────────┐ ┌──────────┐ ┌──────────┐  │
   │  │ Sandbox  │ │  Intent  │ │ Session  │  │
   │  │ Runner   │ │  Filter  │ │ Tracker  │  │
   │  │ +verbose │ │ +unwrap  │ │ +budget  │  │
   │  └────┬─────┘ └────┬─────┘ └────┬─────┘  │
   │       │            │            │         │
   │  ┌────┴────────────┴────────────┴────┐    │
   │  │  SQLite FTS5 Index + Stats        │    │
   │  │  Secret redaction before indexing  │    │
   │  │  100KB cap + 10K row pruning      │    │
   │  └───────────────────────────────────┘    │
   └───────────────────────────────────────────┘
         │              │              │
   ┌─────┴─────┐  ┌─────┴─────┐  ┌────┴──────┐
   │   3 KB    │  │   5 KB    │  │  20-50 KB │
   │ raw JSON  │  │ raw JSON  │  │  raw JSON │
   └───────────┘  └───────────┘  └───────────┘
        Skill Subprocesses (never enter context)
```

### Zero-Token Pipeline Architecture

```
┌───────────┐     ┌───────────┐     ┌───────────┐     ┌───────────┐
│  launchd  │────▶│ pipeline  │────▶│ ctx_run   │────▶│ deliver   │
│ (schedule)│     │ .py       │     │ .py       │     │ .py       │
└───────────┘     └───────────┘     └───────────┘     └───────────┘
                       │                  │                  │
                       │            ┌─────┴─────┐     ┌─────┴─────┐
                       │            │ --verbose  │     │ iMessage  │
                       │            │ injection  │     │ Telegram  │
                       │            │ + filter   │     │ Slack     │
                       │            └───────────┘     │ Discord   │
                       │                              └───────────┘
                  No LLM involved.
                  Zero tokens consumed.
```

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

Context Saver works with **any** OpenClaw skill out of the box. For best results, make your skills **compact-by-default**:

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

Both `.db` files are created automatically on first use. No setup required.

---

## Why This Doesn't Exist Anywhere Else

We looked. There's nothing like this.

Every major AI agent framework has the same problem: they dump raw API responses into the context window and hope for the best. Here's what's out there and why none of them solve this:

| Tool / Framework | What It Does | Context Optimization? |
|-----------------|-------------|----------------------|
| **LangChain** | Chains LLM calls together | No. Full outputs flow through the chain. |
| **CrewAI** | Multi-agent task delegation | No. Agents pass complete results to each other. |
| **AutoGPT** | Autonomous GPT agent | No. Every API call dumps full response into context. |
| **OpenAI Assistants** | Managed agent threads | No. Files are attached in full. No filtering. |
| **Semantic Kernel** | MS agent framework | No. Memory is retrieval-based, not input-optimized. |
| **context-mode** | FTS5 index for Claude | Partial. Indexes for retrieval, but doesn't filter inputs. |
| **RAG pipelines** | Retrieval-augmented generation | Solves retrieval. Doesn't solve what goes INTO context. |
| **Context Saver** | **Purpose-built context optimization** | **Yes. Filters, summarizes, batches, delivers, and snapshots.** |

### Comparison with context-mode

Context Saver was inspired by [context-mode](https://github.com/AnswerDotAI/context-mode), an MCP server that provides FTS5 indexing for Claude conversations. We took the core insight (index data outside context, retrieve on demand) and extended it for multi-agent orchestration:

| Feature | context-mode | Context Saver |
|---------|-------------|---------------|
| Scope | General Claude conversations | AI agent skill execution |
| Install | MCP server (Node.js) | Drop-in Python scripts (stdlib only) |
| Filtering | Query-based post-retrieval | Intent-driven pre-filtering |
| Batching | Not supported | Multi-skill batch execution |
| Sessions | Not supported | Priority-based event tracking + snapshots |
| Delivery | Not supported | iMessage, Telegram, Slack, Discord |
| Pipelines | Not supported | Zero-token launchd/cron pipelines |
| Security | N/A | Command injection, path traversal, secret redaction |
| Token savings | Indirect (faster retrieval) | Direct (70-98% fewer tokens entering context) |
| Target | Any Claude Code user | Any AI agent system (OpenClaw, custom, etc.) |

Both tools can coexist — they solve different layers of the same problem.

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

Built for [OpenClaw](https://github.com/openclaw-ai) multi-agent systems.
