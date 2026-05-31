// HTML → Markdown conversion used by both ctx_index and ctx_fetch_index.
// Centralized here so raw-HTML input through ctx_index gets the same
// Turndown treatment that URL fetches already received via ctx_fetch_index.

let TurndownService: any;
try {
  TurndownService = require("turndown");
} catch {
  TurndownService = null;
}

export function htmlToMarkdown(html: string): string {
  if (TurndownService) {
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    return td.turndown(html);
  }

  // Fallback if turndown is unavailable: strip tags.
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Conservative sniff: true only for full HTML documents, not MD with
// inline HTML islands. Path extension wins when available; otherwise
// look for DOCTYPE or a structural <html> tag plus a closing tag.
export function isHtmlDocument(text: string, path?: string): boolean {
  if (path) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return true;
  }
  const head = text.slice(0, 500).toLowerCase();
  if (/^\s*<!doctype\s+html/.test(head)) return true;
  if (/^\s*<html[\s>]/.test(head) && /<\/html>/i.test(text)) return true;
  return false;
}
