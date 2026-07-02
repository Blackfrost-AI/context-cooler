// Regression tests for the v5.5 adapter changes: the Shadow adapter enables the
// flagship sandboxed ctx_execute (CTX_ALLOW_EXEC=1) by default, while serverEntry's
// env stays empty by default so every other adapter keeps exec opt-in.
// Black-box only (no bash/python3/network). Run: `node --test` (after `npx tsc`).
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

const util = require(path.join(DIST, "adapters", "util.js"));
const { ShadowAdapter } = require(path.join(DIST, "adapters", "shadow.js"));

test("serverEntry: default env is empty (other adapters keep exec opt-in)", () => {
  const e = util.serverEntry("/x/dist/server.js");
  assert.equal(e.type, "stdio");
  assert.equal(e.command, "node");
  assert.deepEqual(e.args, ["/x/dist/server.js"]);
  assert.deepEqual(e.env, {});
});

test("serverEntry: accepts an env override (backwards-compatible param)", () => {
  const e = util.serverEntry("/x/server.js", { CTX_ALLOW_EXEC: "1" });
  assert.deepEqual(e.env, { CTX_ALLOW_EXEC: "1" });
});

test("Shadow adapter: enables sandboxed ctx_execute (CTX_ALLOW_EXEC=1) in the MCP entry", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-shadow-"));
  try {
    const r = new ShadowAdapter().install({
      serverPath: "/x/dist/server.js",
      homeOverride: home,
      dryRun: false,
    });
    assert.equal(r.ok, true, r.detail);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(home, ".shadow", "config.json"), "utf-8"),
    );
    const entry = cfg.mcpServers["context-cooler"];
    assert.ok(entry, "context-cooler entry written under mcpServers");
    assert.equal(entry.command, "node");
    assert.deepEqual(entry.args, ["/x/dist/server.js"]);
    assert.equal(entry.env.CTX_ALLOW_EXEC, "1");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Shadow adapter: dry-run does not write a file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-shadow-dry-"));
  try {
    const r = new ShadowAdapter().install({
      serverPath: "/x/dist/server.js",
      homeOverride: home,
      dryRun: true,
    });
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(path.join(home, ".shadow", "config.json")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
