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
