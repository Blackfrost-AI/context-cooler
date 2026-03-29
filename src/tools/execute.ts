import { z } from "zod";
import { executeCode, findSkillScript, executeShellCommand } from "../lib/sandbox";
import { filterByIntent, filterByFields } from "../lib/filter";
import { redactSecrets } from "../lib/redact";
import { recordRun, indexContent } from "../lib/db";
import { loadEnv } from "../lib/env";
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
    .describe("OpenClaw skill name — if provided, executes the skill's CLI script with --verbose injection"),
  cmd: z
    .string()
    .optional()
    .describe("Command to pass to the skill script (used with 'skill' parameter)"),
});

export type ExecuteInput = z.infer<typeof executeSchema>;

export async function handleExecute(args: ExecuteInput) {
  loadEnv();

  let code = args.code;
  let language = args.language;
  let skillName: string | undefined;
  let commandStr: string | undefined;
  let cwd: string | undefined;

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

    // Verbose injection — get full data for filtering
    const verboseCmd = commandStr.includes("--verbose")
      ? commandStr
      : `${commandStr} --verbose`;

    code = `python3 "${scriptPath}" ${verboseCmd}`;
    language = "shell";
    cwd = scriptPath.substring(0, scriptPath.lastIndexOf("/scripts/"));
  }

  const result = await executeCode(
    language as SupportedLanguage,
    code,
    args.timeout
  );

  if (result.timedOut) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: `Execution timed out after ${args.timeout}ms`,
            stderr: result.stderr.slice(0, 500),
          }),
        },
      ],
    };
  }

  if (result.exitCode !== 0 && !result.stdout) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: `Exit code ${result.exitCode}`,
            stderr: result.stderr.slice(0, 1000),
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
    success: true,
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

  response.raw_bytes = rawBytes;
  response.summary_bytes = summaryBytes;
  response.bytes_saved = bytesSaved;
  response.savings_pct = Math.round(savingsPct * 10) / 10;
  response.indexed = rawBytes > 100;

  if (result.stderr) {
    response.stderr = result.stderr.slice(0, 500);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(response),
      },
    ],
  };
}
