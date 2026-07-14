# Self-Hosted / Small-Model Output Trimming

**Status:** Known issue + proposed fix. *Not yet implemented* — documented here so we can
come back to it. Interim mitigation is harness-side only (see below).

## Who this affects

Setups that drive the Claude Code TUI as a **harness for a self-hosted / local model**
(ollama, vLLM, LM Studio, llama.cpp via LiteLLM, etc.) instead of a frontier Anthropic
model. Context Cooler is most valuable exactly here — local context windows are small and
fill fast — so losing the model's trust in the tool is costly.

## Observed problem

A local model (`huihui-q8`, a quantized Qwen) **stopped using `ctx_execute` entirely**
after it saw the tool "swallowing" output, and fell back to raw `Bash`. Net result: zero
token savings *and* the loss of the cooler's guardrails — the opposite of the tool's
purpose.

The model interpreted a trimmed summary as **"my output was lost,"** when in fact the full
output is captured and indexed (FTS5) and is retrievable with `ctx_search`. Frontier models
tend to infer "this is a summary, the rest is on disk"; smaller models do not, and react by
abandoning the tool.

## Root cause

Two things compound:

1. **Trim defaults are aggressive and hard-coded** (not configurable):
   - `src/lib/filter.ts` → `compactDefault()`:
     - arrays → `data.slice(0, 5)` (`filter.ts:197`)
     - objects → scalar fields only, else first 5 keys (`filter.ts:202-204`)
   - `src/lib/filter.ts` → `filterByIntent()` default `limit = 5` for arrays.
   - `src/tools/execute.ts` → non-JSON text → `String(summary).slice(0, 5000)` (`execute.ts:170`).
2. **The response gives no signal that trimming happened or that the full output is
   retrievable.** There is no `truncated` flag and no pointer to `ctx_search`, so a model
   that doesn't already know the cooler's design can't tell a summary from data loss.

## Why it matters

The savings pitch ("70–98% fewer tokens") only pays off if the model *keeps* routing heavy
output through the cooler. For the smaller models that need the savings most, an opaque trim
reads as unreliability and triggers abandonment.

## Interim mitigation (already in place, harness-side only)

The harness operating profile was updated to tell the model explicitly that a trimmed
summary means "the rest is on disk, retrievable with `ctx_search`," with sharper use/don't-use
rules (cooler for *volume to skim*, plain tools for *small or exact* output). This is a
prompt-side band-aid and does **not** help operators who haven't tuned their profile — hence
the code-side fix below.

## Proposed fix (to implement)

1. **Make the caps configurable via env**, following the existing `CTX_*` convention parsed
   in `src/lib/env.ts` (cf. `CTX_SNAPSHOT_BUDGET`, `CTX_FTS_ENABLED`). Defaults = today's
   values, so behavior is unchanged unless an operator opts in:
   - `CTX_MAX_ARRAY_ITEMS` (default `5`) — used by `compactDefault` + `filterByIntent`.
   - `CTX_MAX_OBJECT_KEYS` (default `5`) — used by `compactDefault`.
   - `CTX_MAX_TEXT_CHARS` (default `5000`) — used by the non-JSON path in `execute.ts`.
   This lets a self-hosted operator set e.g. `CTX_MAX_TEXT_CHARS=20000` / `CTX_MAX_ARRAY_ITEMS=25`
   to trade some savings for less surprise.

2. **Add a retrieval hint to the `ctx_execute` response when trimming actually occurred.**
   When `summary_bytes < raw_bytes` (or an array/object/text was cut), include a small,
   cache-friendly note, e.g.:
   ```json
   { "truncated": true, "indexed": true,
     "retrieve_with": "ctx_search(\"<label or intent>\")" }
   ```
   so any model — frontier or local — can see the rest is recoverable and how. Keep it
   terse to avoid prompt-cache churn (see the existing E3/E5 verbose notes in `execute.ts`).

3. **(Optional) A "verbose/self-hosted" profile** — a single env (`CTX_PROFILE=self-hosted`)
   that bumps the three caps together, for operators who don't want to set each one.

## Acceptance criteria

- Existing behavior unchanged with no env set (defaults preserved).
- Operators can raise caps without rebuilding (env only).
- A trimmed `ctx_execute` result clearly signals truncation + how to retrieve the full output.
- Manual check: a small/local model keeps using `ctx_execute` across a session instead of
  falling back to Bash after the first trim.

## References

- `src/lib/filter.ts` — `compactDefault` (`:196`), array/object cuts (`:197`, `:202-204`),
  `filterByIntent` default limit.
- `src/tools/execute.ts:170` — non-JSON 5000-char cut; surrounding byte-accounting block.
- `src/lib/env.ts` — where the new `CTX_*` knobs would be parsed.
