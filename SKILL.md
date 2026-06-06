---
name: context-saver
description: "Token-saving execution layer. Runs skill commands in sandboxed subprocesses where only compact summaries enter the context window. Provides session continuity via SQLite event tracking that survives conversation compaction. Supports intent-driven filtering, batched multi-skill execution, and progressive memory loading. Includes an automated installer that builds and registers the MCP server with a single command. Use this skill to wrap any data-heavy operation to reduce token consumption by 70-98%."
metadata: {"emoji":"🪶","requires":{"bins":["python3"],"env":[]}}
---

# Context Cooler — Token Optimization

Reduces token consumption by 70-98% through sandboxed execution, intent filtering, and session continuity.

## Core Concept

Instead of dumping raw API responses (3-50 KB) into context, Context Saver:
1. Runs skill commands in subprocesses
2. Captures full output
3. Extracts only relevant fields based on intent
4. Returns compact summaries (100-500 bytes)
5. Indexes full output in FTS5 for on-demand retrieval

## Commands

### Sandboxed Skill Execution
```bash
# Run any skill command with automatic summarization
python3 scripts/ctx_run.py --skill my-api --cmd "dashboard" [--intent "check error rate"]
python3 scripts/ctx_run.py --skill my-api --cmd "list-items" [--intent "find failures"]
python3 scripts/ctx_run.py --skill my-api --cmd "search users" --intent "inactive accounts over 90 days"

# Run with explicit summary fields
python3 scripts/ctx_run.py --skill my-api --cmd "dashboard" --fields "active_users,error_rate,uptime"
```

### Batch Execution (Multiple Skills in One Call)
```bash
python3 scripts/ctx_batch.py --commands '[
  {"skill": "my-api", "cmd": "dashboard", "fields": ["active_users","error_rate"]},
  {"skill": "analytics-engine", "cmd": "metrics", "intent": "summary"},
  {"skill": "health-monitor", "cmd": "check", "intent": "failures only"}
]'
```

### Session Event Tracking
```bash
# Log a session event
python3 scripts/ctx_session.py log --type "action" --priority critical --data '{"operation":"deploy","service":"api-v2"}'

# Build compaction snapshot (called before conversation compacts)
python3 scripts/ctx_session.py snapshot

# Restore from snapshot (called on session resume)
python3 scripts/ctx_session.py restore

# View session stats
python3 scripts/ctx_session.py stats
```

### Context Search (Query Indexed Data)
```bash
python3 scripts/ctx_search.py "error rate spike" [--source my-api]
python3 scripts/ctx_search.py "failed deployments" --source last-run
```

### Context Stats
```bash
python3 scripts/ctx_stats.py
# Shows: total bytes saved, calls made, avg compression ratio, session events
```

## How It Saves Tokens

| Operation | Without Context Saver | With Context Saver | Savings |
|-----------|----------------------|-------------------|---------|
| Dashboard summary | 3 KB JSON | 120 B summary | 96% |
| List items (50 records) | 5 KB JSON | 300 B summary | 94% |
| Search results (200 hits) | 20-50 KB | 500 B filtered | 97% |
| Multi-skill pipeline | 23 KB (4 calls) | 2 KB (1 batch) | 91% |
| Session cold start | 20 KB workspace files | 2 KB snapshot | 90% |

## When to Use
- Any data-heavy skill command (APIs, analytics, search)
- Multi-step pipelines (daily reports, status checks)
- Session resumption after compaction
- When context window is running low
- Don't use for small operations (<500 bytes output)
- Don't use when you need full raw data for editing/modification
