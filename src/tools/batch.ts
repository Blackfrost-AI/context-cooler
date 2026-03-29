import { z } from "zod";
import { handleExecute } from "./execute";
import { searchIndex } from "../lib/db";

export const batchSchema = z.object({
  commands: z
    .array(
      z.object({
        label: z
          .string()
          .describe("Section header for this command's output"),
        language: z
          .enum([
            "javascript", "typescript", "python", "shell",
            "ruby", "go", "rust", "php", "perl", "r", "elixir",
          ])
          .default("shell")
          .describe("Runtime language"),
        code: z.string().optional().describe("Code to execute"),
        command: z.string().optional().describe("Shell command to execute"),
        skill: z.string().optional().describe("OpenClaw skill name"),
        cmd: z.string().optional().describe("Command for the skill"),
        intent: z.string().optional().describe("Intent filter"),
        fields: z.string().optional().describe("Comma-separated fields"),
      })
    )
    .min(1)
    .describe("Commands to execute as a batch"),
  queries: z
    .array(z.string())
    .min(1)
    .describe(
      "Search queries to extract information from indexed output. Put ALL your questions here."
    ),
  timeout: z
    .number()
    .default(60000)
    .describe("Max execution time in ms (total for all commands)"),
});

export type BatchInput = z.infer<typeof batchSchema>;

export async function handleBatch(args: BatchInput) {
  const results: Array<{ label: string; success: boolean; output: string }> = [];
  let totalRawBytes = 0;
  let totalSummaryBytes = 0;
  let succeeded = 0;
  let failed = 0;

  const perCommandTimeout = Math.floor(args.timeout / args.commands.length);

  for (const cmd of args.commands) {
    try {
      const code = cmd.code || cmd.command || "";
      const execResult = await handleExecute({
        language: cmd.language || "shell",
        code,
        timeout: perCommandTimeout,
        intent: cmd.intent,
        fields: cmd.fields,
        skill: cmd.skill,
        cmd: cmd.cmd,
      });

      const text =
        execResult.content[0]?.type === "text"
          ? execResult.content[0].text
          : "";

      try {
        const parsed = JSON.parse(text);
        totalRawBytes += parsed.raw_bytes || 0;
        totalSummaryBytes += parsed.summary_bytes || 0;
        if (parsed.success) {
          succeeded++;
        } else {
          failed++;
        }
        results.push({
          label: cmd.label,
          success: parsed.success,
          output: text,
        });
      } catch {
        succeeded++;
        results.push({ label: cmd.label, success: true, output: text });
      }
    } catch (err) {
      failed++;
      results.push({
        label: cmd.label,
        success: false,
        output: JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  }

  // Execute search queries against indexed content
  const searchResults: Array<{
    query: string;
    results: Array<{ source: string; label: string; content: string }>;
  }> = [];

  for (const query of args.queries) {
    const hits = searchIndex(query, undefined, 5);
    searchResults.push({
      query,
      results: hits.map((h) => ({
        source: h.source,
        label: h.label,
        content: h.content.slice(0, 2000),
      })),
    });
  }

  const bytesSaved = Math.max(0, totalRawBytes - totalSummaryBytes);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: failed === 0,
          commands_run: args.commands.length,
          commands_succeeded: succeeded,
          commands_failed: failed,
          total_raw_bytes: totalRawBytes,
          total_summary_bytes: totalSummaryBytes,
          total_bytes_saved: bytesSaved,
          total_savings_pct:
            totalRawBytes > 0
              ? Math.round((bytesSaved / totalRawBytes) * 1000) / 10
              : 0,
          results,
          search_results: searchResults,
        }),
      },
    ],
  };
}
