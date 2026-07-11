<p align="center">
  <img src="docs/banner.jpg" alt="Context Cooler — Burn fewer tokens. Ship cooler agents." width="100%">
</p>

<h1 align="center">Context Cooler</h1>

<p align="center">
  <strong>Eliminate token burn with the coolest MCP on the net.</strong><br>
  <em>Burn fewer tokens. Ship cooler agents.</em>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-22d3ee"></a>
  <img alt="MCP server" src="https://img.shields.io/badge/MCP-server-1e3a8a">
  <img alt="Outbound: zero callbacks" src="https://img.shields.io/badge/outbound-zero%20callbacks-0ea5e9">
  <img alt="Version 6.2" src="https://img.shields.io/badge/version-6.2-38bdf8">
</p>

A standalone Model Context Protocol (MCP) server that gives any MCP-compatible coding agent — Claude Code, Cursor, OpenAI Codex CLI, Gemini CLI, OpenCode, Grok CLI, Shadow — a sandboxed runtime, an FTS5 knowledge base, and a multi-messenger delivery channel. Built from scratch on the MCP spec. Zero outbound dependencies beyond the four pinned ones in `package.json`. MIT-licensed, audit-readable end-to-end.

---

## The "Think in Code" philosophy

When an agent needs to analyse a directory, a JSON dump, or 47 source files, the temptation is to *Read* every file and let the model figure it out from raw text. That's how 750 KB of cached context disappears in a single afternoon: every turn re-pays the read cost.

**Don't pull data into the model. Push code at the data and pull back the answer.**

### Canonical example

> "Across these 47 TypeScript files, find every `await` that's missing a `try/catch`."

| Approach | Bytes consumed | Tokens (rough) |
|---|---|---|
| `Read` × 47 (`/src/**/*.ts`) | ~700 KB raw text in context | ~175,000 |
| `ctx_execute` (one shell+grep call, prints summary) | ~3.6 KB summary | ~900 |

The 195× reduction isn't theoretical — it's what a real morning-brief pipeline measures every day. The agent's job is to **write a script**, not to memorise the repo.

`ctx_execute` runs that script in a sandboxed subprocess (11 supported runtimes), captures stdout, optionally filters with an `intent` keyword, indexes the full output in FTS5 (so the agent can search it later without re-reading), and returns only the compact summary to the context window.

---

## What's new in v6.2

- **One brain:** default data home is **`~/.context-cooler`** (no more silent scatter into `$HOME/context`).
- **`ctx_migrate purge_legacy`** removes leftover fragment dirs after merge.
- Hybrid `ctx_search` stays the default memory path.

## What's new in v6.1

Follow-ups to the continuity work:

- **Grok/Claude compact hooks** — PreCompact snapshots, PostCompact + SessionStart restore (auto-installed).
- **Hybrid `ctx_search`** — FTS + session events/snapshots + synonyms + recency (default).
- **`ctx_migrate`** — merge fragmented data dirs into one brain.
- **Grok adapter** enables sandboxed exec + pins `CONTEXT_COOLER_HOME=~/.context-cooler`.
- **Dependency audit clean** (0 known vulns in lockfile after `npm audit fix`).

## What's new in v6.0

**Major release: memory continuity that actually works.** v5 compressed well but forgot everything — empty session logs, a broken session id, 2 KB snapshots, and scalar-only `compactDefault` that stripped `decisions` / `next_steps` / errors from context.

- **Session id fixed** — no more trailing `.` from ISO fractional seconds; sticky legacy ids are migrated; optional `CTX_SESSION_ID` binds to the host conversation id; `ctx_session action=new` rotates cleanly.
- **Restore fallback** — if the current session has no snapshot, restore returns the latest snapshot from any session (and soft-falls back to recent events).
- **Default snapshot budget 16 KB** (was 2 KB). Override with `CTX_SNAPSHOT_BUDGET` (256–65536).
- **Smarter compact-by-default** — high-signal nested keys (`decisions`, `next_steps`, `error_details`, `todos`, …) survive in shrunk form; full output still lives in FTS5.
- **Auto-log** — successful `ctx_execute` summaries are written to `sessions.db` by default so snapshot/restore has material. Opt out with `CTX_AUTO_LOG=0`.
- **`ctx_session` actions `recent` and `new`** — list recent events (cross-session if empty) and start a fresh id.
- **Doctor + stats surface data dir, session health, auto-log state, and budget.**

## What's new in v5.2

- **Pretzel Porter adapter** — Context Cooler now targets self-hosted LLMs. [Pretzel Porter](https://github.com/tlancas25/Pretzel-Porter) is a Claude Code-style terminal agent that runs entirely on a local or privately-hosted Ollama model. Pick `pretzel-porter` at install time; the adapter writes into `~/.pretzel-porter/agent.config.local.json`.
- **Grok CLI native adapter** — first-class support for xAI Grok CLI / Build TUI. `install.py --platform=grok` (or interactive) now writes a native `[mcp_servers.context-cooler]` table to `~/.grok/config.toml` (stdlib TOML, no extra deps). Works alongside the existing `.claude.json` compatibility layer; enables project `.grok/config.toml` too.

## What's new in v5.1

- **Installs on any machine.** The installer defaults to your home directory (great for Grok CLI / Cursor / Claude Code standalone users), auto-creates the data dir, and runs only the universal steps (build + register MCP + dbs + timestamp). Override with `$CONTEXT_COOLER_HOME` or `--data-dir`.
- **`--data-dir` flag** sets where the SQLite databases live.

## What's new in v4.6

- **Platform adapters** — one-shot installers for Claude Code, Cursor, OpenAI Codex CLI, Gemini CLI, OpenCode, Pretzel Porter, and Grok CLI. Pick one or all of them at install time. See "[Platform adapters](#platform-adapters)".
- **Exit classification** — `ctx_execute` now returns a structured `status`: `success | runtime_error | timeout | sandbox_violation | language_unavailable`. Agents can branch on the failure mode instead of parsing stderr.
- **Local update reminder** — `ctx_doctor` reads `~/.context-cooler/last-upgrade.txt` (purely local, no network call) and surfaces a "last upgraded N days ago" warning when it's older than 30 days.
- **Polished installer** — `install.py` now walks you through platform selection and install path interactively (stdlib `input()`, no new dependencies). Non-TTY runs default to all platforms.
- **Backwards compatible** — every v4.5 tool keeps the same name, schema, and on-success response shape. The new fields (`status`, `exit_code`, `duration_ms`) are additive.

---

## Installation & Updates

### macOS / Linux

**First-time install:**
```bash
git clone https://github.com/Blackfrost-AI/context-cooler.git
cd context-cooler
python3 install.py
```

**Update to the latest version:**
```bash
cd context-cooler
python3 install.py --update
```

### Windows

**First-time install:**
```powershell
git clone https://github.com/Blackfrost-AI/context-cooler.git
cd context-cooler
python install.py
```

**Update to the latest version:**
```powershell
cd context-cooler
python install.py --update
```

> **Windows notes:** iMessage delivery is macOS-only. Telegram, Slack, and Discord work on all platforms. For full shell sandboxing support, install WSL (`wsl --install`) and run the installer from inside WSL.

### Installer Options

```bash
python3 install.py                              # Interactive — asks which agents to register
python3 install.py --platform=claude-code       # Register one platform, skip prompt
python3 install.py --platform=all               # Register every supported agent
python3 install.py --non-interactive            # Use defaults, no prompts (for CI)
python3 install.py --dry-run                    # Preview changes without writing
python3 install.py --verify                     # Check installation status
python3 install.py --uninstall                  # Show uninstall notes
python3 install.py --update                     # git pull + rebuild + re-register
python3 install.py --accept-disclaimer          # Skip disclaimer prompt (CI/scripts)
python3 install.py --data-dir /custom/path      # Custom data directory
```

### What the Installer Does

Every install runs these four universal steps:

1. Builds the MCP server (`npm install` + `npx tsc`).
2. **Registers `context-cooler` with each selected platform adapter** (Claude Code, Cursor, Codex, Gemini, OpenCode, Pretzel Porter, Grok CLI). Each adapter writes atomically (tmp file + rename) to that platform's MCP config file.
3. Initialises SQLite databases (`stats.db` + `sessions.db`) under the data directory (default: your home directory, override with `$CONTEXT_COOLER_HOME` or `--data-dir`). The directory is auto-created.
4. **Records the install timestamp** in `<data-dir>/context/last-upgrade.txt` so `ctx_doctor` can remind you to upgrade later.

### Requirements

- **Node.js 18+** (for the MCP server)
- **Python 3.8+** (for the installer and helper scripts — stdlib only, no pip dependencies)
- **SQLite** (bundled with Python and Node.js via better-sqlite3)

---

## Platform adapters

Each adapter writes a single MCP-server entry (`stdio`, command `node`, args `[abs-path-to-dist/server.js]`) into the configuration file the host actually reads. Atomic write: tmp file + rename. Dry-run prints the path it *would* write to, then exits without touching disk.

| Platform | Config file written | Adapter |
|---|---|---|
| **Claude Code** | `~/.claude.json` (`mcpServers` map) | `src/adapters/claude-code.ts` |
| **Cursor** | `~/.cursor/mcp.json` (`mcpServers` map) | `src/adapters/cursor.ts` |
| **OpenAI Codex CLI** | `~/.codex/mcp_servers.json` (`mcpServers` map) | `src/adapters/codex.ts` |
| **Gemini CLI** | `~/.gemini/settings.json` (`mcpServers` map) | `src/adapters/gemini.ts` |
| **OpenCode** | `~/.config/opencode/opencode.json` (`mcp` map) | `src/adapters/opencode.ts` |
| **Pretzel Porter** | `~/.pretzel-porter/agent.config.local.json` (`mcpServers` map) | `src/adapters/pretzel-porter.ts` |
| **Grok CLI** | `~/.grok/config.toml` (`[mcp_servers]` table) | `src/adapters/grok.ts` |
| **Shadow** | `~/.shadow/config.json` (`mcpServers` map) — also sets `env: { CTX_ALLOW_EXEC: "1" }` so the sandboxed `ctx_execute` works out of the box (Shadow is itself a sandboxed code-execution agent) | `src/adapters/shadow.ts` |

Each adapter is under 80 lines and only depends on Node stdlib. They are also reachable from the command line for scripted installs:

```bash
node dist/adapters/index.js list
# {"adapters":["claude-code","cursor","codex","gemini","opencode","pretzel-porter","grok","shadow"]}

node dist/adapters/index.js install \
  --server="$(pwd)/dist/server.js" \
  --platform=cursor \
  --dry-run
# {"platform":"cursor","configPath":"/Users/you/.cursor/mcp.json","ok":true,"detail":"would register context-cooler -> ..."}
```

`install.py` calls this CLI under the hood, one platform at a time.

---

## Architecture

Context Saver is a single MCP server that any MCP-compatible agent auto-discovers. When the agent needs to run code, search data, or deliver messages, it calls our tools directly — there's nothing to skip or bypass.

```
┌──────────────────────────────────────────────────────────────────┐
│              ANY MCP-Compatible AI Agent                         │
│   Claude Code / Cursor / Codex / Gemini CLI / OpenCode / Pretzel Porter / Grok CLI / Custom  │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                    MCP Protocol (stdio)
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│            context-cooler (Node.js MCP Server)           │
│                                                                  │
│   10 Tools:                        Core Libraries:               │
│   • ctx_execute      (sandbox)     • sandbox.ts  (11 languages)  │
│   • ctx_execute_file (file inject) • exit-classify.ts  (status)  │
│   • ctx_batch        (multi-cmd)   • filter.ts   (intent scoring)│
│   • ctx_search       (FTS5 query)  • db.ts       (SQLite + FTS5) │
│   • ctx_index        (store data)  • chunker.ts  (markdown/JSON) │
│   • ctx_fetch_index  (HTTP→index)  • redact.ts   (secret strip)  │
│   • ctx_session      (P1-P4 state) • env.ts      (config loader) │
│   • ctx_stats        (aggregation)                               │
│   • ctx_deliver      (4 backends)  Adapters (v4.6):              │
│   • ctx_doctor       (health check) • claude-code / cursor /     │
│                                       codex / gemini / opencode / pretzel-porter / grok  │
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

After install, every selected platform's config file ends up with an entry like this (Claude Code shown):

```json
{
  "mcpServers": {
    "context-cooler": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/context-cooler/dist/server.js"],
      "env": {}
    }
  }
}
```

For Grok CLI the native entry (written by the new `grok` adapter) looks like:

```toml
[mcp_servers.context-cooler]
command = "node"
args = ["/path/to/context-cooler/dist/server.js"]
env = {}
enabled = true
```

Any MCP client (Claude Code, Cursor, Codex CLI, Gemini CLI, OpenCode, Pretzel Porter, Grok CLI) auto-discovers the 10 tools and calls them natively.

---

## The 10 MCP Tools

### ctx_execute — Sandboxed Code Execution

Run code in 11 languages with intent-driven output filtering. Full output is indexed in FTS5; only the filtered summary enters the context window.

**Supported languages:** JavaScript, TypeScript, Python, Shell, Ruby, PHP, Perl, Go, Rust, R, Elixir.

```
ctx_execute(language="python", code="...", intent="check balance")
→ 120 B summary instead of 3 KB raw dump
```

**v4.6 structured result.** Every call returns:

```jsonc
{
  "success": true,
  "status": "success",          // success | runtime_error | timeout | sandbox_violation | language_unavailable
  "exit_code": 0,
  "duration_ms": 47,
  "summary": { ... },           // or "output": "..." for non-JSON stdout
  "raw_bytes": 3127,
  "summary_bytes": 96,
  "bytes_saved": 3031,
  "savings_pct": 96.9,
  "indexed": true,
  "stderr": "..."               // present only when stderr is non-empty
}
```

Status semantics:

| Status | When |
|---|---|
| `success` | Process exited 0. |
| `runtime_error` | Non-zero exit, no other classifier matched. |
| `timeout` | Killed because `args.timeout` elapsed. |
| `sandbox_violation` | Non-zero exit + stderr matched a kernel/sandbox block pattern (`operation not permitted`, `seccomp`, `EPERM`, `sandbox-exec ... deny`). |
| `language_unavailable` | The runtime executable wasn't on `PATH` (`spawn ENOENT`, `command not found`). |

### ctx_execute_file — File-Aware Execution

Same as `ctx_execute` but injects a file's content as a variable (`FILE_CONTENT`) into the execution environment.

### ctx_batch — Multi-Command Pipeline

Run multiple commands and/or search queries in a single MCP call. Each command is executed sequentially with its own intent filter.

```
ctx_batch(commands=[
  {"language": "python", "code": "...", "intent": "summary"},
  {"language": "shell",  "code": "...", "intent": "top 5"}
], queries=["previous error rates"])
```

### ctx_search — FTS5 Knowledge Base Query

Search previously indexed data using SQLite FTS5 with BM25 ranking. Supports phrase matching, boolean operators, and prefix queries.

```
ctx_search(queries=["deployment errors", "position changes"])
```

### ctx_index — Store Data in Knowledge Base

Index content (text, JSON, or file paths) into FTS5 with automatic chunking. Markdown is chunked by headings, JSON by key paths, plain text by 50-line blocks. 4096 byte max per chunk, 100 KB per entry, 10 K max rows with auto-pruning.

### ctx_fetch_index — HTTP Fetch + Index

Fetch a URL, convert HTML to markdown (via Turndown), and index the content. Follows redirects, enforces 1 MB cap.

```
ctx_fetch_index(url="https://docs.example.com/api", source="API docs")
```

### ctx_session — Session Continuity

Log events with P1-P4 priority, take snapshots before compaction, and restore state after. Snapshots fit within a **16 KB default budget** (40% P1 / 30% P2 / 20% P3 / 10% P4; override with `CTX_SNAPSHOT_BUDGET`). Successful `ctx_execute` calls auto-log summaries unless `CTX_AUTO_LOG=0`.

```
ctx_session(action="log", event_type="decision", priority="high", data={...})
ctx_session(action="snapshot")   # Before compaction
ctx_session(action="restore")    # After compaction (falls back across sessions)
ctx_session(action="recent")     # Last N events (cross-session if empty)
ctx_session(action="new")        # Rotate session id
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

Checks the data directory, databases, FTS5 tables, skills directory, 5 language runtimes, mcporter availability, all 4 delivery backends, **and (v4.6) the local upgrade reminder**. Returns a pass/warn/fail report.

The upgrade reminder reads `~/.context-cooler/last-upgrade.txt` (an ISO 8601 timestamp written by `install.py`), compares it to today, and surfaces a `warn` if it's older than 30 days. **No network call** — this is purely a local file comparison.

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

P1-P4 priority events survive conversation compaction via priority-budgeted snapshots stored in SQLite (default 16 KB). Critical decisions and alerts are always preserved; informational queries are dropped first. Auto-log from `ctx_execute` fills the event stream so restore is not empty by default.

### Layer 5: Zero-Token Pipelines

For deterministic tasks, bypass the LLM entirely. Schedule pipelines via launchd/cron:

```
launchd → python3 pipeline.py → ctx_execute → ctx_deliver → iMessage/Telegram
                              No agent. No model. No tokens.
```

---

## Savings benchmark

Measured on a live agent instance running 8 positions, 20-symbol movers, daily briefs:

| Call | Raw Output | After Filtering | Savings |
|------|-----------|----------------|---------|
| `account` | 357 B | 95 B | **73.4%** |
| `positions` (8 holdings) | 2,739 B | 822 B | **70.0%** |
| `movers` (20 symbols) | 2,284 B | 367 B | **83.9%** |
| **Pipeline total** | **5,380 B** | **1,284 B** | **76.1%** |

> **Measured-in-real-tokens correction (2026 audit).** The percentages above are **byte ratios** measured
> against the tool's own forced `--verbose` output and converted at an asserted "1.5 tokens/byte". A token audit
> (counted with a real sub-word tokenizer) found the real rate is **~0.30 tokens/byte for JSON** — so the
> byte-based headlines (and the "750K→200K tok/day", "195×") are roughly **5× overstated** when restated in
> tokens. Counted honestly as `(compact_baseline − returned)/compact_baseline`, the win depends heavily on how
> you call the tool: passing `fields` (or an `intent`) on a **large** output saves **~85–99% real tokens**;
> calling it with **no filter on small outputs is roughly break-even-to-negative** because of a fixed
> per-call metadata overhead. Rule of thumb: **use `fields`/`intent`, and reach for `ctx_execute` when the raw
> output is large and you only need part of it** — not for small results you'd happily read directly.

Zero-token morning brief pipeline: launchd triggers Python directly — **no LLM tokens consumed**.

### Before & After

```
WITHOUT Context Saver:
  agent calls skill → 3 KB raw JSON floods context → 40 wasted fields
  agent calls skill → 5 KB raw JSON floods context → 50 irrelevant records
  agent calls skill → 20 KB raw JSON floods context → 200 search results
  Session compacts → all working state lost → 20 KB cold restart
  Daily token burn: ~750,000 tokens

WITH Context Saver v4.6:
  agent calls ctx_execute → 120 B summary enters context → full data indexed
  agent calls ctx_execute → 300 B filtered enters context → only matching records
  agent calls ctx_batch → 500 B combined → one MCP call, not three
  Session compacts → 2 KB snapshot preserved → instant resume
  Daily token burn: ~200,000 tokens (73% reduction)
```

---

## Security

> **This tool executes code and registers itself into your AI agents' configs. Read this honestly.**
> A 2026 security + performance audit (REDFORGE) found and fixed several serious issues; the items below
> describe the **actual** behavior of the TypeScript MCP server (`src/`, `dist/`) after those fixes.

- **Code execution is OPT-IN and NOT sandboxed.** `ctx_execute*` runs your code in a plain subprocess with
  **no filesystem jail, no network namespace, no seccomp/capability drop**. It refuses to run unless you set
  `CTX_ALLOW_EXEC=1`. There is no containment when enabled — only enable it on a host you control. A real OS
  sandbox (bubblewrap/seccomp/landlock, `sandbox-exec`, a container, or a WASM isolate) is on the roadmap; until
  then, **treat enabling execution as granting the tool your full shell privileges.** ("sandbox_violation" is a
  best-effort *post-hoc* stderr label, not a preventative control.)
- **List-arg subprocess (no shell-string concat).** `ctx_deliver` uses `execFileSync` array args; skill mode
  uses list-arg `executeArgv`; file content is passed via the environment, not interpolated into shell source.
- **Environment allowlist.** Only a minimal set of vars (plus any you opt in via `CTX_EXEC_ENV_ALLOW`) is
  forwarded to executed code — your other secrets/tokens are withheld. Returned output is also redaction-scanned.
- **Secret redaction.** Multi-shape detector (API keys, Bearer, Stripe/Alpaca, AWS access+secret keys incl.
  INI/env `key=value`, GitHub/Slack/Google tokens, JWTs, PEM private-key blocks) applied to both the index and
  the returned payload. Still regex-based — not a guarantee; don't rely on it for high-stakes secrets.
- **Filesystem read confinement.** `ctx_execute_file` / `ctx_index` only read inside `<data>/workspace` + the
  current project dir (extend with `CTX_FS_ALLOW`) — not your whole home directory.
- **SSRF protections.** `ctx_fetch_index` allows only http/https, blocks loopback/RFC1918/link-local
  (incl. `169.254.169.254`), and re-validates the destination on **every** redirect hop.
- **Input validation at the MCP boundary.** Every tool's args are `zod`-parsed with size/range bounds
  (code ≤10 MB, timeout 100 ms–10 min, batch ≤100 cmds, queries ≤50, search limit 1–50).
- **Installer defaults to deny.** Non-interactive runs register **no** platforms unless you pass an explicit
  `--platform`; `--platform=all` requires confirmation (`--yes`); `--update` (which pulls + runs remote code)
  requires `--allow-remote-code`; `--uninstall` actually removes the entries it added.
- **Parameterized SQL** (no SQL injection), **E.164 phone validation**, **atomic config writes**, **index caps**
  (100 KB/entry, 10 K rows), **snapshot budget clamp** (256–65536) — all confirmed.
- **Dependencies are pinned exact** (`npm ci` recommended). NOTE: the MCP SDK transitively pulls a full
  Express/Hono/cors/ajv/jose HTTP+OAuth stack (~130 packages) that this **stdio** server does not use — treat it
  as attack surface and advisory-scan it in CI. `better-sqlite3` runs a native build on install.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_COOLER_HOME` | your home directory | Root data directory (dbs live under `<dir>/context/`, optional `.env`) |
| `CTX_SNAPSHOT_BUDGET` | `16384` | Max bytes for session snapshots (256-65536) |
| `CTX_AUTO_LOG` | on (unset) | Set to `0` to disable auto-logging execute summaries into sessions.db |
| `CTX_SESSION_ID` | sticky file | Host conversation id override (recommended for multi-session agents) |
| `CTX_FTS_ENABLED` | `1` | Set to `0` to disable FTS5 indexing |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token for ctx_deliver |
| `TELEGRAM_CHAT_ID` | — | Default Telegram chat ID |
| `SLACK_WEBHOOK_URL` | — | Slack incoming webhook URL |
| `DISCORD_WEBHOOK_URL` | — | Discord webhook URL |

---

## Project Structure

```
context-cooler/
├── src/
│   ├── server.ts           # MCP server entry point (stdio transport)
│   ├── tools/
│   │   ├── execute.ts      # ctx_execute — sandboxed execution + status
│   │   ├── execute-file.ts # ctx_execute_file — file-aware execution
│   │   ├── batch.ts        # ctx_batch — multi-command pipeline
│   │   ├── search.ts       # ctx_search — FTS5 knowledge query
│   │   ├── index.ts        # ctx_index — content indexing
│   │   ├── fetch-index.ts  # ctx_fetch_index — HTTP fetch + index
│   │   ├── session.ts      # ctx_session — P1-P4 session continuity
│   │   ├── stats.ts        # ctx_stats — usage aggregation
│   │   ├── deliver.ts      # ctx_deliver — multi-messenger delivery
│   │   └── doctor.ts       # ctx_doctor — health check + upgrade reminder
│   ├── lib/
│   │   ├── sandbox.ts      # Subprocess runner (11 languages)
│   │   ├── exit-classify.ts# v4.6 — status classifier
│   │   ├── filter.ts       # Intent-driven keyword scoring
│   │   ├── db.ts           # SQLite + FTS5 connection management
│   │   ├── chunker.ts      # Markdown/JSON/text chunking
│   │   ├── redact.ts       # Secret redaction patterns
│   │   └── env.ts          # Environment and config loader
│   └── adapters/           # v5.2 — platform installers (≤80 lines each)
│       ├── claude-code.ts
│       ├── cursor.ts
│       ├── codex.ts
│       ├── gemini.ts
│       ├── opencode.ts
│       ├── pretzel-porter.ts # Pretzel Porter (self-hosted LLM)
│       ├── grok.ts           # Grok CLI ~/.grok/config.toml (TOML)
│       ├── types.ts
│       ├── util.ts         # atomic write, JSON + TOML read/splice helpers
│       └── index.ts        # CLI entry point + registry
├── install.py              # Cross-platform installer (interactive in v4.6)
├── package.json            # Node.js dependencies
├── tsconfig.json           # TypeScript configuration
├── skill.json              # MCP server manifest
└── docs/
    └── ARCHITECTURE.md     # Detailed architecture documentation
```

---

## License

MIT
