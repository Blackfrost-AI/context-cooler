/**
 * Markdown/text chunker for FTS5 indexing.
 * Splits content by headings (keeping code blocks intact)
 * and returns labeled chunks suitable for indexing.
 */

const MAX_CHUNK_SIZE = 4096;
// CC-E2 fix: overlap consecutive oversize-split parts so a fact that lands on a
// 4096-byte boundary appears WHOLE in at least one chunk (the blind split
// previously lost boundary-spanning facts entirely — 0% recall on that subset).
const CHUNK_OVERLAP = 256;

export interface Chunk {
  label: string;
  content: string;
}

// CC-B3 fix: chunks are keyed in the FTS index by (source,label), and the
// dedup on insert is last-write-wins. A document with two identical headings
// therefore produced two chunks with the same label and the earlier one was
// silently deleted. Suffix repeats so every label in a document is distinct.
// Deterministic in document order, so re-indexing still replaces rather than
// duplicates.
function disambiguateLabels(chunks: Chunk[]): Chunk[] {
  const seen = new Map<string, number>();
  return chunks.map((c) => {
    const n = (seen.get(c.label) ?? 0) + 1;
    seen.set(c.label, n);
    return n === 1 ? c : { ...c, label: `${c.label} (#${n})` };
  });
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

  return disambiguateLabels(chunks);
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
  const step = MAX_CHUNK_SIZE - CHUNK_OVERLAP;
  for (let i = 0; i < content.length; i += step) {
    chunks.push({
      label: `${label} (part ${part})`,
      content: content.slice(i, i + MAX_CHUNK_SIZE),
    });
    part++;
    if (i + MAX_CHUNK_SIZE >= content.length) break; // last chunk reached the end
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
