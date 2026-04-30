#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadEnv } from "./lib/env";
import { closeAll } from "./lib/db";

import { handleExecute } from "./tools/execute";
import { handleExecuteFile } from "./tools/execute-file";
import { handleBatch } from "./tools/batch";
import { handleSearch } from "./tools/search";
import { handleIndex } from "./tools/index";
import { handleFetchIndex } from "./tools/fetch-index";
import { handleSession } from "./tools/session";
import { handleStats } from "./tools/stats";
import { handleDeliver } from "./tools/deliver";
import { handleDoctor } from "./tools/doctor";

loadEnv();

const server = new Server(
  { name: "context-cooler", version: "5.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool definitions (raw JSON Schema — no Zod type recursion) ──

const TOOLS = [
  {
    name: "ctx_execute",
    description:
      "Execute code in a sandboxed subprocess. Only stdout enters context. Supports 11 languages. Use 'skill' + 'cmd' to execute OpenClaw skills with automatic --verbose injection. Returns a structured result: status (success | runtime_error | timeout | sandbox_violation | language_unavailable), exit_code, duration_ms, plus the filtered stdout summary.",
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
        skill: { type: "string", description: "OpenClaw skill name (executes skill CLI with --verbose injection)" },
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

  switch (name) {
    case "ctx_execute":
      return handleExecute(args as any);
    case "ctx_execute_file":
      return handleExecuteFile(args as any);
    case "ctx_batch":
      return handleBatch(args as any);
    case "ctx_search":
      return handleSearch(args as any);
    case "ctx_index":
      return handleIndex(args as any);
    case "ctx_fetch_index":
      return handleFetchIndex(args as any);
    case "ctx_session":
      return handleSession(args as any);
    case "ctx_stats":
      return handleStats(args as any);
    case "ctx_deliver":
      return handleDeliver(args as any);
    case "ctx_doctor":
      return handleDoctor(args as any);
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
