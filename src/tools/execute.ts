import { z } from "zod";
import * as path from "path";
import { executeCode, executeArgv, splitArgs, findSkillScript, executeShellCommand } from "../lib/sandbox";
import { filterByIntent, filterByFields } from "../lib/filter";
import { redactSecrets } from "../lib/redact";
import { recordRun, indexContent } from "../lib/db";
import { loadEnv } from "../lib/env";
import { classify } from "../lib/exit-classify";
import type { SupportedLanguage } from "../types";

export const executeSchema = z.object({
  language: z
    .enum([
      "javascript", "typescript", "python", "shell",
      "ruby", "go", "rust", "php", "perl", "r", "elixir",
    ])
    .describe("Runtime language for sandboxed execution"),
  code: z
    .string()
    .describe(
      "Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell/PHP), fmt.Println (Go), or IO.puts (Elixir) to output a summary to context."
    ),
  timeout: z
    .number()
    .default(30000)
    .describe("Max execution time in ms"),
  intent: z
    .string()
    .optional()
    .describe(
      "What you're looking for in the output. When provided and output is large (>5KB), only matching data enters context. Full output is indexed for later search."
    ),
  fields: z
    .string()
    .optional()
    .describe("Comma-separated list of fields to extract from JSON output"),
  skill: z
    .string()
    .optional()
    .describe("Skill name — if provided, executes the skill's CLI script with --verbose injection"),
  cmd: z
    .string()
    .optional()
    .describe("Command to pass to the skill script (used with 'skill' parameter)"),
  verbose: z
    .boolean()
    .optional()
    .describe("Include byte-accounting metadata (raw_bytes/summary_bytes/bytes_saved/savings_pct/duration_ms) in the response. Default false (E3/E5: these are cosmetic and bust prompt-cache identity)."),
});

export type ExecuteInput = z.infer<typeof executeSchema>;

export async function handleExecute(args: ExecuteInput) {
  loadEnv();

  let code = args.code;
  let language = args.language;
  let skillName: string | undefined;
  let commandStr: string | undefined;

  let result;
  // If skill is provided, build the command to execute
  if (args.skill) {
    skillName = args.skill;
    commandStr = args.cmd || "";
    const scriptPath = findSkillScript(skillName);
    if (!scriptPath) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Skill '${skillName}' not found or has no script`,
            }),
          },
        ],
      };
    }

    // CC-S2-003 fix: build argv (no shell). The skill `cmd` is split into args
    // and passed as separate argv elements via executeArgv — it is never
    // concatenated into a `bash -c` string. Mirrors ctx_run.py (shlex + shell=false).
    const parts = splitArgs(commandStr);
    if (!parts.includes("--verbose") && !parts.includes("--raw")) {
      parts.push("--verbose"); // forced verbose to get full data for filtering
    }
    const skillCwd = path.dirname(path.dirname(scriptPath)); // <home>/workspace/skills/<name>
    result = await executeArgv("python3", [scriptPath, ...parts], args.timeout, skillCwd);
  } else {
    result = await executeCode(
      language as SupportedLanguage,
      code,
      args.timeout
    );
  }

  // v4.6: classify exit into one of five buckets so MCP clients can
  // differentiate "timed out" from "language missing" from real errors.
  const classified = classify(result);

  if (classified.status === "timeout") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            status: classified.status,
            exit_code: classified.exit_code,
            duration_ms: classified.duration_ms,
            error: `Execution timed out after ${args.timeout}ms`,
            stderr: classified.stderr.slice(0, 500),
          }),
        },
      ],
    };
  }

  if (classified.status !== "success" && !result.stdout) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            status: classified.status,
            exit_code: classified.exit_code,
            duration_ms: classified.duration_ms,
            error: `Exit code ${classified.exit_code} (${classified.status})`,
            stderr: classified.stderr.slice(0, 1000),
          }),
        },
      ],
    };
  }

  const rawOutput = result.stdout;
  const rawBytes = Buffer.byteLength(rawOutput, "utf-8");

  // Try to parse as JSON for filtering
  let parsed: unknown = rawOutput;
  let isJson = false;
  try {
    parsed = JSON.parse(rawOutput);
    isJson = true;
  } catch {
    // Not JSON — use as-is
  }

  // Apply filtering
  let summary: unknown = parsed;

  if (isJson && args.fields) {
    const fieldList = args.fields.split(",").map((f) => f.trim());
    summary = filterByFields(parsed, fieldList);
  } else if (isJson && args.intent) {
    summary = filterByIntent(parsed, args.intent);
  }

  const summaryStr = isJson
    ? JSON.stringify(summary)
    : String(summary).slice(0, 5000);
  const summaryBytes = Buffer.byteLength(summaryStr, "utf-8");
  const bytesSaved = Math.max(0, rawBytes - summaryBytes);
  const savingsPct = rawBytes > 0 ? (bytesSaved / rawBytes) * 100 : 0;

  // Record stats
  if (skillName) {
    recordRun(
      skillName,
      commandStr || code.slice(0, 100),
      args.intent || null,
      rawBytes,
      summaryBytes,
      Math.round(savingsPct * 10) / 10
    );
  }

  // Index in FTS5 if output is substantial
  if (rawBytes > 100) {
    const source = skillName || language;
    const label = commandStr || code.slice(0, 50);
    const redacted = redactSecrets(rawOutput);
    indexContent(source, label, redacted);
  }

  const response: Record<string, unknown> = {
    success: classified.status === "success",
    status: classified.status,
    exit_code: classified.exit_code,
  };

  if (skillName) {
    response.skill = skillName;
    response.command = commandStr;
  }

  if (isJson) {
    response.summary = summary;
  } else {
    response.output = summaryStr;
  }

  // E3/E5 fix: the byte-accounting block + duration_ms are cosmetic, carry the
  // ~48-token wrapper tax every call, and bust prompt-cache byte-identity for
  // repeated calls. Emit them only under verbose. (ctx_batch passes verbose:true
  // so its totals still work; the canonical savings live in ctx_stats.)
  if (args.verbose) {
    response.duration_ms = classified.duration_ms;
    response.raw_bytes = rawBytes;
    response.summary_bytes = summaryBytes;
    response.bytes_saved = bytesSaved;
    response.savings_pct = Math.round(savingsPct * 10) / 10;
    response.indexed = rawBytes > 100;
  }

  if (result.stderr) {
    response.stderr = result.stderr.slice(0, 500);
  }

  // CC-S6-007 fix: redact the model-facing payload too (previously only the FTS
  // index was redacted; raw stdout flowed to the model unredacted). redactSecrets
  // replaces matched runs in-place without adding/removing quotes, so the JSON
  // stays parseable.
  return {
    content: [
      {
        type: "text" as const,
        text: redactSecrets(JSON.stringify(response)),
      },
    ],
  };
}
