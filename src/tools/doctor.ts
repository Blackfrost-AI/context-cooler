import { z } from "zod";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getDataDir, getContextDir, isFtsEnabled, isAutoLogEnabled, getSnapshotBudget } from "../lib/env";
import { getStatsDb, getSessionsDb } from "../lib/db";
import { getSandboxBackend } from "../lib/sandbox";
import { getSessionId } from "./session";
import { listFragments } from "../lib/migrate";
import * as os from "os";

// v4.6: where install.py records the timestamp of the most recent install
// or `--update`. We read this LOCAL file (no network) and surface a
// reminder if it's older than 30 days. Lives under <data dir>/context/ so
// install.py and doctor.ts agree on one location.
const LAST_UPGRADE_PATH = path.join(
  getDataDir(),
  "context",
  "last-upgrade.txt"
);
const UPGRADE_REMINDER_DAYS = 30;

export const doctorSchema = z.object({});

export type DoctorInput = z.infer<typeof doctorSchema>;

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function checkRuntime(name: string, cmd: string): Check {
  try {
    const version = execSync(`${cmd} --version 2>/dev/null`, {
      timeout: 5000,
    })
      .toString()
      .trim()
      .split("\n")[0];
    return { name, status: "ok", detail: version };
  } catch {
    return { name, status: "warn", detail: "not installed" };
  }
}

export async function handleDoctor(_args: DoctorInput) {
  const checks: Check[] = [];

  // Check data directory
  const home = getDataDir();
  if (fs.existsSync(home)) {
    checks.push({
      name: "Data directory",
      status: "ok",
      detail: home,
    });
  } else {
    checks.push({
      name: "Data directory",
      status: "fail",
      detail: `${home} does not exist`,
    });
  }

  // Check context directory
  const ctxDir = getContextDir();
  checks.push({
    name: "Context directory",
    status: fs.existsSync(ctxDir) ? "ok" : "fail",
    detail: ctxDir,
  });

  // Check stats.db
  try {
    const db = getStatsDb();
    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM runs").get() as { cnt: number }
    ).cnt;
    checks.push({
      name: "stats.db",
      status: "ok",
      detail: `${count} runs recorded`,
    });
  } catch (err) {
    checks.push({
      name: "stats.db",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Check FTS5
  if (isFtsEnabled()) {
    try {
      const db = getStatsDb();
      const count = (
        db.prepare("SELECT COUNT(*) as cnt FROM fts_index").get() as {
          cnt: number;
        }
      ).cnt;
      checks.push({
        name: "FTS5 index",
        status: "ok",
        detail: `${count} documents indexed`,
      });
    } catch {
      checks.push({
        name: "FTS5 index",
        status: "warn",
        detail: "FTS5 not available in this SQLite build",
      });
    }
  } else {
    checks.push({
      name: "FTS5 index",
      status: "warn",
      detail: "Disabled via CTX_FTS_ENABLED=0",
    });
  }

  // Check sessions.db
  try {
    const db = getSessionsDb();
    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM events").get() as {
        cnt: number;
      }
    ).cnt;
    const snaps = (
      db.prepare("SELECT COUNT(*) as cnt FROM snapshots").get() as {
        cnt: number;
      }
    ).cnt;
    checks.push({
      name: "sessions.db",
      status: count === 0 ? "warn" : "ok",
      detail:
        count === 0
          ? `0 events / ${snaps} snapshots — memory continuity is empty; log events or leave CTX_AUTO_LOG on (default)`
          : `${count} events, ${snaps} snapshots (session ${getSessionId()}, budget ${getSnapshotBudget()} B)`,
    });
  } catch (err) {
    checks.push({
      name: "sessions.db",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  checks.push({
    name: "Auto-log (CTX_AUTO_LOG)",
    status: "ok",
    detail: isAutoLogEnabled()
      ? "on — successful ctx_execute summaries are written to sessions.db"
      : "off (CTX_AUTO_LOG=0) — snapshots will be empty unless you ctx_session log manually",
  });

  // Fragmented data dirs (multiple brains problem)
  try {
    const frags = listFragments();
    const active = getContextDir();
    const others = frags.filter((f) => f.path !== active);
    if (others.length === 0) {
      checks.push({
        name: "Data fragmentation",
        status: "ok",
        detail: `single active context dir: ${active}`,
      });
    } else {
      checks.push({
        name: "Data fragmentation",
        status: "warn",
        detail: `${others.length} extra data home(s): ${others
          .map((f) => `${f.path} (fts=${f.fts_rows},events=${f.events})`)
          .join("; ")}. Run ctx_migrate action=merge_all dry_run=false after setting CONTEXT_COOLER_HOME.`,
      });
    }
  } catch (err) {
    checks.push({
      name: "Data fragmentation",
      status: "warn",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Grok compact hooks
  {
    const hookPath = path.join(os.homedir(), ".grok", "hooks", "context-cooler.json");
    if (fs.existsSync(hookPath)) {
      checks.push({
        name: "Grok compact hooks",
        status: "ok",
        detail: hookPath,
      });
    } else {
      checks.push({
        name: "Grok compact hooks",
        status: "warn",
        detail:
          "not installed — run install.py or: node dist/adapters/index.js install-hooks --server=<dist/server.js>",
      });
    }
  }

  // Check skills directory
  const skillsDir = path.join(home, "workspace", "skills");
  if (fs.existsSync(skillsDir)) {
    try {
      const skills = fs
        .readdirSync(skillsDir)
        .filter((f) =>
          fs.statSync(path.join(skillsDir, f)).isDirectory()
        );
      checks.push({
        name: "Skills directory",
        status: "ok",
        detail: `${skills.length} skills found`,
      });
    } catch {
      checks.push({
        name: "Skills directory",
        status: "warn",
        detail: "Could not read skills directory",
      });
    }
  } else {
    checks.push({
      name: "Skills directory",
      status: "warn",
      detail: `${skillsDir} does not exist`,
    });
  }

  // Check runtimes
  checks.push(checkRuntime("Node.js", "node"));
  checks.push(checkRuntime("Python", "python3"));
  checks.push(checkRuntime("Ruby", "ruby"));
  checks.push(checkRuntime("Go", "go"));
  checks.push(checkRuntime("Rust", "rustc"));

  // Code execution — the flagship ctx_execute is gated behind CTX_ALLOW_EXEC AND a working
  // OS sandbox. A silent "disabled" is the #1 confusion ("why does ctx_execute error?"), so
  // surface the exact state. (The Shadow adapter sets CTX_ALLOW_EXEC=1 by default.)
  {
    const execOn = process.env.CTX_ALLOW_EXEC === "1";
    const unsandboxed = process.env.CTX_ALLOW_UNSANDBOXED === "1";
    const backend = getSandboxBackend();
    if (!execOn) {
      checks.push({
        name: "Code execution",
        status: "warn",
        detail:
          "disabled — set CTX_ALLOW_EXEC=1 to enable ctx_execute (runs sandboxed; enable only on a host you control)",
      });
    } else if (backend === "none" && !unsandboxed) {
      checks.push({
        name: "Code execution",
        status: "warn",
        detail:
          "enabled, but no OS sandbox (bwrap/sandbox-exec) found — ctx_execute fails closed; install a backend or set CTX_ALLOW_UNSANDBOXED=1",
      });
    } else {
      checks.push({
        name: "Code execution",
        status: "ok",
        detail: unsandboxed
          ? "enabled (UNSANDBOXED override — no containment)"
          : `enabled — sandboxed via ${backend}`,
      });
    }
  }

  // Check mcporter
  try {
    const version = execSync("mcporter --version 2>/dev/null", {
      timeout: 5000,
    })
      .toString()
      .trim();
    checks.push({ name: "mcporter", status: "ok", detail: version });
  } catch {
    checks.push({
      name: "mcporter",
      status: "warn",
      detail: "not installed (optional — for MCP bridge)",
    });
  }

  // v4.6: Local upgrade-reminder check. PURELY local file read — no
  // outbound network call. install.py writes the ISO timestamp on every
  // run; we compare to today and warn if older than 30 days.
  try {
    if (fs.existsSync(LAST_UPGRADE_PATH)) {
      const raw = fs.readFileSync(LAST_UPGRADE_PATH, "utf-8").trim();
      const last = Date.parse(raw);
      if (!Number.isNaN(last)) {
        const ageDays = Math.floor((Date.now() - last) / 86400000);
        if (ageDays >= UPGRADE_REMINDER_DAYS) {
          checks.push({
            name: "Upgrade reminder",
            status: "warn",
            detail: `last upgraded ${ageDays} days ago — run \`python3 install.py --update\``,
          });
        } else {
          checks.push({
            name: "Upgrade reminder",
            status: "ok",
            detail: `last upgraded ${ageDays} day(s) ago`,
          });
        }
      } else {
        checks.push({
          name: "Upgrade reminder",
          status: "warn",
          detail: `${LAST_UPGRADE_PATH} is unparseable — run install.py to refresh`,
        });
      }
    } else {
      checks.push({
        name: "Upgrade reminder",
        status: "warn",
        detail: `no last-upgrade timestamp at ${LAST_UPGRADE_PATH} — run install.py to record one`,
      });
    }
  } catch (err) {
    checks.push({
      name: "Upgrade reminder",
      status: "warn",
      detail: `could not read ${LAST_UPGRADE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Check delivery backends
  const env = process.env;
  checks.push({
    name: "iMessage (imsg)",
    status: (() => {
      try {
        execSync("which imsg", { stdio: "ignore" });
        return "ok";
      } catch {
        return "warn";
      }
    })(),
    detail: (() => {
      try {
        execSync("which imsg", { stdio: "ignore" });
        return "available";
      } catch {
        return "not installed";
      }
    })(),
  });

  checks.push({
    name: "Telegram",
    status: env.TELEGRAM_BOT_TOKEN ? "ok" : "warn",
    detail: env.TELEGRAM_BOT_TOKEN ? "configured" : "TELEGRAM_BOT_TOKEN not set",
  });

  checks.push({
    name: "Slack",
    status: env.SLACK_WEBHOOK_URL ? "ok" : "warn",
    detail: env.SLACK_WEBHOOK_URL ? "configured" : "SLACK_WEBHOOK_URL not set",
  });

  checks.push({
    name: "Discord",
    status: env.DISCORD_WEBHOOK_URL ? "ok" : "warn",
    detail: env.DISCORD_WEBHOOK_URL ? "configured" : "DISCORD_WEBHOOK_URL not set",
  });

  const okCount = checks.filter((c) => c.status === "ok").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const failCount = checks.filter((c) => c.status === "fail").length;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: failCount === 0,
          summary: `${okCount} ok, ${warnCount} warnings, ${failCount} failures`,
          checks,
        }),
      },
    ],
  };
}
