/**
 * Hybrid recall — FTS5 (keyword) + session events + recency.
 * No embeddings/ML deps: expands queries lightly and re-ranks by time so
 * "what did we decide?" can hit recent session logs even when FTS is cold.
 */

import { searchIndex } from "./db";
import { getSessionsDb } from "./db";

export interface RecallHit {
  kind: "fts" | "event" | "snapshot";
  source: string;
  label: string;
  content: string;
  timestamp: string;
  score: number;
}

// Lightweight synonym / stem-ish expansion (no external NLP).
const SYNONYMS: Record<string, string[]> = {
  decide: ["decision", "decisions", "chose", "choice", "picked"],
  decision: ["decide", "decisions", "choice", "chose"],
  decisions: ["decision", "decide", "choice"],
  auth: ["authentication", "jwt", "login", "oauth", "token"],
  authentication: ["auth", "jwt", "login"],
  error: ["errors", "failure", "failed", "exception", "bug"],
  errors: ["error", "failure", "failed"],
  next: ["next_steps", "todo", "todos", "plan"],
  plan: ["next_steps", "todo", "roadmap"],
  blocked: ["block", "blocking", "stuck", "waiting"],
  deploy: ["deployment", "release", "ship"],
  test: ["tests", "testing", "spec", "failing"],
  memory: ["context", "session", "snapshot", "recall"],
  fix: ["fixed", "bugfix", "patch"],
};

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function expandQuery(query: string): string[] {
  const tokens = tokenize(query);
  const expanded = new Set<string>(tokens);
  for (const t of tokens) {
    for (const syn of SYNONYMS[t] || []) expanded.add(syn);
  }
  return [...expanded];
}

function recencyBoost(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const ageH = (now - t) / (1000 * 60 * 60);
  if (ageH < 1) return 5;
  if (ageH < 6) return 3;
  if (ageH < 24) return 2;
  if (ageH < 72) return 1;
  return 0;
}

function keywordScore(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let s = 0;
  for (const term of terms) {
    if (lower.includes(term)) s += 1;
  }
  return s;
}

function searchEvents(terms: string[], limit: number): RecallHit[] {
  const db = getSessionsDb();
  // Pull a recent window and score in process — events table is small vs FTS.
  const rows = db
    .prepare(
      `SELECT timestamp, session_id, event_type, priority, data
       FROM events ORDER BY timestamp DESC LIMIT 200`
    )
    .all() as Array<{
    timestamp: string;
    session_id: string;
    event_type: string;
    priority: string;
    data: string;
  }>;

  const hits: RecallHit[] = [];
  for (const row of rows) {
    const blob = `${row.event_type} ${row.priority} ${row.data}`;
    const kw = keywordScore(blob, terms);
    if (kw === 0 && terms.length > 0) continue;
    const prioBoost =
      row.priority === "critical" ? 3 : row.priority === "high" ? 2 : row.priority === "medium" ? 1 : 0;
    hits.push({
      kind: "event",
      source: `session:${row.session_id}`,
      label: `${row.priority}/${row.event_type}`,
      content: row.data.length > 1500 ? row.data.slice(0, 1500) + "…" : row.data,
      timestamp: row.timestamp,
      score: kw * 2 + prioBoost + recencyBoost(row.timestamp),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function searchSnapshots(terms: string[], limit: number): RecallHit[] {
  const db = getSessionsDb();
  const rows = db
    .prepare(
      `SELECT timestamp, session_id, snapshot, byte_size
       FROM snapshots ORDER BY timestamp DESC LIMIT 20`
    )
    .all() as Array<{
    timestamp: string;
    session_id: string;
    snapshot: string;
    byte_size: number;
  }>;

  const hits: RecallHit[] = [];
  for (const row of rows) {
    const kw = keywordScore(row.snapshot, terms);
    if (kw === 0 && terms.length > 0) continue;
    hits.push({
      kind: "snapshot",
      source: `snapshot:${row.session_id}`,
      label: `snapshot ${row.byte_size}B`,
      content:
        row.snapshot.length > 1500 ? row.snapshot.slice(0, 1500) + "…" : row.snapshot,
      timestamp: row.timestamp,
      score: kw * 2 + recencyBoost(row.timestamp) + 1,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export function hybridRecall(
  query: string,
  opts: { limit?: number; source?: string; includeEvents?: boolean } = {}
): RecallHit[] {
  const limit = opts.limit ?? 5;
  const terms = expandQuery(query);
  const ftsQuery = terms.join(" "); // broader AND-friendly after sanitizeFtsQuery

  const fts = searchIndex(ftsQuery || query, opts.source, Math.max(limit, 10)).map(
    (h) =>
      ({
        kind: "fts" as const,
        source: h.source,
        label: h.label,
        content: h.content.length > 2000 ? h.content.slice(0, 2000) + "…" : h.content,
        timestamp: h.timestamp,
        score: 3 + keywordScore(h.content, terms) + recencyBoost(h.timestamp),
      }) satisfies RecallHit
  );

  const includeEvents = opts.includeEvents !== false && !opts.source;
  const events = includeEvents ? searchEvents(terms, limit) : [];
  const snaps = includeEvents ? searchSnapshots(terms, Math.min(3, limit)) : [];

  // If FTS got nothing, try original query once more (sanitize may have emptied)
  if (fts.length === 0 && ftsQuery !== query) {
    for (const h of searchIndex(query, opts.source, limit)) {
      fts.push({
        kind: "fts",
        source: h.source,
        label: h.label,
        content: h.content.length > 2000 ? h.content.slice(0, 2000) + "…" : h.content,
        timestamp: h.timestamp,
        score: 2 + recencyBoost(h.timestamp),
      });
    }
  }

  const merged = [...fts, ...events, ...snaps];
  // Dedup by content prefix
  const seen = new Set<string>();
  const out: RecallHit[] = [];
  merged.sort((a, b) => b.score - a.score);
  for (const h of merged) {
    const key = `${h.kind}|${h.source}|${h.label}|${h.content.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
