import { z } from "zod";
import { execSync } from "child_process";
import * as https from "https";
import * as http from "http";
import { loadEnv } from "../lib/env";

export const deliverSchema = z.object({
  text: z.string().describe("Message text to deliver"),
  to: z
    .array(z.string())
    .optional()
    .describe("Recipients (phone numbers, chat IDs). Repeatable."),
  backend: z
    .enum(["auto", "imessage", "telegram", "slack", "discord"])
    .default("auto")
    .describe("Delivery backend (default: auto-detect)"),
});

export type DeliverInput = z.infer<typeof deliverSchema>;

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

function isImsgAvailable(): boolean {
  try {
    execSync("which imsg", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectBackend(): string {
  const env = loadEnv();
  if (isImsgAvailable()) return "imessage";
  if (env.TELEGRAM_BOT_TOKEN) return "telegram";
  if (env.SLACK_WEBHOOK_URL) return "slack";
  if (env.DISCORD_WEBHOOK_URL) return "discord";
  return "none";
}

function sendImessage(to: string, text: string): { status: string; detail: string } {
  if (!E164_REGEX.test(to)) {
    return { status: "failed", detail: `Invalid phone number: ${to}` };
  }

  try {
    execSync(`imsg send --to "${to}" --text "${text.replace(/"/g, '\\"')}"`, {
      timeout: 15000,
      stdio: "ignore",
    });
    return { status: "delivered", detail: "delivered" };
  } catch (err) {
    return {
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function postJson(
  url: string,
  payload: Record<string, unknown>
): Promise<{ status: string; detail: string }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const client = url.startsWith("https") ? https : http;
    const urlObj = new URL(url);

    const req = client.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 10000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: "delivered", detail: `HTTP ${res.statusCode}` });
          } else {
            resolve({
              status: "failed",
              detail: `HTTP ${res.statusCode}: ${body.slice(0, 200)}`,
            });
          }
        });
      }
    );
    req.on("error", (err) => {
      resolve({ status: "failed", detail: err.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: "failed", detail: "Request timed out" });
    });
    req.write(data);
    req.end();
  });
}

async function sendTelegram(
  to: string,
  text: string
): Promise<{ status: string; detail: string }> {
  const env = loadEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { status: "failed", detail: "TELEGRAM_BOT_TOKEN not set" };

  const chatId = to || env.TELEGRAM_CHAT_ID;
  if (!chatId) return { status: "failed", detail: "No chat ID provided" };

  return postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  });
}

async function sendSlack(
  text: string
): Promise<{ status: string; detail: string }> {
  const env = loadEnv();
  const url = env.SLACK_WEBHOOK_URL;
  if (!url) return { status: "failed", detail: "SLACK_WEBHOOK_URL not set" };

  return postJson(url, { text });
}

async function sendDiscord(
  text: string
): Promise<{ status: string; detail: string }> {
  const env = loadEnv();
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return { status: "failed", detail: "DISCORD_WEBHOOK_URL not set" };

  return postJson(url, { content: text });
}

export async function handleDeliver(args: DeliverInput) {
  const backend =
    args.backend === "auto" ? detectBackend() : args.backend;

  if (backend === "none") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error:
              "No delivery backend available. Install imsg (macOS) or set TELEGRAM_BOT_TOKEN, SLACK_WEBHOOK_URL, or DISCORD_WEBHOOK_URL.",
          }),
        },
      ],
    };
  }

  const recipients = args.to || ["default"];
  const results: Array<{
    backend: string;
    to: string;
    status: string;
    detail: string;
  }> = [];

  for (const recipient of recipients) {
    let result: { status: string; detail: string };

    switch (backend) {
      case "imessage":
        result = sendImessage(recipient, args.text);
        break;
      case "telegram":
        result = await sendTelegram(recipient, args.text);
        break;
      case "slack":
        result = await sendSlack(args.text);
        break;
      case "discord":
        result = await sendDiscord(args.text);
        break;
      default:
        result = { status: "failed", detail: `Unknown backend: ${backend}` };
    }

    results.push({ backend, to: recipient, ...result });
  }

  const allDelivered = results.every((r) => r.status === "delivered");

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: allDelivered,
          deliveries: results,
        }),
      },
    ],
  };
}
