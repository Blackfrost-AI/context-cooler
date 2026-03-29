import { z } from "zod";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getOpenClawHome, getContextDir, isFtsEnabled } from "../lib/env";
import { getStatsDb, getSessionsDb } from "../lib/db";

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

  // Check OPENCLAW_HOME
  const home = getOpenClawHome();
  if (fs.existsSync(home)) {
    checks.push({
      name: "OPENCLAW_HOME",
      status: "ok",
      detail: home,
    });
  } else {
    checks.push({
      name: "OPENCLAW_HOME",
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
    checks.push({
      name: "sessions.db",
      status: "ok",
      detail: `${count} events logged`,
    });
  } catch (err) {
    checks.push({
      name: "sessions.db",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
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
      detail: "not installed (optional — for OpenClaw bridge)",
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
