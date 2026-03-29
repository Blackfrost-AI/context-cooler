import { z } from "zod";
import { searchIndex } from "../lib/db";

export const searchSchema = z.object({
  queries: z
    .array(z.string())
    .describe("Array of search queries. Batch ALL questions in one call."),
  limit: z
    .number()
    .default(5)
    .describe("Results per query (default: 5)"),
  source: z
    .string()
    .optional()
    .describe("Filter to a specific indexed source (partial match)"),
});

export type SearchInput = z.infer<typeof searchSchema>;

export async function handleSearch(args: SearchInput) {
  const allResults: Array<{
    query: string;
    results_count: number;
    results: Array<{
      source: string;
      label: string;
      content: string;
      timestamp: string;
    }>;
  }> = [];

  for (const query of args.queries) {
    const hits = searchIndex(query, args.source, args.limit);

    allResults.push({
      query,
      results_count: hits.length,
      results: hits.map((h) => ({
        source: h.source,
        label: h.label,
        content: h.content.length > 2000 ? h.content.slice(0, 2000) + "..." : h.content,
        timestamp: h.timestamp,
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
          total_results: totalResults,
          queries: allResults,
        }),
      },
    ],
  };
}
