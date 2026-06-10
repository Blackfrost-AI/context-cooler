import { z } from "zod";
import * as fs from "fs";
import { indexContentBatch } from "../lib/db";
import { redactSecrets } from "../lib/redact";
import { autoChunk } from "../lib/chunker";
import { assertPathAllowed } from "../lib/env";

export const indexSchema = z.object({
  content: z
    .string()
    .optional()
    .describe("Raw text/markdown to index. Provide this OR path, not both."),
  path: z
    .string()
    .optional()
    .describe(
      "File path to read and index (content never enters context). Provide this OR content."
    ),
  source: z
    .string()
    .optional()
    .describe(
      "Label for the indexed content (e.g., 'React useEffect docs', 'Skill: alpaca-trader')"
    ),
});

export type IndexInput = z.infer<typeof indexSchema>;

export async function handleIndex(args: IndexInput) {
  let text: string;
  let source = args.source || "manual";

  if (args.path) {
    // CC-S4-005 fix: confine reads to the allowlisted roots (realpath-checked).
    const allowed = assertPathAllowed(args.path);
    if (!allowed.ok) {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ success: false, error: allowed.reason }) },
        ],
      };
    }
    if (!fs.existsSync(args.path)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `File not found: ${args.path}`,
            }),
          },
        ],
      };
    }
    text = fs.readFileSync(args.path, "utf-8");
    if (!args.source) {
      source = args.path;
    }
  } else if (args.content) {
    text = args.content;
  } else {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: "Provide either 'content' or 'path'",
          }),
        },
      ],
    };
  }

  const redacted = redactSecrets(text);
  const chunks = autoChunk(redacted, source);

  // CC-E4 fix: one transaction for all chunks (was a COUNT scan + autocommit per chunk).
  indexContentBatch(chunks.map((c) => ({ source, label: c.label, content: c.content })));
  const indexed = chunks.length;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          source,
          chunks_indexed: indexed,
          total_bytes: Buffer.byteLength(text, "utf-8"),
          message: `Indexed ${indexed} chunks from '${source}'. Use ctx_search to retrieve.`,
        }),
      },
    ],
  };
}
