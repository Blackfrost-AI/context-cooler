// Regression tests for three FTS-index integrity defects.
//
//   B1  a single indexContentBatch() larger than MAX_INDEX_ROWS drains the
//       table, breaks out of the prune loop, then inserts anyway — destroying
//       every prior row AND overflowing the cap.
//   B2  _ftsCount is a per-PROCESS cache. Several server processes share one
//       stats.db (stdio MCP servers are spawned per client), so a process's
//       cached count never sees another's writes and the cap goes unenforced.
//   B3  chunkMarkdown labels each chunk with its heading text. Two identical
//       headings in one document collide on (source,label) and the dedup
//       DELETE silently drops the earlier chunk — silent recall loss.
//
// Portable black-box checks, same style as security.test.mjs. Run: `node --test`
// (after `npx tsc`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cc-integrity-"));
process.env.CONTEXT_COOLER_HOME = HOME;

const db = require(path.join(DIST, "lib", "db.js"));
const chunker = require(path.join(DIST, "lib", "chunker.js"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

// Mirrors MAX_INDEX_ROWS in src/lib/db.ts.
const CAP = 10000;

const DBPATH = path.join(HOME, "context", "stats.db");

/** Fresh, empty index; also drops the module's cached row count. */
function reset() {
  db.closeAll();
  const h = new Database(DBPATH);
  h.exec("DELETE FROM fts_index");
  h.close();
  db.closeAll();
}

function rows(where = "") {
  const h = new Database(DBPATH, { readonly: true });
  const n = h.prepare(`SELECT COUNT(*) c FROM fts_index ${where}`).get().c;
  h.close();
  return n;
}

function batch(source, n, offset = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ source, label: `${source}-${i + offset}`, content: `body ${i + offset}` });
  }
  return out;
}

// force the table to exist before the first reset()
db.indexContentBatch([{ source: "bootstrap", label: "b", content: "b" }]);

// ---- B1: an oversized batch must not overflow the cap ----
test("B1: a single batch larger than the cap does not overflow it", () => {
  reset();
  db.indexContentBatch(batch("big", CAP + 50));
  assert.ok(
    rows() <= CAP,
    `index holds ${rows()} rows, cap is ${CAP} — oversized batch overflowed the cap`
  );
});

test("B1: an oversized batch keeps the most recent rows, not the earliest", () => {
  reset();
  db.indexContentBatch(batch("big", CAP + 50));
  // FIFO eviction => the LAST CAP labels of the batch survive; the first 50 go.
  assert.equal(rows("WHERE label = 'big-0'"), 0, "oldest row of the batch should be evicted");
  assert.equal(
    rows(`WHERE label = 'big-${CAP + 49}'`),
    1,
    "newest row of the batch must be retained"
  );
});

test("B1: a batch that fits alongside existing rows evicts only what is necessary", () => {
  reset();
  db.indexContentBatch(batch("seed", 500));
  db.indexContentBatch(batch("new", 9600));
  assert.equal(rows(), CAP, "index should be exactly at the cap");
  assert.equal(rows("WHERE source = 'new'"), 9600, "every new row must be present");
  assert.equal(rows("WHERE source = 'seed'"), 400, "only the 100 oldest seed rows evict");
});

// ---- B2: the cap must hold when another process writes to the same db ----
test("B2: cap is enforced against rows written by another process", () => {
  reset();
  db.indexContentBatch([{ source: "p1", label: "a", content: "hello" }]);

  // A second server process inserts directly into the shared stats.db.
  const other = new Database(DBPATH);
  const ins = other.prepare(
    "INSERT INTO fts_index (source,label,content,timestamp) VALUES (?,?,?,?)"
  );
  const tx = other.transaction(() => {
    for (let i = 0; i < CAP - 1; i++) ins.run("p2", `row-${i}`, "x", new Date().toISOString());
  });
  tx();
  other.close();
  assert.equal(rows(), CAP, "precondition: table is exactly at the cap");

  // This process still believes the table holds 1 row.
  db.indexContentBatch([{ source: "p1", label: "b", content: "world" }]);
  assert.ok(
    rows() <= CAP,
    `index holds ${rows()} rows, cap is ${CAP} — stale per-process count let the cap be exceeded`
  );
});

test("B2: single-row indexContent also respects another process's writes", () => {
  reset();
  db.indexContent("p1", "a", "hello");

  const other = new Database(DBPATH);
  const ins = other.prepare(
    "INSERT INTO fts_index (source,label,content,timestamp) VALUES (?,?,?,?)"
  );
  const tx = other.transaction(() => {
    for (let i = 0; i < CAP - 1; i++) ins.run("p2", `row-${i}`, "x", new Date().toISOString());
  });
  tx();
  other.close();

  db.indexContent("p1", "b", "world");
  assert.ok(rows() <= CAP, `index holds ${rows()} rows, cap is ${CAP}`);
});

// ---- B3: duplicate headings must not silently drop a chunk ----
test("B3: duplicate markdown headings produce distinct, retrievable chunks", () => {
  reset();
  const doc = [
    "## Fixed",
    "the FIRST fix: unique-fact-alpha",
    "",
    "## Added",
    "some feature",
    "",
    "## Fixed",
    "the SECOND fix: unique-fact-beta",
  ].join("\n");

  const chunks = chunker.chunkMarkdown(doc, "CHANGELOG.md");
  const labels = chunks.map((c) => c.label);
  assert.equal(
    new Set(labels).size,
    labels.length,
    `chunk labels must be unique within a document, got ${JSON.stringify(labels)}`
  );

  db.indexContentBatch(
    chunks.map((c) => ({ source: "CHANGELOG.md", label: c.label, content: c.content }))
  );

  assert.equal(rows("WHERE source = 'CHANGELOG.md'"), chunks.length, "every chunk must be stored");

  const h = new Database(DBPATH, { readonly: true });
  const stored = h.prepare("SELECT content FROM fts_index WHERE source='CHANGELOG.md'").all();
  h.close();
  const body = stored.map((r) => r.content).join("\n");
  assert.ok(body.includes("unique-fact-alpha"), "first duplicate-heading section was dropped");
  assert.ok(body.includes("unique-fact-beta"), "second duplicate-heading section was dropped");
});

test("B3: re-indexing the same document still replaces rather than duplicates", () => {
  reset();
  const doc = "## Fixed\nv1 alpha\n\n## Fixed\nv1 beta";
  const mk = (d) =>
    chunker.chunkMarkdown(d, "DOC.md").map((c) => ({ source: "DOC.md", label: c.label, content: c.content }));

  db.indexContentBatch(mk(doc));
  const first = rows("WHERE source = 'DOC.md'");
  db.indexContentBatch(mk(doc));
  assert.equal(rows("WHERE source = 'DOC.md'"), first, "re-indexing must not duplicate rows");
});

test.after(() => {
  db.closeAll();
  fs.rmSync(HOME, { recursive: true, force: true });
});
