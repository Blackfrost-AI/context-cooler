# Integration Guide

## Overview

This guide explains how to integrate Context Saver with your existing skills, pipelines, and session management.

## Adding --summary Flags to Skill Scripts

The simplest integration is adding a `--summary` flag to your skill scripts that outputs a compact version of the response.

### Before (full output only)

```python
# my_skill/scripts/my_script.py
def handle_query():
    result = api_call()
    print(json.dumps(result))  # 5 KB output
```

### After (summary-aware)

```python
# my_skill/scripts/my_script.py
import argparse

def summarize(data, fields=None):
    """Extract only key fields for context-saving."""
    if fields:
        return {k: v for k, v in data.items() if k in fields}
    # Default: scalar values only
    return {k: v for k, v in data.items() if not isinstance(v, (dict, list))}

def handle_query(summary=False, fields=None):
    result = api_call()
    if summary:
        result = summarize(result, fields)
    print(json.dumps(result))

parser = argparse.ArgumentParser()
parser.add_argument("--summary", action="store_true", help="Output compact summary")
parser.add_argument("--fields", help="Comma-separated fields to include")
args = parser.parse_args()
handle_query(summary=args.summary, fields=args.fields.split(",") if args.fields else None)
```

This approach lets `ctx_run.py` work with your skill even without the `--summary` flag (it applies its own filtering), but skills that natively support `--summary` produce better, domain-aware summaries.

## Using ctx_run.py as a Wrapper

Instead of calling skill scripts directly, wrap them with `ctx_run.py`:

### Direct call (full output enters context)

```bash
python3 ~/context/workspace/skills/my-api/scripts/my_cli.py dashboard
# Returns: 3 KB JSON (all 40+ fields)
```

### Wrapped call (filtered output enters context)

```bash
python3 scripts/ctx_run.py --skill my-api --cmd "dashboard" --intent "check error rate"
# Returns: 120 B JSON (3 relevant fields)
```

### In SKILL.md documentation

Update your skill's SKILL.md to recommend Context Saver for data-heavy operations:

```markdown
## Commands

### Dashboard
\`\`\`bash
# Full output (use when you need all fields)
python3 scripts/my_cli.py dashboard

# Token-saving (recommended for routine checks)
python3 ~/context/workspace/skills/context-saver/scripts/ctx_run.py \
  --skill my-api --cmd "dashboard" --intent "check status"
\`\`\`
```

## Setting Up Session Tracking Hooks

### Manual Event Logging

Log significant events as they happen:

```bash
# After executing a critical action
python3 scripts/ctx_session.py log \
  --type "action" \
  --priority critical \
  --data '{"operation":"deploy","service":"api-v2","version":"2.1.0"}'

# After an alert triggers
python3 scripts/ctx_session.py log \
  --type "alert" \
  --priority high \
  --data '{"service":"cache-layer","condition":"memory_above","threshold":"90%"}'

# After analysis completes
python3 scripts/ctx_session.py log \
  --type "analysis" \
  --priority medium \
  --data '{"result":"stable","anomalies":0,"timeframe":"24h"}'
```

### Automated Event Logging in Skill Scripts

Add session logging directly to your skill scripts:

```python
import subprocess
import json

def log_event(event_type, priority, data):
    """Log an event to the context-saver session tracker."""
    ctx_session = os.path.expanduser(
        "~/context/workspace/skills/context-saver/scripts/ctx_session.py"
    )
    subprocess.run([
        "python3", ctx_session, "log",
        "--type", event_type,
        "--priority", priority,
        "--data", json.dumps(data),
    ], capture_output=True)

# In your action execution function:
def execute_action(operation, target):
    result = api.perform(operation=operation, target=target)
    log_event("action", "critical", {
        "operation": operation,
        "target": target,
        "result_id": result["id"],
    })
    return result
```

## Configuring HEARTBEAT.md for Snapshot Triggers

A HEARTBEAT.md system can trigger context snapshots before compaction.

### Add to HEARTBEAT.md

```markdown
## Pre-Compaction Hook

Before conversation compaction, run:
\`\`\`bash
python3 ~/context/workspace/skills/context-saver/scripts/ctx_session.py snapshot
\`\`\`

## Post-Compaction Hook

After conversation resumes, run:
\`\`\`bash
python3 ~/context/workspace/skills/context-saver/scripts/ctx_session.py restore
\`\`\`
```

### Automatic Snapshot Trigger

If your agent monitors context window usage, trigger snapshots when usage exceeds a threshold:

```python
# In your context monitor
if context_usage_pct > 80:
    subprocess.run([
        "python3",
        os.path.expanduser(
            "~/context/workspace/skills/context-saver/scripts/ctx_session.py"
        ),
        "snapshot",
    ])
```

## Pipeline Integration with workflow-engine

### Converting Existing Pipelines

Transform workflow-engine pipelines to use Context Saver's batch execution.

**Before (workflow-engine pipeline):**

```json
{
  "name": "daily-status",
  "steps": [
    {
      "id": "get_dashboard",
      "skill": "my-api",
      "command": "python3 scripts/my_cli.py dashboard",
      "output": "$dashboard"
    },
    {
      "id": "get_services",
      "skill": "my-api",
      "command": "python3 scripts/my_cli.py list-services",
      "output": "$services"
    }
  ]
}
```

**After (Context Saver batch pipeline):**

```json
{
  "name": "daily-status-ctx",
  "description": "Daily status with context-saving batch execution",
  "steps": [
    {
      "id": "batch_data",
      "skill": "context-saver",
      "cmd": "batch",
      "commands": [
        {"skill": "my-api", "cmd": "dashboard", "fields": ["active_users", "error_rate", "uptime"]},
        {"skill": "my-api", "cmd": "list-services", "intent": "summary with status"},
        {"skill": "health-monitor", "cmd": "check", "intent": "failures only"}
      ]
    }
  ]
}
```

### Hybrid Approach

Use Context Saver for data-heavy steps and direct execution for lightweight ones:

```json
{
  "steps": [
    {
      "id": "get_data",
      "comment": "Heavy data -- use context-saver",
      "skill": "context-saver",
      "command": "python3 scripts/ctx_batch.py --commands '[...]'"
    },
    {
      "id": "notify",
      "comment": "Lightweight -- direct execution is fine",
      "skill": "notification-router",
      "command": "python3 scripts/notify.py send --to user --subject 'Status Report'"
    }
  ]
}
```

## Environment Configuration

### Required Setup

```bash
# Ensure CONTEXT_COOLER_HOME is set (defaults to your home directory)
export CONTEXT_COOLER_HOME=~

# Create the context directory
mkdir -p $CONTEXT_COOLER_HOME/context

# Verify the skill is accessible
python3 $CONTEXT_COOLER_HOME/workspace/skills/context-saver/scripts/ctx_stats.py
```

### Custom Snapshot Budget

```bash
# Default is 2048 bytes (2 KB)
# Increase for sessions with many critical events
export CTX_SNAPSHOT_BUDGET=4096

# Decrease for extremely token-constrained environments
export CTX_SNAPSHOT_BUDGET=1024
```

### Disabling FTS5 Indexing

If disk space is a concern or you don't need search:

```bash
export CTX_FTS_ENABLED=0
```

## Troubleshooting

### "Skill not found" Error

Ensure the skill directory exists at `$CONTEXT_COOLER_HOME/workspace/skills/<name>/` and contains a `scripts/` subdirectory with at least one `.py` file.

### Empty Summaries

If summaries are empty, the intent filter may not be matching any fields. Try:
1. Using `--fields` for explicit field selection
2. Using `--raw` to see the full output
3. Adjusting intent keywords to match actual field names

### Large FTS Index

The FTS index grows with each `ctx_run.py` execution. To clean old entries:

```sql
-- Connect to stats.db
DELETE FROM fts_index WHERE timestamp < datetime('now', '-7 days');
```

### Session ID Issues

Session IDs are stored in `$CONTEXT_COOLER_HOME/context/.session_id`. To start a fresh session:

```bash
rm $CONTEXT_COOLER_HOME/context/.session_id
```
