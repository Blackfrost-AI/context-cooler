// Regression tests for the trial-1 security + perf fixes. The repo previously
// had ZERO tests. Portable: pure/black-box checks only (no bash/python3/network
// dependency). Run: `node --test` (after `npx tsc`).
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

// isolate the data dir
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
process.env.CONTEXT_COOLER_HOME = HOME;

const env = require(path.join(DIST, "lib", "env.js"));
const sandbox = require(path.join(DIST, "lib", "sandbox.js"));
const execute = require(path.join(DIST, "tools", "execute.js"));
const fetchIndex = require(path.join(DIST, "tools", "fetch-index.js"));
const db = require(path.join(DIST, "lib", "db.js"));
const chunker = require(path.join(DIST, "lib", "chunker.js"));

// ---- CC-S4-005: path confinement ----
test("S4: assertPathAllowed blocks paths outside allowed roots", () => {
  const outside = path.join(os.tmpdir(), "definitely-outside-" + Date.now(), "secret");
  assert.equal(env.assertPathAllowed(outside).ok, false);
});
test("S4: assertPathAllowed allows the data dir", () => {
  const inside = path.join(HOME, "context", "x.txt");
  assert.equal(env.assertPathAllowed(inside).ok, true);
});

// ---- CC-S3-009: boundary validation ----
test("S3: executeSchema rejects type-confused / missing / bad-enum args", () => {
  assert.equal(execute.executeSchema.safeParse({ language: "javascript", code: 12345 }).success, false);
  assert.equal(execute.executeSchema.safeParse({ language: "shell" }).success, false);
  assert.equal(execute.executeSchema.safeParse({ language: "klingon", code: "x" }).success, false);
  assert.equal(execute.executeSchema.safeParse({ language: "shell", code: "echo ok" }).success, true);
});

// ---- CC-S5-001: execution is opt-in ----
test("S5: executeCode refuses unless CTX_ALLOW_EXEC=1", async () => {
  delete process.env.CTX_ALLOW_EXEC;
  const r = await sandbox.executeCode("shell", "echo nope", 5000);
  assert.equal(r.exitCode, 126);
  assert.match(r.stderr, /code execution is disabled/);
});

// ---- CC-SSRF-006: SSRF block (no network needed — blocked pre-connect) ----
test("SSRF: ctx_fetch_index blocks loopback and link-local", async () => {
  for (const url of ["http://127.0.0.1:8765/x", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/"]) {
    const out = JSON.parse((await fetchIndex.handleFetchIndex({ url })).content[0].text);
    assert.equal(out.success, false, url);
    assert.match(out.error, /blocked|private|loopback|link-local/i);
  }
});
test("SSRF: ctx_fetch_index blocks non-http(s) schemes", async () => {
  const out = JSON.parse((await fetchIndex.handleFetchIndex({ url: "file:///etc/passwd" })).content[0].text);
  assert.equal(out.success, false);
});

// ---- CC-E4: indexContentBatch identical rows + cached count ----
test("E4: indexContentBatch indexes rows byte-identical to chunker output", () => {
  const sdb = db.getStatsDb();
  sdb.exec("DELETE FROM fts_index");
  const doc = "# A\nalpha alpha\n# B\n" + "beta ".repeat(2000) + "\n# C\ngamma";
  const chunks = chunker.autoChunk(doc, "t");
  db.indexContentBatch(chunks.map((c) => ({ source: "t", label: c.label, content: c.content })));
  const rows = sdb.prepare("SELECT label, content FROM fts_index WHERE source=? ORDER BY rowid").all("t");
  const expect = chunks.map((c) => ({ label: c.label, content: c.content }));
  assert.deepEqual(rows, expect);
});
test("E4: re-indexing same source+label dedups (no duplicate rows)", () => {
  const sdb = db.getStatsDb();
  sdb.exec("DELETE FROM fts_index");
  db.indexContentBatch([{ source: "s", label: "L", content: "v1" }]);
  db.indexContentBatch([{ source: "s", label: "L", content: "v2" }]);
  const rows = sdb.prepare("SELECT content FROM fts_index WHERE source='s' AND label='L'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "v2");
  db.closeAll();
});
