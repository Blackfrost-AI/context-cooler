# Session goal

**Goal:** Ship v6.1 follow-ups (hooks, hybrid recall, migrate, deps) and wire the local Grok install.

## Success criteria
- [x] Host PreCompact/PostCompact/SessionStart hooks installed for Grok (+ Claude merge)
- [x] Hybrid recall (FTS + events + recency + synonyms)
- [x] Fragmented DB list/merge via `ctx_migrate`
- [x] Dependency audit clean (0 vulns)
- [x] Grok env: CTX_ALLOW_EXEC=1 + CONTEXT_COOLER_HOME=~/.context-cooler
- [x] Local fragments merged into ~/.context-cooler
- [x] Version 6.1.0; tests green; pushed to GitHub

## Scope
- **In:** hooks, search/recall, migrate tool, adapters, install, lockfile, local wire-up
- **Out:** True embedding models (hybrid is intentional light-weight)
