# Changelog

All notable changes to Context Cooler are documented here.

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
