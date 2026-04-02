/**
 * Shared LLM JSON extraction utilities.
 *
 * Handles the common failure modes of LLM JSON output:
 *   - C-style line and block comments (// ..., /* ... *\/)
 *   - Trailing commas before } and ]
 *   - Partial outputs (brace/bracket extraction as fallback)
 *
 * Note: cleanJsonText strips `//` best-effort and will incorrectly strip
 * URLs inside JSON string values (e.g. "https://..."). Acceptable for LLM output.
 */

/**
 * Strip C-style comments and trailing commas from a JSON-like string.
 */
export function cleanJsonText(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/,(\s*[}\]])/g, '$1')
    .trim();
}

function extractFirstDelimited(text, open, close) {
  const cleaned = cleanJsonText(text);
  const start = cleaned.indexOf(open);
  if (start === -1) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === open) depth++;
    if (char === close && --depth === 0) return cleaned.slice(start, i + 1);
  }
  return cleaned.slice(start);
}

export const extractFirstJsonObject = (text) => extractFirstDelimited(text, '{', '}');
export const extractFirstJsonArray  = (text) => extractFirstDelimited(text, '[', ']');
