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
const redact = require(path.join(DIST, "lib", "redact.js"));
const sandbox = require(path.join(DIST, "lib", "sandbox.js"));
const execute = require(path.join(DIST, "tools", "execute.js"));
const fetchIndex = require(path.join(DIST, "tools", "fetch-index.js"));
const db = require(path.join(DIST, "lib", "db.js"));
const chunker = require(path.join(DIST, "lib", "chunker.js"));
const search = require(path.join(DIST, "tools", "search.js"));
const filter = require(path.join(DIST, "lib", "filter.js"));

// ---- CC-S4-005: path confinement ----
test("S4: assertPathAllowed blocks paths outside allowed roots", () => {
  const outside = path.join(os.tmpdir(), "definitely-outside-" + Date.now(), "secret");
  assert.equal(env.assertPathAllowed(outside).ok, false);
});
test("S4: assertPathAllowed allows the workspace subtree (legit use)", () => {
  const inside = path.join(HOME, "workspace", "skills", "x", "data.txt");
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, "ok");
  assert.equal(env.assertPathAllowed(inside).ok, true);
});

// ---- CC-S3-009: boundary validation ----
test("S3: executeSchema rejects type-confused / missing / bad-enum args", () => {
  assert.equal(execute.executeSchema.safeParse({ language: "javascript", code: 12345 }).success, false);
  assert.equal(execute.executeSchema.safeParse({ language: "shell" }).success, false);
  assert.equal(execute.executeSchema.safeParse({ language: "klingon", code: "x" }).success, false);
  assert.equal(execute.executeSchema.safeParse({ language: "shell", code: "echo ok" }).success, true);
});
test("S3: executeSchema enforces input bounds (timeout range, code size)", () => {
  assert.equal(execute.executeSchema.safeParse({ language: "shell", code: "x", timeout: -1 }).success, false);
  assert.equal(execute.executeSchema.safeParse({ language: "shell", code: "x", timeout: 10 ** 12 }).success, false);
  assert.equal(execute.executeSchema.safeParse({ language: "shell", code: "x".repeat(10_000_001) }).success, false);
  assert.equal(execute.executeSchema.safeParse({ language: "shell", code: "echo ok", timeout: 5000 }).success, true);
});

// ---- CC-S4-005: workspace confinement (NOT the whole home/data dir) ----
test("S4: home-directory secrets are blocked even when data dir defaults to home", () => {
  // simulate a default deploy: data dir = a fake home; a ~/.aws-style path under
  // home but OUTSIDE <home>/workspace must be blocked.
  const prev = process.env.CONTEXT_COOLER_HOME;
  process.env.CONTEXT_COOLER_HOME = HOME;            // <- treated as the "home"/data dir
  delete env.__dummy;                                 // no-op to keep linter calm
  const homeSecret = path.join(HOME, ".aws", "credentials");
  fs.mkdirSync(path.dirname(homeSecret), { recursive: true });
  fs.writeFileSync(homeSecret, "secret");
  // env caches getDataDir(); allowedReadRoots recomputes from process.env each call,
  // and getDataDir() is cached to HOME from module load, so workspace = HOME/workspace.
  const r = env.assertPathAllowed(homeSecret);
  process.env.CONTEXT_COOLER_HOME = prev;
  assert.equal(r.ok, false, "home-dir secret outside workspace must be blocked");
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

// ---- CC-S6-007: redaction strength (match) + no false positives (nomatch) ----
test("S6: redaction catches INI aws secret, JWT, GitHub token, PEM block", () => {
  const ini = redact.redactSecrets("aws_secret_access_key=FAKEfakeFAKEfakeFAKEfakeFAKEfake12345678");
  assert.ok(!ini.includes("FAKEfakeFAKEfakeFAKEfakeFAKEfake12345678"), "INI secret value must be redacted");
  const jwt = redact.redactSecrets("token: eyJhbGciOiJIUzI1Niance.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w");
  assert.ok(jwt.includes("REDACTED"), "JWT redacted");
  const gh = redact.redactSecrets("export GH=ghp_0123456789abcdefABCDEF0123456789abcd");
  assert.ok(!gh.includes("ghp_0123456789abcdefABCDEF0123456789abcd"), "GitHub PAT redacted");
  const pem = redact.redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----");
  assert.ok(pem.includes("[REDACTED PRIVATE KEY]"), "PEM block redacted");
});
test("S6: redaction leaves benign text + JSON intact (no false positives, stays parseable)", () => {
  const benign = '{"status":"ok","count":42,"name":"auth-service","uptime":"99.98%"}';
  const out = redact.redactSecrets(benign);
  assert.equal(out, benign, "benign JSON unchanged");
  // a redacted JSON payload must still parse
  const withSecret = '{"aws_secret_access_key":"FAKEfakeFAKEfakeFAKEfakeFAKEfake12345678","ok":true}';
  const red = redact.redactSecrets(withSecret);
  const parsed = JSON.parse(red);
  assert.equal(parsed.ok, true);
  assert.ok(!red.includes("FAKEfakeFAKEfakeFAKEfakeFAKEfake12345678"));
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
});

// ---- CC-E1: compact-by-default (no full-blob echo) ----
test("E1: compactDefault returns scalars/first-N, not the whole blob", () => {
  assert.deepEqual(filter.compactDefault({ count: 8, positions: [1, 2, 3] }), { count: 8 });
  assert.deepEqual(filter.compactDefault([1, 2, 3, 4, 5, 6, 7]), [1, 2, 3, 4, 5]);
});

// ---- CC-E2: query sanitize + chunk overlap ----
test("E2: FTS query with hyphens (out-of-memory) retrieves (operator neutralized)", async () => {
  const sdb = db.getStatsDb();
  sdb.exec("DELETE FROM fts_index");
  db.indexContentBatch([{ source: "inc", label: "Cache", content: "The cache layer hit an out-of-memory (OOM) condition." }]);
  const r = JSON.parse((await search.handleSearch({ queries: ["out-of-memory cache layer"], limit: 5 })).content[0].text);
  assert.ok(r.queries[0].results_count >= 1, "hyphenated query must retrieve");
});
test("E2: a fact split at the 4096-byte boundary survives in an overlap chunk", () => {
  const filler = "padding words to consume bytes ".repeat(1);
  let body = ""; while (body.length < 4040) body += filler;
  const sentence = "the root cause was a null pointer dereference in the authentication handler segfault marker42.";
  const chunks = chunker.autoChunk("# PM\n" + body + sentence + "\n" + filler.repeat(10), "pm");
  assert.ok(chunks.some((c) => c.content.includes(sentence)), "boundary sentence must appear whole in some chunk");
  db.closeAll();
});

// ---- CC-S5-002: first-cut OS sandbox (fail-closed default) ----
test("S5-sandbox: fail-closed when no OS sandbox backend is available", async () => {
  process.env.CTX_ALLOW_EXEC = "1";
  process.env.CTX_SANDBOX_BACKEND = "none";
  delete process.env.CTX_ALLOW_UNSANDBOXED;
  sandbox._resetSandboxBackend();
  const r = await sandbox.executeCode("shell", "echo hi", 5000);
  assert.equal(r.exitCode, 126, "must refuse when unsandboxed");
  assert.match(r.stderr, /no OS sandbox/i);
  delete process.env.CTX_ALLOW_EXEC;
  delete process.env.CTX_SANDBOX_BACKEND;
  sandbox._resetSandboxBackend();
});
test("S5-sandbox: CTX_ALLOW_UNSANDBOXED=1 passes the sandbox gate (explicit opt-out)", async () => {
  process.env.CTX_ALLOW_EXEC = "1";
  process.env.CTX_SANDBOX_BACKEND = "none";
  process.env.CTX_ALLOW_UNSANDBOXED = "1";
  sandbox._resetSandboxBackend();
  const r = await sandbox.executeCode("shell", "echo hi", 5000);
  assert.ok(!/no OS sandbox/i.test(r.stderr), "override must bypass the sandbox refusal");
  delete process.env.CTX_ALLOW_EXEC;
  delete process.env.CTX_SANDBOX_BACKEND;
  delete process.env.CTX_ALLOW_UNSANDBOXED;
  sandbox._resetSandboxBackend();
});
test("S5-sandbox: getSandboxBackend honors the platform/override detection", () => {
  process.env.CTX_SANDBOX_BACKEND = "bwrap";
  sandbox._resetSandboxBackend();
  assert.equal(sandbox.getSandboxBackend(), "bwrap");
  delete process.env.CTX_SANDBOX_BACKEND;
  sandbox._resetSandboxBackend();
});

// ---- CC-S2-001: loader-influence env vars never forwarded (even if opted in) ----
test("S2: LOADER_DENY vars are stripped even when added to CTX_EXEC_ENV_ALLOW", () => {
  process.env.CTX_EXEC_ENV_ALLOW = "LD_PRELOAD,PYTHONPATH,NODE_OPTIONS,CC_TEST_OK";
  process.env.LD_PRELOAD = "/evil.so";
  process.env.PYTHONPATH = "/evil";
  process.env.NODE_OPTIONS = "--require /evil";
  process.env.CC_TEST_OK = "yes";
  const e = sandbox.sanitizeEnv();
  assert.equal(e.LD_PRELOAD, undefined, "LD_PRELOAD must never pass");
  assert.equal(e.PYTHONPATH, undefined, "PYTHONPATH must never pass");
  assert.equal(e.NODE_OPTIONS, undefined, "NODE_OPTIONS must never pass");
  assert.equal(e.CC_TEST_OK, "yes", "a non-loader opt-in still works");
  delete process.env.CTX_EXEC_ENV_ALLOW;
  delete process.env.LD_PRELOAD;
  delete process.env.PYTHONPATH;
  delete process.env.NODE_OPTIONS;
  delete process.env.CC_TEST_OK;
});

// ---- CC-S6-007: entropy catch-all for bare high-entropy secrets ----
test("S6: entropy catch-all masks a bare secret, leaves hashes/words intact", () => {
  const bare = redact.redactSecrets("token value Ab3xK9pLm2Qr7Ts4Vw8Yz1Bc6De0Fg5 here");
  assert.ok(!bare.includes("Ab3xK9pLm2Qr7Ts4Vw8Yz1Bc6De0Fg5"), "bare high-entropy secret masked");
  const hash = "d41d8cd98f00b204e9800998ecf8427e"; // md5 hex: lower+digit only -> NOT masked
  assert.equal(redact.redactSecrets(hash), hash, "hex hash left intact");
  const word = "internationalizationxyz"; // long word, no digit -> intact
  assert.equal(redact.redactSecrets(word), word, "dictionary-ish word left intact");
});
