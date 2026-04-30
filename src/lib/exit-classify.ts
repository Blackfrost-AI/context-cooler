// src/lib/exit-classify.ts — Map sandbox results to a structured ExecResult.
//
// The categories are documented in README v4.6 § "Exit classification":
//   success            zero exit code
//   timeout            killed because args.timeout elapsed
//   language_unavailable  the runtime executable wasn't found on PATH
//   sandbox_violation  non-zero exit AND stderr looks like a kernel/sandbox
//                      block (operation not permitted / syscall blocked /
//                      seccomp / sandbox-exec deny / EPERM on syscalls).
//                      We're conservative: only flip from runtime_error to
//                      sandbox_violation when stderr clearly says so.
//   runtime_error      anything else with a non-zero exit
//
// This file does NOT classify on its own — it takes a SandboxResult and
// returns the ExecStatus. Pure function, no I/O.

import type { SandboxResult } from "./sandbox";

export type ExecStatus =
  | "success"
  | "runtime_error"
  | "timeout"
  | "sandbox_violation"
  | "language_unavailable";

export interface ExecResult {
  status: ExecStatus;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

// Strings that signal a sandbox/kernel block in stderr.
// Conservative list: only patterns that are ~unambiguous outside our context.
const SANDBOX_PATTERNS: RegExp[] = [
  /operation not permitted/i,
  /permission denied.*\b(seccomp|sandbox|syscall|capability)/i,
  /sandbox-exec.*deny/i,
  /seccomp/i,
  /\bEPERM\b/,
  /kill.*signal.*KILL.*sandbox/i,
];

// Strings that signal the runtime executable was missing.
// Node's spawn raises "ENOENT" when the binary isn't on PATH; bash prints
// "command not found"; some langs fall through to a shell wrapper that
// prints both.
const LANG_UNAVAIL_PATTERNS: RegExp[] = [
  /\bENOENT\b/,
  /command not found/i,
  /no such file or directory.*spawn/i,
  /spawn .* ENOENT/i,
];

export function classify(result: SandboxResult): ExecResult {
  const base: Omit<ExecResult, "status"> = {
    exit_code: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    duration_ms: result.duration,
  };

  if (result.timedOut) {
    return { ...base, status: "timeout" };
  }

  if (result.exitCode === 0) {
    return { ...base, status: "success" };
  }

  const stderr = result.stderr ?? "";

  for (const re of LANG_UNAVAIL_PATTERNS) {
    if (re.test(stderr)) {
      return { ...base, status: "language_unavailable" };
    }
  }

  for (const re of SANDBOX_PATTERNS) {
    if (re.test(stderr)) {
      return { ...base, status: "sandbox_violation" };
    }
  }

  return { ...base, status: "runtime_error" };
}
