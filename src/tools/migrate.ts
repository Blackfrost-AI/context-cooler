import { z } from "zod";
import { getDataDir, getContextDir } from "../lib/env";
import { listFragments, mergeAllFragments, mergeFragment } from "../lib/migrate";

export const migrateSchema = z.object({
  action: z
    .enum(["list", "merge", "merge_all"])
    .default("list")
    .describe("list fragments, merge one source, or merge_all into the active data dir"),
  source: z
    .string()
    .optional()
    .describe("Absolute path to a context/ directory to merge (for action=merge)"),
  dry_run: z
    .boolean()
    .default(true)
    .describe("When true (default), report what would be copied without writing"),
});

export type MigrateInput = z.infer<typeof migrateSchema>;

export async function handleMigrate(args: MigrateInput) {
  const active = getContextDir();
  const dataDir = getDataDir();

  if (args.action === "list") {
    const fragments = listFragments();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            data_dir: dataDir,
            active_context: active,
            fragments,
            tip:
              fragments.length > 1
                ? "Multiple data homes found — set CONTEXT_COOLER_HOME to one path and run action=merge_all (dry_run=false) to consolidate."
                : "Single (or empty) data home — no fragmentation detected.",
          }),
        },
      ],
    };
  }

  if (args.action === "merge") {
    if (!args.source) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "source is required for action=merge",
              data_dir: dataDir,
            }),
          },
        ],
      };
    }
    const result = mergeFragment(args.source, active, args.dry_run !== false);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            data_dir: dataDir,
            active_context: active,
            dry_run: args.dry_run !== false,
            result,
          }),
        },
      ],
    };
  }

  // merge_all
  const out = mergeAllFragments(args.dry_run !== false);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          dry_run: args.dry_run !== false,
          ...out,
        }),
      },
    ],
  };
}
