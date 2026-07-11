// v6 regression tests: session identity, restore fallback, compactDefault
// high-signal nested keys, snapshot budget default, recent/new actions.
//
// Run: `node --test` (after `npx tsc`).
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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cc-memory-"));
process.env.CONTEXT_COOLER_HOME = HOME;
delete process.env.CTX_SESSION_ID;
delete process.env.CTX_SNAPSHOT_BUDGET;
delete process.env.CTX_AUTO_LOG;

const filter = require(path.join(DIST, "lib", "filter.js"));
const env = require(path.join(DIST, "lib", "env.js"));
const session = require(path.join(DIST, "tools", "session.js"));
const db = require(path.join(DIST, "lib", "db.js"));

// ---- Session ID ----
test("V6-S1: generateSessionId has no trailing dot and uses YYYYMMDD-HHMMSS", () => {
  const id = session.generateSessionId(new Date("2026-07-11T15:53:40.731Z"));
  assert.equal(id, "20260711-155340");
  assert.ok(!id.endsWith("."), "session id must not end with '.'");
  assert.match(id, /^\d{8}-\d{6}$/);
});

test("V6-S1: sticky file with legacy trailing-dot id is migrated", () => {
  const ctx = path.join(HOME, "context");
  fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, ".session_id"), "20260703201901.");
  const id = session.getSessionId();
  assert.ok(!id.endsWith("."), `migrated id still ends with dot: ${id}`);
  assert.equal(id, "20260703-201901");
  assert.equal(fs.readFileSync(path.join(ctx, ".session_id"), "utf-8").trim(), id);
});

test("V6-S1: CTX_SESSION_ID env overrides sticky file", () => {
  process.env.CTX_SESSION_ID = "host-conversation-abc";
  assert.equal(session.getSessionId(), "host-conversation-abc");
  delete process.env.CTX_SESSION_ID;
});

// ---- Snapshot budget ----
test("V6-B1: default snapshot budget is 16KB", () => {
  delete process.env.CTX_SNAPSHOT_BUDGET;
  assert.equal(env.getSnapshotBudget(), 16384);
});

test("V6-B1: CTX_SNAPSHOT_BUDGET is clamped", () => {
  process.env.CTX_SNAPSHOT_BUDGET = "100";
  assert.equal(env.getSnapshotBudget(), 256);
  process.env.CTX_SNAPSHOT_BUDGET = "999999";
  assert.equal(env.getSnapshotBudget(), 65536);
  delete process.env.CTX_SNAPSHOT_BUDGET;
});

// ---- compactDefault preserves high-signal nested keys ----
test("V6-C1: compactDefault keeps decisions/next_steps/errors, not scalars-only", () => {
  const input = {
    success: true,
    summary: "Auth migrated to JWT; 2 tests still failing",
    decisions: [
      { topic: "auth", choice: "use JWT not sessions", reason: "stateless scale" },
      { topic: "db", choice: "sqlite", reason: "local first" },
    ],
    next_steps: ["write tests", "deploy staging", "update docs"],
    error_details: { code: "ECONNREFUSED", host: "db.local", stack: "long..." },
    noise_blob: { a: 1, b: 2, c: 3, d: 4 },
  };
  const out = filter.compactDefault(input);
  assert.equal(out.success, true);
  assert.equal(out.summary, "Auth migrated to JWT; 2 tests still failing");
  assert.ok(out.decisions, "decisions must survive compactDefault");
  assert.ok(Array.isArray(out.decisions) && out.decisions.length >= 1);
  assert.ok(out.next_steps, "next_steps must survive compactDefault");
  assert.ok(out.error_details, "error_details must survive compactDefault");
  assert.equal(out.noise_blob, undefined, "non-high-signal nested keys stay out");
});

test("V6-C1: compactDefault still truncates large arrays to first 5", () => {
  const arr = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(filter.compactDefault(arr), [0, 1, 2, 3, 4]);
});

// ---- restore fallback + recent ----
test("V6-R1: restore falls back to latest snapshot on another session", async () => {
  // isolate session files for this test
  const sidFile = path.join(HOME, "context", ".session_id");
  fs.mkdirSync(path.dirname(sidFile), { recursive: true });
  fs.writeFileSync(sidFile, "session-A");

  // log + snapshot under session-A
  let r = JSON.parse(
    (await session.handleSession({
      action: "log",
      event_type: "decision",
      priority: "critical",
      data: JSON.stringify({ choice: "JWT" }),
    })).content[0].text
  );
  assert.equal(r.success, true);
  assert.equal(r.session_id, "session-A");

  r = JSON.parse((await session.handleSession({ action: "snapshot" })).content[0].text);
  assert.equal(r.success, true);
  assert.ok(r.events_included >= 1, "snapshot should include the logged event");

  // rotate sticky id to empty session-B (no events/snaps)
  fs.writeFileSync(sidFile, "session-B");
  r = JSON.parse((await session.handleSession({ action: "restore" })).content[0].text);
  assert.equal(r.success, true, `restore should succeed via fallback: ${JSON.stringify(r)}`);
  assert.equal(r.fallback, true);
  assert.equal(r.restored_from_session, "session-A");
  assert.ok(r.snapshot, "snapshot payload present");
});

test("V6-R1: recent returns cross-session events when current session is empty", async () => {
  const sidFile = path.join(HOME, "context", ".session_id");
  fs.writeFileSync(sidFile, "session-empty-zzz");
  const r = JSON.parse(
    (await session.handleSession({ action: "recent", limit: 5 })).content[0].text
  );
  assert.equal(r.success, true);
  assert.ok(r.count >= 1, "should find events from other sessions");
  assert.equal(r.cross_session, true);
});

test("V6-R1: action=new rotates session id", async () => {
  const before = session.getSessionId();
  // ensure time advances enough for a distinct second-resolution id
  await new Promise((r) => setTimeout(r, 1100));
  const res = JSON.parse((await session.handleSession({ action: "new" })).content[0].text);
  assert.equal(res.success, true);
  assert.ok(res.session_id);
  assert.notEqual(res.session_id, before);
  assert.match(res.session_id, /^\d{8}-\d{6}$/);
});

test("V6-A1: isAutoLogEnabled defaults on, off with CTX_AUTO_LOG=0", () => {
  delete process.env.CTX_AUTO_LOG;
  assert.equal(env.isAutoLogEnabled(), true);
  process.env.CTX_AUTO_LOG = "0";
  assert.equal(env.isAutoLogEnabled(), false);
  delete process.env.CTX_AUTO_LOG;
});

test.after(() => {
  try {
    db.closeAll();
  } catch {
    /* ignore */
  }
  fs.rmSync(HOME, { recursive: true, force: true });
});
