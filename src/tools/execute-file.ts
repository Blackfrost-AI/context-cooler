import { z } from "zod";
import * as fs from "fs";
import { executeCode } from "../lib/sandbox";
import { redactSecrets } from "../lib/redact";
import { indexContent } from "../lib/db";
import type { SupportedLanguage } from "../types";

export const executeFileSchema = z.object({
  path: z.string().describe("Absolute file path or relative to project root"),
  language: z
    .enum([
      "javascript", "typescript", "python", "shell",
      "ruby", "go", "rust", "php", "perl", "r", "elixir",
    ])
    .describe("Runtime language for processing the file"),
  code: z
    .string()
    .describe(
      "Code to process FILE_CONTENT variable. Print summary via console.log/print/echo."
    ),
  timeout: z.number().default(30000).describe("Max execution time in ms"),
  intent: z
    .string()
    .optional()
    .describe(
      "What you're looking for. When output is large (>5KB), returns only matching sections."
    ),
});

export type ExecuteFileInput = z.infer<typeof executeFileSchema>;

export async function handleExecuteFile(args: ExecuteFileInput) {
  const filePath = args.path;

  if (!fs.existsSync(filePath)) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: `File not found: ${filePath}`,
          }),
        },
      ],
    };
  }

  const fileContent = fs.readFileSync(filePath, "utf-8");

  // Inject FILE_CONTENT as environment variable or inline
  let wrappedCode: string;
  const lang = args.language as SupportedLanguage;

  switch (lang) {
    case "python":
      wrappedCode = `import os\nFILE_CONTENT = ${JSON.stringify(fileContent)}\n${args.code}`;
      break;
    case "javascript":
    case "typescript":
      wrappedCode = `const FILE_CONTENT = ${JSON.stringify(fileContent)};\n${args.code}`;
      break;
    case "ruby":
      wrappedCode = `FILE_CONTENT = ${JSON.stringify(fileContent)}\n${args.code}`;
      break;
    case "shell":
      // For shell, export as env var
      wrappedCode = `export FILE_CONTENT=${JSON.stringify(fileContent)}\n${args.code}`;
      break;
    case "php":
      wrappedCode = `$FILE_CONTENT = ${JSON.stringify(fileContent)};\n${args.code}`;
      break;
    case "perl":
      wrappedCode = `my $FILE_CONTENT = ${JSON.stringify(fileContent)};\n${args.code}`;
      break;
    case "elixir":
      wrappedCode = `file_content = ${JSON.stringify(fileContent)}\n${args.code}`;
      break;
    default:
      wrappedCode = args.code;
  }

  const result = await executeCode(lang, wrappedCode, args.timeout);

  if (result.timedOut) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: `Execution timed out after ${args.timeout}ms`,
          }),
        },
      ],
    };
  }

  const output = result.stdout;
  const rawBytes = Buffer.byteLength(fileContent, "utf-8");
  const summaryBytes = Buffer.byteLength(output, "utf-8");

  // Index the file content
  if (rawBytes > 100) {
    const redacted = redactSecrets(fileContent);
    indexContent("file", filePath, redacted);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: result.exitCode === 0,
          file: filePath,
          file_bytes: rawBytes,
          output: output.slice(0, 10000),
          output_bytes: summaryBytes,
          savings_pct:
            rawBytes > 0
              ? Math.round(((rawBytes - summaryBytes) / rawBytes) * 1000) / 10
              : 0,
          indexed: rawBytes > 100,
          ...(result.stderr ? { stderr: result.stderr.slice(0, 500) } : {}),
          ...(result.exitCode !== 0 ? { exit_code: result.exitCode } : {}),
        }),
      },
    ],
  };
}
