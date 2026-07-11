# Changelog

All notable changes to Context Cooler are documented here.

## [6.0.0] — 2026-07-11 — Memory continuity that actually works

**Breaking / major:** defaults and session behavior change so agents stop losing state after compaction. Token compression path is unchanged in spirit; continuity is no longer a no-op.

### Why
Deep review of a live install found: measured token burn was down, but **memory was empty** — 0 session events, one empty snapshot, a sticky session id ending in `.`, 2 KB budgets too small for coding state, and `compactDefault` stripping nested `decisions` / `next_steps` / errors from context.

### Changed
- **Default `CTX_SNAPSHOT_BUDGET` 2048 → 16384** (still clamped 256–65536).
- **`compactDefault`** keeps high-signal nested keys in shrunk form (not scalars-only).
- **Session id generator** is `YYYYMMDD-HHMMSS` with no trailing dot; legacy sticky ids are migrated on read.
- **`ctx_session restore`** falls back to the latest snapshot on any session, then to recent events.
- **Successful `ctx_execute` auto-logs** a compact event into `sessions.db` by default (`CTX_AUTO_LOG=0` to disable).
- **Doctor** warns when events are empty and reports auto-log / budget / session id.
- **Stats / session responses** include `data_dir` so multi-home installs are visible.

### Added
- `ctx_session` actions **`recent`** and **`new`**.
- Env: **`CTX_AUTO_LOG`**, **`CTX_SESSION_ID`**.
- Regression suite `test/memory-continuity.test.mjs` (session id, budget, compactDefault, restore fallback, recent, auto-log flag).

### Fixed
- Restore permanently failing when sticky session id did not match the snapshot row.
- Session id `20260703201901.` (fractional-second slice bug).
- Continuity loop that required manual logging nobody did — auto-log closes the loop for execute-heavy agents.

### Migration
- No DB migration required. Optional: set `CTX_SESSION_ID` to your host conversation id; set `CTX_SNAPSHOT_BUDGET=2048` if you want the old ops-only budget; set `CTX_AUTO_LOG=0` if you do not want execute auto-events.
- Call `ctx_session action=snapshot` before compact and `restore` (or `recent`) on resume.

## [5.5.0] — 2026-07-02 — Shadow batteries-included exec + doctor exec check

Focused on the Shadow CLI integration (`github.com/Blackfrost-AI/shadow-cli`), which
offers Context Cooler during onboarding. Verified end-to-end against a live Shadow-style
stdio MCP session (handshake, `tools/list`, and each tool). `tsc` clean, 20/20 tests green.

### Changed
- **The Shadow adapter enables the flagship sandboxed `ctx_execute` by default.**
  `--platform=shadow` now writes `env: { CTX_ALLOW_EXEC: "1" }` into the Shadow MCP entry.
  Shadow is itself a sandboxed code-execution agent on a host the user controls, and the
  user opts into Context Cooler explicitly, so the "Think in Code" token savings now work
  out of the box instead of erroring with "code execution is disabled" until the operator
  discovers the env var. Execution still runs through the **fail-closed OS sandbox**
  (`sandbox-exec` on macOS / `bwrap` on Linux — network-denied, jailed; validated: a
  sandboxed network probe returns denied). Remove the key from `~/.shadow/config.json` to
  disable. Other adapters keep exec opt-in. `serverEntry()` gained an optional, backwards-
  compatible `env` parameter.

### Added
- **`ctx_doctor` reports code-execution status** — whether `CTX_ALLOW_EXEC` is set and which
  sandbox backend (`sandbox-exec`/`bwrap`/none) is active. A disabled or unsandboxed install
  was previously silent; now it is an explicit check that answers "why does ctx_execute error?".

### Fixed
- **`skill.json` version drift** — was pinned at `5.3.0` while `package.json` had moved to
  `5.4.0`. Now synced (package.json remains the single source for the server handshake).

## [5.4.0] — 2026-06-10 — Security hardening

A focused security pass. Context Cooler runs code by design, so containment and
least-privilege are treated as core features. Everything here ships with
regression tests (`node --test`, 20/20 green) and a clean `tsc` build.

### Added
- **First-cut OS execution sandbox (fail-closed).** `ctx_execute*` now runs
  through a real OS sandbox where the platform provides one — **bubblewrap
  (`bwrap`) on Linux** and **`sandbox-exec` on macOS** — with no network, a
  writable jail only (no `$HOME`), read-only system dirs, fresh namespaces, and
  `--die-with-parent`. Where no sandbox backend is available, execution is now
  **refused by default**; running without containment requires an explicit
  `CTX_ALLOW_UNSANDBOXED=1` opt-out (intended only for isolated hosts). This
  replaces the prior "runs unsandboxed when enabled" default with a fail-closed
  one. *(The `bwrap`/`sandbox-exec` wrappers are a first cut; validate on
  Linux/macOS before relying on them against hostile code — the fail-closed
  default is the platform-independent guarantee.)*
- **Loader-variable hard-deny.** Loader-influence env vars (`LD_PRELOAD`,
  `LD_LIBRARY_PATH`, `DYLD_*`, `PYTHONPATH`, `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS`,
  `PERL5LIB`, `BASH_ENV`, …) are now **never** forwarded to executed code — even
  if an operator adds one to `CTX_EXEC_ENV_ALLOW`. Closes a library-injection
  vector that an allowlist alone could be coaxed into re-opening.
- **SSRF connect-time re-validation (TOCTOU close).** `ctx_fetch_and_index` now
  re-checks the resolved IP **at socket-connect time** via a custom DNS lookup,
  so the address the request connects to is the one that was validated — closing
  the DNS-rebinding window between pre-flight validation and connection. (The
  existing default-secure blocking of loopback/RFC1918/link-local/IMDS and
  per-redirect-hop re-validation is unchanged.)
- **Entropy-based redaction catch-all.** Output redaction now also masks bare,
  prefix-less high-entropy secrets (mixed upper/lower/digit, length- and
  entropy-gated) that keyword/known-format matchers miss — while leaving hex
  hashes, UUIDs, and ordinary words intact.

### Notes
- The `@modelcontextprotocol/sdk` dependency transitively pulls an HTTP/OAuth
  stack this stdio server does not use; it remains pinned and should be
  advisory-scanned in CI. `better-sqlite3` runs a native build on install.

## [5.3.0] — 2026-06-09 — Security fixes (red-team trial 1)

Hardened in response to an internal red-team pass. Highlights:

- **Execution is opt-in** (`CTX_ALLOW_EXEC=1`) and the child receives an env
  **allowlist** (was a denylist that forwarded the whole environment, incl.
  secrets from `.env`); returned output is now redaction-scanned.
- **Arbitrary file read fixed** — `ctx_execute_file`/`ctx_index` reads are
  confined to a workspace/cwd allowlist, resolved via realpath (symlink-safe).
- **SSRF fixed** — `ctx_fetch_and_index` blocks loopback/RFC1918/link-local/IMDS
  by default, resolves DNS to detect internal targets, and re-validates on every
  redirect hop; http(s)-only; redirect-capped.
- **Command-injection fixed** — `ctx_deliver` and skill-mode use array-argument
  spawning (no shell string concatenation).
- **MCP boundary validation** — Zod `safeParse` (fail-closed) before every tool,
  plus input bounds (code size, timeout range, batch/query/limit caps).
- **Installer** — default-deny platform registration in non-interactive mode and
  a real `--uninstall`.
- **Performance/correctness** — single-transaction batch indexing (large
  speedup at high row counts), FTS5 query-metacharacter sanitization, chunk
  overlap so boundary facts survive, and compact-by-default tool output.
