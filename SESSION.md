# Session goal

**Goal:** Ship context-cooler v6.0.0 that fixes memory continuity failures identified in the deep review, without regressing token savings or security.

## Success criteria
- [x] Session ID no longer has trailing `.`; can rotate cleanly
- [x] `restore` falls back to latest snapshot when current session has none
- [x] Snapshot default budget raised for coding agents (still clampable)
- [x] `compactDefault` preserves high-signal nested keys (decisions, errors, next_steps, etc.)
- [x] High-signal execute summaries can auto-log to session events
- [x] `ctx_session` supports listing recent events; tool responses surface data dir when relevant
- [x] All existing tests pass + new regressions for the above (42/42)
- [x] Version bumped to 6.0.0 across package/skill/changelog
- [x] Pushed to GitHub

## Scope
- **In:** `src/lib/*`, `src/tools/*`, tests, version metadata, CHANGELOG
- **Out:** Unrelated refactors, new MCP hosts, semantic embeddings
