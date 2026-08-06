/**
 * Numbered-list helpers shared by the translate pipeline.
 *
 * The batch translate path (SummarizeArticle mode='translate' with multiple
 * headlines) round-trips translations through a plain-text numbered list:
 * the server composes `1. …\n2. …` from per-headline cache/LLM results and
 * the client parses it back into per-headline strings. Both sides MUST use
 * this module so the framing stays aligned (server/ imports from src/utils
 * the same way summary-cache-key.ts is shared).
 */

export function buildNumberedList(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join('\n');
}

/**
 * Parse a numbered list back into `count` slots. Lines that are missing,
 * empty, or numbered out of range stay null — callers treat null as
 * "untranslated" and keep the original text. Duplicate numbers keep the
 * first occurrence. A single-item request accepts bare (un-numbered) text
 * for backward compatibility with the legacy one-headline translate shape.
 */
export function parseNumberedList(text: string, count: number): Array<string | null> {
  const out: Array<string | null> = new Array(count).fill(null);
  if (!text) return out;
  if (count === 1) {
    // Legacy single-headline responses are bare text, but a model may still
    // echo the numbering — strip it when the whole response is one line.
    const trimmed = text.trim();
    const single = trimmed.match(/^\s*1\s*[.)::.、]\s*(.*\S)\s*$/);
    out[0] = single?.[1] ?? (trimmed.length > 0 ? trimmed : null);
    return out;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d{1,3})\s*[.)::.、]\s*(.*\S)\s*$/);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < count && out[idx] === null) out[idx] = m[2];
  }
  return out;
}
