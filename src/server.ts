#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadEnv } from "./lib/env";
import { closeAll } from "./lib/db";

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { handleExecute, executeSchema } from "./tools/execute";
import { handleExecuteFile, executeFileSchema } from "./tools/execute-file";
import { handleBatch, batchSchema } from "./tools/batch";
import { handleSearch, searchSchema } from "./tools/search";
import { handleIndex, indexSchema } from "./tools/index";
import { handleFetchIndex, fetchIndexSchema } from "./tools/fetch-index";
import { handleSession, sessionSchema } from "./tools/session";
import { handleStats, statsSchema } from "./tools/stats";
import { handleDeliver, deliverSchema } from "./tools/deliver";
import { handleDoctor, doctorSchema } from "./tools/doctor";

// CC-S3-009 fix: validate every tool's args against its Zod schema at the MCP
// boundary. Previously schemas were defined but never .parse()'d (args were
// cast `as any`), so malformed/oversized/type-confused input reached the sinks.
const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  ctx_execute: executeSchema,
  ctx_execute_file: executeFileSchema,
  ctx_batch: batchSchema,
  ctx_search: searchSchema,
  ctx_index: indexSchema,
  ctx_fetch_index: fetchIndexSchema,
  ctx_session: sessionSchema,
  ctx_stats: statsSchema,
  ctx_deliver: deliverSchema,
  ctx_doctor: doctorSchema,
};

loadEnv();

// CC-S9-011 fix: single source of truth for the version (was hardcoded "5.0.0"
// here vs "5.2.0" in package.json/skill.json/install.py). Read package.json at
// startup so the handshake version can never drift again.
const VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
    ).version as string;
  } catch {
    return "0.0.0";
  }
})();

const server = new Server(
  { name: "context-cooler", version: VERSION },
  { capabilities: { tools: {} } }
);

// ── Tool definitions (raw JSON Schema — no Zod type recursion) ──

const TOOLS = [
  {
    name: "ctx_execute",
    description:
      "Execute code in a sandboxed subprocess. Only stdout enters context. Supports 11 languages. Use 'skill' + 'cmd' to execute skills with automatic --verbose injection. Returns a structured result: status (success | runtime_error | timeout | sandbox_violation | language_unavailable), exit_code, duration_ms, plus the filtered stdout summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        language: {
          type: "string",
          enum: ["javascript","typescript","python","shell","ruby","go","rust","php","perl","r","elixir"],
          description: "Runtime language",
        },
        code: { type: "string", description: "Source code to execute" },
        timeout: { type: "number", default: 30000, description: "Max execution time in ms" },
        intent: { type: "string", description: "What you're looking for — filters large output and indexes for later search" },
        fields: { type: "string", description: "Comma-separated fields to extract from JSON output" },
        skill: { type: "string", description: "Skill name (executes skill CLI with --verbose injection)" },
        cmd: { type: "string", description: "Command to pass to the skill script" },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "ctx_execute_file",
    description:
      "Read a file and process it without loading contents into context. FILE_CONTENT variable is available in the sandbox.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Absolute file path" },
        language: {
          type: "string",
          enum: ["javascript","typescript","python","shell","ruby","go","rust","php","perl","r","elixir"],
          description: "Runtime language",
        },
        code: { type: "string", description: "Code to process FILE_CONTENT. Print summary to stdout." },
        timeout: { type: "number", default: 30000, description: "Max execution time in ms" },
        intent: { type: "string", description: "What you're looking for in the output" },
      },
      required: ["path", "language", "code"],
    },
  },
  {
    name: "ctx_batch",
    description:
      "Execute multiple commands in ONE call, auto-index output, and search. THIS IS THE PRIMARY TOOL for multi-step operations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Section header" },
              command: { type: "string", description: "Shell command" },
              language: { type: "string", default: "shell" },
              code: { type: "string" },
              skill: { type: "string" },
              cmd: { type: "string" },
              intent: { type: "string" },
              fields: { type: "string" },
            },
            required: ["label"],
          },
          minItems: 1,
          description: "Commands to execute as a batch",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Search queries to extract information from indexed output",
        },
        timeout: { type: "number", default: 60000, description: "Max total execution time in ms" },
      },
      required: ["commands", "queries"],
    },
  },
  {
    name: "ctx_search",
    description:
      "Search indexed content using FTS5 full-text search. Batch ALL questions in one call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "Search queries" },
        limit: { type: "number", default: 5, description: "Results per query" },
        source: { type: "string", description: "Filter to a specific source" },
      },
    },
  },
  {
    name: "ctx_index",
    description:
      "Index content into searchable BM25 knowledge base. Provide 'content' or 'path', not both.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "Text/markdown to index" },
        path: { type: "string", description: "File path to read and index" },
        source: { type: "string", description: "Label for the content" },
      },
    },
  },
  {
    name: "ctx_fetch_index",
    description:
      "Fetch URL, convert HTML to markdown, index into knowledge base. Returns ~3KB preview.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to fetch and index" },
        source: { type: "string", description: "Label for the content" },
      },
      required: ["url"],
    },
  },
  {
    name: "ctx_session",
    description:
      "Track session events (P1-P4 priority) and create compaction-survival snapshots. Actions: log, snapshot, restore, stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["log", "snapshot", "restore", "stats"],
          description: "Session action",
        },
        event_type: { type: "string", description: "Event type for 'log' action" },
        priority: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          default: "medium",
          description: "Event priority",
        },
        data: { type: "string", description: "JSON data payload for 'log' action" },
      },
      required: ["action"],
    },
  },
  {
    name: "ctx_stats",
    description:
      "Show context consumption statistics: bytes saved, compression ratios, top skills, indexed docs, session events.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "ctx_deliver",
    description:
      "Deliver messages via iMessage, Telegram, Slack, or Discord. Auto-detects available backend.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Message text" },
        to: { type: "array", items: { type: "string" }, description: "Recipients" },
        backend: {
          type: "string",
          enum: ["auto", "imessage", "telegram", "slack", "discord"],
          default: "auto",
          description: "Delivery backend",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "ctx_doctor",
    description:
      "Diagnose installation: runtimes, databases, FTS5, skills, delivery backends, mcporter.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ── Request handlers ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // CC-S3-009 fix: enforce the schema at the boundary before dispatch.
  const schema = TOOL_SCHEMAS[name];
  let parsed: unknown = args;
  if (schema) {
    const result = schema.safeParse(args ?? {});
    if (!result.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "Invalid arguments",
              issues: result.error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            }),
          },
        ],
        isError: true,
      };
    }
    parsed = result.data;
  }

  switch (name) {
    case "ctx_execute":
      return handleExecute(parsed as any);
    case "ctx_execute_file":
      return handleExecuteFile(parsed as any);
    case "ctx_batch":
      return handleBatch(parsed as any);
    case "ctx_search":
      return handleSearch(parsed as any);
    case "ctx_index":
      return handleIndex(parsed as any);
    case "ctx_fetch_index":
      return handleFetchIndex(parsed as any);
    case "ctx_session":
      return handleSession(parsed as any);
    case "ctx_stats":
      return handleStats(parsed as any);
    case "ctx_deliver":
      return handleDeliver(parsed as any);
    case "ctx_doctor":
      return handleDoctor(parsed as any);
    default:
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) },
        ],
        isError: true,
      };
  }
});

// ── Lifecycle ──

process.on("SIGINT", () => { closeAll(); process.exit(0); });
process.on("SIGTERM", () => { closeAll(); process.exit(0); });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
