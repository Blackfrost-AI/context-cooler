import { z } from "zod";
import { hybridRecall } from "../lib/recall";
import { getDataDir } from "../lib/env";

export const searchSchema = z.object({
  queries: z
    .array(z.string().max(2000))
    .min(1)
    .max(50) // CC-S3-009: bound query flood
    .describe("Array of search queries. Batch ALL questions in one call. Hybrid recall searches FTS + session events + snapshots with synonym expand and recency boost."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50) // CC-S3-009: bound result-set size
    .default(5)
    .describe("Results per query (default: 5)"),
  source: z
    .string()
    .optional()
    .describe("Filter FTS hits to a specific indexed source (disables event hybrid for that query)"),
  mode: z
    .enum(["hybrid", "fts"])
    .default("hybrid")
    .describe("hybrid (default): FTS + session events/snapshots + recency; fts: keyword index only"),
});

export type SearchInput = z.infer<typeof searchSchema>;

export async function handleSearch(args: SearchInput) {
  const allResults: Array<{
    query: string;
    results_count: number;
    results: Array<{
      kind?: string;
      source: string;
      label: string;
      content: string;
      timestamp: string;
      score?: number;
    }>;
  }> = [];

  for (const query of args.queries) {
    const hits = hybridRecall(query, {
      limit: args.limit,
      source: args.source,
      includeEvents: args.mode !== "fts" && !args.source,
    });

    // mode=fts: keep only FTS rows
    const filtered =
      args.mode === "fts" ? hits.filter((h) => h.kind === "fts") : hits;

    allResults.push({
      query,
      results_count: filtered.length,
      results: filtered.map((h) => ({
        kind: h.kind,
        source: h.source,
        label: h.label,
        content: h.content,
        timestamp: h.timestamp,
        score: h.score,
      })),
    });
  }

  const totalResults = allResults.reduce((sum, r) => sum + r.results_count, 0);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          mode: args.mode ?? "hybrid",
          data_dir: getDataDir(),
          total_results: totalResults,
          queries: allResults,
        }),
      },
    ],
  };
}
