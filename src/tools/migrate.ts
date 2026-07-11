import { z } from "zod";
import { getDataDir, getContextDir, getDefaultDataDir } from "../lib/env";
import {
  listFragments,
  mergeAllFragments,
  mergeFragment,
  purgeAllLegacyFragments,
  purgeFragment,
} from "../lib/migrate";

export const migrateSchema = z.object({
  action: z
    .enum(["list", "merge", "merge_all", "purge_legacy"])
    .default("list")
    .describe(
      "list fragments; merge one source; merge_all into canonical home; purge_legacy removes known leftover dirs after merge"
    ),
  source: z
    .string()
    .optional()
    .describe("Absolute path to a context/ directory to merge or purge"),
  dry_run: z
    .boolean()
    .default(true)
    .describe("When true (default), report what would happen without writing/deleting"),
});

export type MigrateInput = z.infer<typeof migrateSchema>;

export async function handleMigrate(args: MigrateInput) {
  const active = getContextDir();
  const dataDir = getDataDir();
  const canonical = getDefaultDataDir();

  if (args.action === "list") {
    const fragments = listFragments();
    const extras = fragments.filter((f) => f.path !== active);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            data_dir: dataDir,
            canonical_data_dir: canonical,
            active_context: active,
            fragments,
            tip:
              extras.length > 0
                ? "Extra data homes found. Run merge_all (dry_run=false) then purge_legacy (dry_run=false). Canonical home is ~/.context-cooler."
                : "Single active brain at " + active,
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

  if (args.action === "purge_legacy") {
    if (args.source) {
      const result = purgeFragment(args.source, args.dry_run !== false);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              dry_run: args.dry_run !== false,
              result,
            }),
          },
        ],
      };
    }
    const out = purgeAllLegacyFragments(args.dry_run !== false);
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

  // merge_all
  const out = mergeAllFragments(args.dry_run !== false);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          dry_run: args.dry_run !== false,
          canonical_data_dir: canonical,
          ...out,
        }),
      },
    ],
  };
}
