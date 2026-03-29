import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SupportedLanguage } from "../types";

const DEFAULT_TIMEOUT = 30000;
const MAX_OUTPUT = 100 * 1024 * 1024; // 100MB cap

// Dangerous env vars to strip from subprocess
const ENV_DENYLIST = new Set([
  "BASH_ENV",
  "ENV",
  "BASH_FUNC_",
  "CDPATH",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "RUBYOPT",
  "PERL5OPT",
  "PERL5LIB",
  "GOFLAGS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  duration: number;
}

function sanitizeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    let denied = false;
    for (const deny of ENV_DENYLIST) {
      if (key === deny || key.startsWith(deny)) {
        denied = true;
        break;
      }
    }
    if (!denied) {
      env[key] = value;
    }
  }
  return env;
}

export async function executeCode(
  language: SupportedLanguage,
  code: string,
  timeout: number = DEFAULT_TIMEOUT,
  cwd?: string
): Promise<SandboxResult> {
  const start = Date.now();
  const env = sanitizeEnv();

  const { cmd, args, cleanup } = buildCommand(language, code);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const proc = spawn(cmd, args, {
      cwd: cwd || os.tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      timeout: undefined, // We handle timeout ourselves
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) {
        try {
          // Kill process group on Unix
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Already dead
          }
        }
      }
    }, timeout);

    proc.stdout.on("data", (data: Buffer) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += data.toString();
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += data.toString();
      }
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cleanup) cleanup();
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        timedOut,
        duration: Date.now() - start,
      });
    };

    proc.on("close", (code) => finish(code));
    proc.on("error", (err) => {
      stderr += `\nSpawn error: ${err.message}`;
      finish(1);
    });
  });
}

export async function executeShellCommand(
  command: string,
  timeout: number = DEFAULT_TIMEOUT,
  cwd?: string
): Promise<SandboxResult> {
  return executeCode("shell", command, timeout, cwd);
}

interface CommandSpec {
  cmd: string;
  args: string[];
  cleanup?: () => void;
}

function buildCommand(language: SupportedLanguage, code: string): CommandSpec {
  switch (language) {
    case "javascript":
      return { cmd: "node", args: ["-e", code] };
    case "typescript":
      return { cmd: "npx", args: ["tsx", "-e", code] };
    case "python":
      return { cmd: "python3", args: ["-c", code] };
    case "shell":
      return { cmd: "bash", args: ["-c", code] };
    case "ruby":
      return { cmd: "ruby", args: ["-e", code] };
    case "php":
      return { cmd: "php", args: ["-r", code] };
    case "perl":
      return { cmd: "perl", args: ["-e", code] };
    case "r":
      return { cmd: "Rscript", args: ["-e", code] };
    case "elixir":
      return { cmd: "elixir", args: ["-e", code] };
    case "go": {
      // Go requires writing to a temp file
      const tmpFile = path.join(os.tmpdir(), `ctx_${Date.now()}.go`);
      fs.writeFileSync(tmpFile, code);
      return {
        cmd: "go",
        args: ["run", tmpFile],
        cleanup: () => {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            /* ignore */
          }
        },
      };
    }
    case "rust": {
      // Rust requires writing to temp file and compiling
      const srcFile = path.join(os.tmpdir(), `ctx_${Date.now()}.rs`);
      const binFile = srcFile.replace(".rs", "");
      fs.writeFileSync(srcFile, code);
      // Return a shell command that compiles and runs
      return {
        cmd: "bash",
        args: [
          "-c",
          `rustc --edition 2021 -o "${binFile}" "${srcFile}" && "${binFile}"`,
        ],
        cleanup: () => {
          try {
            fs.unlinkSync(srcFile);
          } catch {
            /* ignore */
          }
          try {
            fs.unlinkSync(binFile);
          } catch {
            /* ignore */
          }
        },
      };
    }
    default:
      return { cmd: "bash", args: ["-c", code] };
  }
}

export function findSkillScript(skillName: string): string | null {
  // Validate skill name
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(skillName)) {
    return null;
  }

  const skillsDir = path.join(
    process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"),
    "workspace",
    "skills",
    skillName,
    "scripts"
  );

  if (!fs.existsSync(skillsDir)) return null;

  // Priority order for script discovery
  const candidates = [
    `${skillName.replace(/-/g, "_")}_cli.py`,
    "cli.py",
    "main.py",
    `${skillName.replace(/-/g, "_")}.py`,
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(skillsDir, candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  // Fallback: first .py file alphabetically
  try {
    const files = fs
      .readdirSync(skillsDir)
      .filter((f) => f.endsWith(".py"))
      .sort();
    if (files.length > 0) {
      return path.join(skillsDir, files[0]);
    }
  } catch {
    /* ignore */
  }

  return null;
}
