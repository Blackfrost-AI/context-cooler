/**
 * Intent-driven filtering — ported from ctx_run.py
 *
 * Extracts only relevant data from API responses based on a natural language intent.
 * Uses keyword scoring against JSON keys and values — no ML, no embeddings.
 */

export function filterByIntent(data: unknown, intent: string): unknown {
  if (!intent || data === null || data === undefined) return data;

  const intentLower = intent.toLowerCase();
  const keywords = intentLower.split(/\s+/).filter((k) => k.length > 1);

  // Extract numeric limit from "top N" / "first N" patterns
  let limit = 5;
  for (const kw of keywords) {
    const n = parseInt(kw, 10);
    if (!isNaN(n) && n > 0 && n < 1000) {
      limit = n;
      break;
    }
  }

  // Handle "summary" / "brief" — return only scalar fields
  const isSummary =
    keywords.includes("summary") || keywords.includes("brief");

  if (Array.isArray(data)) {
    return filterArray(data, keywords, limit, isSummary);
  }

  if (typeof data === "object" && data !== null) {
    return filterObject(data as Record<string, unknown>, keywords, limit, isSummary);
  }

  return data;
}

function filterArray(
  items: unknown[],
  keywords: string[],
  limit: number,
  isSummary: boolean
): unknown[] {
  if (items.length === 0) return items;

  const scored = items.map((item) => ({
    item,
    score: scoreItem(item, keywords),
  }));

  scored.sort((a, b) => b.score - a.score);

  const filtered = scored.slice(0, limit).map((s) => {
    if (isSummary && typeof s.item === "object" && s.item !== null) {
      return extractScalars(s.item as Record<string, unknown>);
    }
    return s.item;
  });

  return filtered;
}

function filterObject(
  obj: Record<string, unknown>,
  keywords: string[],
  limit: number,
  isSummary: boolean
): unknown {
  // Check for wrapper dict pattern: {"count": 8, "positions": [...]}
  // If there's exactly one array value, recurse into it and wrap scalars around
  const entries = Object.entries(obj);
  const arrayEntries = entries.filter(([, v]) => Array.isArray(v));

  if (arrayEntries.length === 1) {
    const [arrayKey, arrayVal] = arrayEntries[0];
    const scalarEntries = entries.filter(([, v]) => !Array.isArray(v) && typeof v !== "object");

    const filteredArray = filterArray(
      arrayVal as unknown[],
      keywords,
      limit,
      isSummary
    );

    const result: Record<string, unknown> = {};
    for (const [k, v] of scalarEntries) {
      result[k] = v;
    }
    result[arrayKey] = filteredArray;
    return result;
  }

  // Pure dict — score each key and return top matches
  if (isSummary) {
    return extractScalars(obj);
  }

  const scored = entries.map(([key, value]) => ({
    key,
    value,
    score: scoreKey(key, value, keywords),
  }));

  scored.sort((a, b) => b.score - a.score);

  const result: Record<string, unknown> = {};
  for (const entry of scored.slice(0, limit)) {
    result[entry.key] = entry.value;
  }
  return result;
}

function scoreItem(item: unknown, keywords: string[]): number {
  let score = 0;
  const itemStr = JSON.stringify(item).toLowerCase();

  for (const kw of keywords) {
    if (itemStr.includes(kw)) {
      score += 1;
    }
  }

  // Semantic boosters
  if (typeof item === "object" && item !== null) {
    const obj = item as Record<string, unknown>;

    // "losing" / "loss" — boost negative P&L
    if (
      keywords.some((k) => k === "losing" || k === "loss" || k === "negative")
    ) {
      const pnl =
        parseFloat(String(obj.pnl ?? obj.unrealized_pl ?? obj.day_pnl ?? 0));
      if (pnl < 0) score += 5;
    }

    // "top" / "best" / "biggest" — boost by magnitude
    if (keywords.some((k) => k === "top" || k === "best" || k === "biggest")) {
      const changePct = parseFloat(
        String(obj.change_pct ?? obj.pnl ?? obj.change ?? 0)
      );
      score += Math.abs(changePct);
    }

    // "winning" / "gain" — boost positive P&L
    if (
      keywords.some((k) => k === "winning" || k === "gain" || k === "positive")
    ) {
      const pnl =
        parseFloat(String(obj.pnl ?? obj.unrealized_pl ?? obj.day_pnl ?? 0));
      if (pnl > 0) score += 5;
    }
  }

  return score;
}

function scoreKey(key: string, value: unknown, keywords: string[]): number {
  let score = 0;
  const keyLower = key.toLowerCase();
  const valueStr = String(value).toLowerCase();

  for (const kw of keywords) {
    if (keyLower.includes(kw)) {
      score += 2; // Key matches worth more
    }
    if (valueStr.includes(kw)) {
      score += 1;
    }
  }

  return score;
}

function extractScalars(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      result[key] = value;
    }
  }
  return result;
}

// High-signal nested keys that coding agents need after compact. Scalars-only
// compact (pre-v6) dropped decisions/next_steps/errors — the exact facts that
// "memory trash" complaints were about. Full output is still FTS-indexed; this
// only decides what re-enters the context window when no intent/fields is set.
const HIGH_SIGNAL_KEYS = new Set([
  "decisions",
  "decision",
  "next_steps",
  "nextsteps",
  "next",
  "todos",
  "todo",
  "goals",
  "goal",
  "errors",
  "error",
  "error_details",
  "failures",
  "failure",
  "issues",
  "findings",
  "recommendations",
  "blocked",
  "warnings",
  "warning",
  "memory",
  "summary",
  "result",
  "results",
  "status",
  "message",
  "files_changed",
  "files",
  "plan",
  "action",
  "actions",
]);

const MAX_NESTED_ITEMS = 5;
const MAX_NESTED_BYTES = 1500;

function shrinkNested(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, MAX_NESTED_ITEMS).map((item) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        return extractScalars(item as Record<string, unknown>);
      }
      if (typeof item === "string" && item.length > 200) return item.slice(0, 200) + "…";
      return item;
    });
  }
  if (typeof value === "object" && value !== null) {
    const scalars = extractScalars(value as Record<string, unknown>);
    if (Object.keys(scalars).length > 0) return scalars;
    // keep a tiny shape preview
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 5)) {
      out[k] = typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v;
    }
    return out;
  }
  if (typeof value === "string" && value.length > 300) return value.slice(0, 300) + "…";
  return value;
}

// CC-E1 + v6 memory fix: compact-by-default when NO intent/fields is given.
// Scalars always included; high-signal nested keys kept in shrunk form so the
// agent does not lose decisions/errors/next_steps just because it forgot to
// pass intent. Full blob remains in FTS for ctx_search.
export function compactDefault(data: unknown): unknown {
  if (Array.isArray(data)) return data.slice(0, 5);
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const out: Record<string, unknown> = { ...extractScalars(obj) };

    let nestedBudget = MAX_NESTED_BYTES;
    for (const [key, value] of Object.entries(obj)) {
      if (out[key] !== undefined) continue; // already a scalar
      if (!HIGH_SIGNAL_KEYS.has(key.toLowerCase())) continue;
      const shrunk = shrinkNested(value);
      const cost = Buffer.byteLength(JSON.stringify(shrunk), "utf-8");
      if (cost > nestedBudget) {
        // still surface the key so the agent knows it exists and can search
        out[key] = Array.isArray(value)
          ? `[${value.length} items — use intent/fields or ctx_search]`
          : `[object — use intent/fields or ctx_search]`;
        continue;
      }
      out[key] = shrunk;
      nestedBudget -= cost;
    }

    if (Object.keys(out).length > 0) return out;

    // no scalars and no high-signal keys — return the first 5 keys so the shape is visible
    for (const [k, v] of Object.entries(obj).slice(0, 5)) out[k] = v;
    return out;
  }
  return data;
}

export function filterByFields(
  data: unknown,
  fields: string[]
): unknown {
  if (!fields.length) return data;

  const fieldSet = new Set(fields.map((f) => f.trim().toLowerCase()));

  if (Array.isArray(data)) {
    return data.map((item) => filterByFields(item, fields));
  }

  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (fieldSet.has(key.toLowerCase())) {
        result[key] = value;
      }
    }
    return result;
  }

  return data;
}
