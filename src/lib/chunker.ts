/**
 * Markdown/text chunker for FTS5 indexing.
 * Splits content by headings (keeping code blocks intact)
 * and returns labeled chunks suitable for indexing.
 */

const MAX_CHUNK_SIZE = 4096;

export interface Chunk {
  label: string;
  content: string;
}

export function chunkMarkdown(text: string, source: string): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = text.split("\n");

  let currentLabel = source;
  let currentLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Track code blocks to avoid splitting inside them
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      currentLines.push(line);
      continue;
    }

    // Split on headings (only outside code blocks)
    if (!inCodeBlock && /^#{1,6}\s/.test(line)) {
      // Flush current chunk
      if (currentLines.length > 0) {
        const content = currentLines.join("\n").trim();
        if (content) {
          chunks.push(...splitLargeChunk(currentLabel, content));
        }
      }
      currentLabel = line.replace(/^#+\s*/, "").trim();
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  // Flush final chunk
  if (currentLines.length > 0) {
    const content = currentLines.join("\n").trim();
    if (content) {
      chunks.push(...splitLargeChunk(currentLabel, content));
    }
  }

  return chunks;
}

export function chunkPlainText(text: string, source: string): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i += 50) {
    const slice = lines.slice(i, i + 50).join("\n").trim();
    if (slice) {
      chunks.push({
        label: `${source} (lines ${i + 1}-${Math.min(i + 50, lines.length)})`,
        content: slice,
      });
    }
  }

  return chunks;
}

export function chunkJson(text: string, source: string): Chunk[] {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const chunks: Chunk[] = [];
      for (const [key, value] of Object.entries(parsed)) {
        const content = JSON.stringify(value, null, 2);
        chunks.push(...splitLargeChunk(`${source}.${key}`, content));
      }
      return chunks;
    }
  } catch {
    // Not valid JSON — fall through to plain text
  }
  return chunkPlainText(text, source);
}

function splitLargeChunk(label: string, content: string): Chunk[] {
  if (content.length <= MAX_CHUNK_SIZE) {
    return [{ label, content }];
  }

  const chunks: Chunk[] = [];
  let part = 1;
  for (let i = 0; i < content.length; i += MAX_CHUNK_SIZE) {
    chunks.push({
      label: `${label} (part ${part})`,
      content: content.slice(i, i + MAX_CHUNK_SIZE),
    });
    part++;
  }
  return chunks;
}

export function autoChunk(
  text: string,
  source: string,
  contentType?: string
): Chunk[] {
  if (contentType?.includes("json") || text.trimStart().startsWith("{")) {
    return chunkJson(text, source);
  }

  // Detect markdown by heading presence
  if (/^#{1,6}\s/m.test(text)) {
    return chunkMarkdown(text, source);
  }

  return chunkPlainText(text, source);
}
