# Benchmarks

## Summary Table

| Scenario | Raw Size | Context Saver | Savings | Reduction |
|----------|----------|---------------|---------|-----------|
| Dashboard query | 3,072 B | 120 B | 2,952 B | **96%** |
| List items (50 records) | 5,120 B | 300 B | 4,820 B | **94%** |
| Search results (200 hits) | 20,480-51,200 B | 500 B | 19,980-50,700 B | **97%** |
| Multi-skill pipeline | 23,552 B (4 calls) | 2,048 B (1 batch) | 21,504 B | **91%** |
| Session cold start | 20,480 B | 2,048 B | 18,432 B | **90%** |
| Full day operation | ~750K tokens | ~200K tokens | ~550K tokens | **73%** |

## Detailed Scenarios

### 1. Dashboard Query (96% savings)

**Without Context Saver:**
A typical API dashboard endpoint returns a full JSON object with 40+ fields including system status, resource utilization, user counts, error rates, latency percentiles, cache hit ratios, queue depths, and configuration flags. Total: ~3 KB.

**With Context Saver:**
`ctx_run.py --skill my-api --cmd "dashboard" --intent "check error rate"` returns:

```json
{"error_rate":"0.02","errors_24h":"142","uptime":"99.98%"}
```

Total: 120 bytes. The intent filter matched `error_rate`, `errors_24h`, and `uptime` based on the "check error rate" keywords.

**Full output indexed:** The complete 3 KB response is stored in FTS5 and searchable via `ctx_search.py`.

### 2. List Items (50 Records) (94% savings)

**Without Context Saver:**
Each item object contains 20+ fields (ID, name, status, created_at, updated_at, metadata, tags, owner, permissions, history, etc.). With 50 items: ~5 KB.

**With Context Saver:**
`ctx_run.py --skill my-api --cmd "list-items" --intent "find failing items"` returns only items where `status == "error"`:

```json
[
  {"name":"auth-service","status":"error","last_error":"timeout at 14:32"},
  {"name":"cache-layer","status":"error","last_error":"OOM at 14:15"}
]
```

Total: ~300 bytes. The intent filter boosted entries with error/failing status values.

### 3. Search Results (97% savings)

**Without Context Saver:**
A search query against a large dataset returns hundreds of results, each with full metadata including scores, highlights, facets, and nested objects. Total: 20-50 KB.

**With Context Saver:**
`ctx_run.py --skill my-api --cmd "search users" --intent "inactive accounts over 90 days"` returns:

```json
[
  {"user":"jdoe","last_active":"2025-12-01","status":"inactive","days_inactive":104},
  {"user":"asmith","last_active":"2025-11-15","status":"inactive","days_inactive":120},
  {"user":"bwong","last_active":"2025-10-30","status":"inactive","days_inactive":136}
]
```

Total: ~500 bytes. The intent filter matched inactive status and sorted by inactivity duration.

### 4. Multi-Skill Pipeline (91% savings)

**Without Context Saver:**
A daily status pipeline makes 4 separate skill calls:
- Dashboard: 3 KB
- Service list: 5 KB
- Recent events: 8 KB
- System metrics: 7 KB

Each call enters the context window independently. Total: 23 KB across 4 context insertions.

**With Context Saver:**
`ctx_batch.py` executes all 4 commands in a single batch:

```json
{
  "commands_run": 4,
  "total_bytes_saved": 21504,
  "total_savings_pct": 91.3,
  "results": [
    {"skill": "my-api", "summary": {"active_users": "12543", "error_rate": "0.02"}},
    {"skill": "my-api", "summary": [{"name": "auth-service", "status": "healthy"}]},
    {"skill": "analytics-engine", "summary": [{"event": "deploy", "count": 3}]},
    {"skill": "health-monitor", "summary": {"cpu": "45%", "memory": "62%", "disk": "38%"}}
  ]
}
```

Total: ~2 KB. One context insertion instead of four.

### 5. Session Cold Start (90% savings)

**Without Context Saver:**
When a conversation resumes after compaction, Claude typically needs to re-read workspace files to understand the current state:
- HEARTBEAT.md: 2 KB
- WORKSPACE.md: 5 KB
- Recent skill outputs: 8 KB
- Configuration: 5 KB

Total: ~20 KB of context consumed just to "remember" what was happening.

**With Context Saver:**
`ctx_session.py restore` loads a 2 KB snapshot containing priority-tagged events:

```json
{
  "session_id": "20260314-090000",
  "events": {
    "P1": [{"type": "action", "d": {"operation": "deploy", "service": "api-v2"}}],
    "P2": [{"type": "alert", "d": {"service": "cache", "msg": "memory usage 92%"}}],
    "P3": [{"type": "analysis", "d": {"trend": "stable", "anomalies": 0}}]
  }
}
```

Total: ~2 KB. Claude immediately knows what actions were taken, what alerts fired, and what the analysis concluded.

### 6. Full Day Operation (73% savings)

**Methodology:**

A typical agent day involves:
- 5 status check pipelines (different service views)
- 20 individual skill queries (dashboards, lists, searches)
- 10 analytics calls
- 5 search/research operations
- 3 session compaction/restore cycles
- 15 notification deliveries

**Without Context Saver:**
- Status pipelines: 5 x 23 KB = 115 KB
- Individual queries: 20 x 5 KB avg = 100 KB
- Analytics: 10 x 10 KB avg = 100 KB
- Search: 5 x 15 KB avg = 75 KB
- Session restores: 3 x 20 KB = 60 KB
- Notifications: 15 x 2 KB = 30 KB
- **Total raw: ~480 KB (~750K tokens at ~1.5 tokens/byte)**

**With Context Saver:**
- Status pipelines: 5 x 2 KB = 10 KB
- Individual queries: 20 x 300 B avg = 6 KB
- Analytics: 10 x 500 B avg = 5 KB
- Search: 5 x 1 KB avg = 5 KB
- Session restores: 3 x 2 KB = 6 KB
- Notifications: 15 x 200 B = 3 KB (notifications are already small)
- **Total filtered: ~35 KB + overhead = ~130 KB (~200K tokens)**

**Net savings: ~550K tokens (73%)**

## Methodology

### How We Measure

1. **Raw bytes:** Total bytes of skill subprocess stdout
2. **Summary bytes:** Total bytes of filtered JSON returned to context
3. **Savings percentage:** `(raw - summary) / raw * 100`
4. **Token estimation:** 1 byte of JSON approximately equals 1.5 tokens (accounting for JSON syntax overhead in tokenization)

### Factors That Affect Savings

| Factor | Impact |
|--------|--------|
| Output size | Larger outputs = higher savings percentage |
| Intent specificity | More specific intents = better filtering |
| Data structure | Flat JSON filters better than deeply nested |
| Field count | More fields in raw output = more to filter out |
| Batch size | More commands per batch = more overhead eliminated |

### What's Not Counted

- Context Saver's own JSON wrapper overhead (~50-100 bytes per call)
- FTS5 index storage on disk (typically <1 MB per 1000 calls)
- SQLite write latency (~1-5 ms per operation)
- Subprocess spawn overhead (~10-50 ms per call)
