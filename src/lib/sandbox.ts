import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SupportedLanguage } from "../types";

const DEFAULT_TIMEOUT = 30000;
const MAX_OUTPUT = 100 * 1024 * 1024; // 100MB cap

// CC-S6-007 fix: env ALLOWLIST (was a denylist that forwarded the entire
// environment — incl. secrets loaded from <home>/.env — to executed code).
// Only these names are passed by default; the operator can add more with
// CTX_EXEC_ENV_ALLOW (comma-separated). Everything else (cloud creds, tokens)
// is withheld from the child.
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "CONTEXT_COOLER_HOME",
]);

// Loader-influence variables are NEVER forwarded to the child — even if an
// operator adds one to CTX_EXEC_ENV_ALLOW. Setting any of these lets
// attacker-controlled libraries/code be injected into the interpreter at startup
// (LD_PRELOAD, PYTHONPATH, NODE_OPTIONS, JAVA_TOOL_OPTIONS, …). A denylist-based
// isolator that forgets one of these is bypassable (the gap context-mode left
// open, S2-001); an allowlist already excludes them, and this hard-deny makes it
// impossible to re-introduce them through the allowlist escape hatch.
const LOADER_DENY = new Set([
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_PROFILE",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
  "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME",
  "NODE_OPTIONS", "NODE_PATH",
  "RUBYOPT", "RUBYLIB", "PERL5LIB", "PERL5OPT",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH",
  "BASH_ENV", "ENV", "SHELLOPTS", "GLOBIGNORE", "GIT_SSH_COMMAND",
]);

// CC-S5-001 mitigation: code execution is a privileged capability and the MCP
// host cannot review the code before it runs. It is OPT-IN — refused unless the
// operator explicitly sets CTX_ALLOW_EXEC=1.
export function isExecAllowed(): boolean {
  return process.env.CTX_ALLOW_EXEC === "1";
}

// --- First-cut OS sandbox ---------------------------------------------------
// "Contain where the OS provides a real primitive; refuse where it doesn't."
//   - Linux:  bubblewrap (bwrap)   -> no-network, writable jail only, no $HOME,
//             read-only system dirs, fresh namespaces, die-with-parent.
//   - macOS:  sandbox-exec         -> deny network + writes outside the jail.
//   - else:   no first-class sandbox -> exec is REFUSED by default. The operator
//             must set CTX_ALLOW_UNSANDBOXED=1 to run with no containment (only on
//             an isolated host they control). This flips the prior default of
//             "runs unsandboxed when enabled" to fail-closed.
// NOTE: the bwrap/sandbox-exec wrappers are a first cut and should be validated
// on Linux/macOS before being relied upon for hostile code; the fail-closed
// default is the platform-independent, verified guarantee.
export type SandboxBackend = "bwrap" | "sandbox-exec" | "none";
let _backend: SandboxBackend | null = null;

export function getSandboxBackend(): SandboxBackend {
  if (_backend) return _backend;
  const override = process.env.CTX_SANDBOX_BACKEND as SandboxBackend | undefined;
  if (override) {
    _backend = override; // test/operator override
    return _backend;
  }
  if (process.platform === "linux") {
    try {
      const r = spawnSync("bwrap", ["--version"], { timeout: 2000 });
      _backend = !r.error && r.status === 0 ? "bwrap" : "none";
    } catch {
      _backend = "none";
    }
  } else if (process.platform === "darwin") {
    _backend = fs.existsSync("/usr/bin/sandbox-exec") ? "sandbox-exec" : "none";
  } else {
    _backend = "none";
  }
  return _backend;
}

// Reset cache (tests).
export function _resetSandboxBackend(): void {
  _backend = null;
}

function allowUnsandboxed(): boolean {
  return process.env.CTX_ALLOW_UNSANDBOXED === "1";
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  duration: number;
}

function execDisabledResult(start: number): SandboxResult {
  return {
    stdout: "",
    stderr:
      "code execution is disabled. Set CTX_ALLOW_EXEC=1 to enable (this tool runs code with the agent's privileges — enable only on a host you control).",
    exitCode: 126,
    timedOut: false,
    duration: Date.now() - start,
  };
}

function noSandboxResult(start: number, backend: SandboxBackend): SandboxResult {
  return {
    stdout: "",
    stderr:
      `refusing to execute: no OS sandbox is available on this platform (backend='${backend}'). ` +
      "A real sandbox needs bubblewrap (bwrap) on Linux or sandbox-exec on macOS. " +
      "Without it, code would run with the agent's full privileges and no containment. " +
      "Install a sandbox backend, or set CTX_ALLOW_UNSANDBOXED=1 to override — only on an isolated host you control.",
    exitCode: 126,
    timedOut: false,
    duration: Date.now() - start,
  };
}

export function sanitizeEnv(): Record<string, string> {
  // CC-S6-007 fix: allowlist, not denylist. Pass only the minimal runtime vars
  // plus any explicitly opted-in by the operator via CTX_EXEC_ENV_ALLOW — but
  // NEVER a loader-influence var (LOADER_DENY), even if it was opted in.
  const extra = (process.env.CTX_EXEC_ENV_ALLOW || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = new Set([...ENV_ALLOWLIST, ...extra]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (LOADER_DENY.has(key)) continue; // hard-deny, overrides the allowlist
    if (allow.has(key)) {
      env[key] = value;
    }
  }
  return env;
}

interface Jail {
  dir: string;
  cleanup: () => void;
}

function makeJail(preferredCwd?: string): Jail {
  // The jail dir is the ONLY writable location the sandbox grants. If the caller
  // supplied an in-scope cwd (e.g. a project dir to compute over), use it so
  // legitimate file access still works; otherwise create a fresh temp dir.
  if (preferredCwd) {
    return { dir: preferredCwd, cleanup: () => {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-jail-"));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

interface Wrapped {
  cmd: string;
  args: string[];
  cleanup?: () => void;
}

// Wrap a command for the active sandbox backend. The jail dir is the only
// writable path; network is denied.
function wrapForSandbox(
  backend: SandboxBackend,
  cmd: string,
  args: string[],
  jailDir: string
): Wrapped {
  if (backend === "bwrap") {
    const bwrapArgs = [
      "--ro-bind-try", "/usr", "/usr",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/sbin", "/sbin",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/etc", "/etc",
      "--ro-bind-try", "/opt", "/opt",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--bind", jailDir, jailDir,
      "--chdir", jailDir,
      "--unshare-all", // new net/pid/ipc/uts/user namespaces — no network
      "--die-with-parent",
      "--new-session",
      "--",
      cmd,
      ...args,
    ];
    return { cmd: "bwrap", args: bwrapArgs };
  }
  if (backend === "sandbox-exec") {
    // deny-by-default profile: allow process + reads, allow writes only to the
    // jail and the system temp dirs, deny all network.
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow file-read*)",
      `(allow file-write* (subpath ${JSON.stringify(jailDir)}) (subpath "/private/tmp") (subpath "/private/var/tmp") (subpath "/dev"))`,
      "(deny network*)",
    ].join("\n");
    const profPath = path.join(os.tmpdir(), `ctx-sb-${process.pid}-${jailDir.length}.sb`);
    fs.writeFileSync(profPath, profile);
    return {
      cmd: "sandbox-exec",
      args: ["-f", profPath, cmd, ...args],
      cleanup: () => {
        try {
          fs.unlinkSync(profPath);
        } catch {
          /* ignore */
        }
      },
    };
  }
  // backend === "none": only reached when CTX_ALLOW_UNSANDBOXED=1 (caller-gated).
  return { cmd, args };
}

export async function executeCode(
  language: SupportedLanguage,
  code: string,
  timeout: number = DEFAULT_TIMEOUT,
  cwd?: string,
  extraEnv?: Record<string, string>
): Promise<SandboxResult> {
  const start = Date.now();

  if (!isExecAllowed()) return execDisabledResult(start);

  const backend = getSandboxBackend();
  if (backend === "none" && !allowUnsandboxed()) return noSandboxResult(start, backend);

  const env = sanitizeEnv();
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
  }

  const jail = makeJail(cwd);
  const { cmd, args, cleanup } = buildCommand(language, code, jail.dir);
  const w = wrapForSandbox(backend, cmd, args, jail.dir);
  const combinedCleanup = () => {
    if (cleanup) cleanup();
    if (w.cleanup) w.cleanup();
    jail.cleanup();
  };
  return runSpawn(w.cmd, w.args, { timeout, cwd: jail.dir, env, cleanup: combinedCleanup, start });
}

// CC-S2-003 fix: execute an explicit argv with NO shell (used by skill mode so
// the skill `cmd` is never concatenated into a `bash -c` string).
export async function executeArgv(
  cmd: string,
  argv: string[],
  timeout: number = DEFAULT_TIMEOUT,
  cwd?: string,
  extraEnv?: Record<string, string>
): Promise<SandboxResult> {
  const start = Date.now();
  if (!isExecAllowed()) return execDisabledResult(start);

  const backend = getSandboxBackend();
  if (backend === "none" && !allowUnsandboxed()) return noSandboxResult(start, backend);

  const env = sanitizeEnv();
  if (extraEnv) for (const [k, v] of Object.entries(extraEnv)) env[k] = v;

  const jail = makeJail(cwd);
  const w = wrapForSandbox(backend, cmd, argv, jail.dir);
  const combinedCleanup = () => {
    if (w.cleanup) w.cleanup();
    jail.cleanup();
  };
  return runSpawn(w.cmd, w.args, { timeout, cwd: jail.dir, env, cleanup: combinedCleanup, start });
}

// Quote-aware argument splitter (POSIX-ish). Avoids a shell entirely.
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === " " || c === "\t" || c === "\n") { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c; has = true;
  }
  if (has) out.push(cur);
  return out;
}

interface SpawnOpts {
  timeout: number;
  cwd?: string;
  env: Record<string, string>;
  cleanup?: () => void;
  start: number;
}

function runSpawn(cmd: string, args: string[], opts: SpawnOpts): Promise<SandboxResult> {
  const { timeout, cwd, env, cleanup, start } = opts;
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

function buildCommand(
  language: SupportedLanguage,
  code: string,
  tmpDir: string = os.tmpdir()
): CommandSpec {
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
      // Go requires writing to a file — write it inside the jail so it is
      // visible to the sandboxed process (a host /tmp file would not be).
      const tmpFile = path.join(tmpDir, `ctx_${Date.now()}.go`);
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
      // Rust requires writing to a file and compiling — keep both inside the jail.
      const srcFile = path.join(tmpDir, `ctx_${Date.now()}.rs`);
      const binFile = srcFile.replace(".rs", "");
      fs.writeFileSync(srcFile, code);
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
    process.env.CONTEXT_COOLER_HOME || os.homedir(),
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
