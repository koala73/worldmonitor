// Edge-safe utility helpers shared across the MCP modules.

// Edge-safe UTF-8 byte counter. Uses `TextEncoder` (Web Platform, available
// unconditionally on Vercel edge) rather than `text.length` (UTF-16 code
// units — undercounts emoji / CJK / accented content) or `Buffer.byteLength`
// (Node intrinsic — not reliably shimmed in every edge runtime).
//
// Used by BOTH JMESPath gates AND `scripts/measure-jmespath-savings.mjs`
// so the runtime contract and the reported PR numbers operate on the same
// byte definition. Exported for the measurement script.
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const MAX_JSON_RPC_ID_BYTES = 256;

/** Normalize a caller-controlled JSON-RPC id to the bounded echo-safe shape. */
export function safeJsonRpcId(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string' || value.length > MAX_JSON_RPC_ID_BYTES) return null;
  return utf8ByteLength(value) <= MAX_JSON_RPC_ID_BYTES ? value : null;
}

// ---------------------------------------------------------------------------
// tools/list description cap
//
// v1.5.0 compressed every tool description to its first sentence (≤120 B)
// and routed agents to `describe_tool` for the full text. Since v1.34.0 the
// registry keeps every description under TOOL_DESCRIPTION_MAX_BYTES
// (test-enforced), so tools/list and describe_tool ship identical text and
// this helper is only a backstop in `buildPublicTool`: a description that
// somehow exceeded the cap at runtime would be cut to its first sentence
// rather than blowing the catalog budget. PROPERTY descriptions are never
// compressed; they carry contract details (defaults, flags, examples).
// ---------------------------------------------------------------------------

// Compress a description string to at most `maxBytes` UTF-8 bytes.
// - If the text already fits, returns it unchanged (identity).
// - Otherwise, extracts the first sentence (terminated by `. ! ?` followed
//   by whitespace or end-of-string) and truncates to the byte cap.
// - If no sentence boundary exists, falls back to plain byte truncation.
// - Never cuts inside a UTF-8 codepoint (uses TextEncoder bytewise walk).
//
// Pure, no I/O. Pure function; idempotent.
export function compressDescription(text: string, maxBytes: number): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (utf8ByteLength(text) <= maxBytes) return text;
  // First-sentence extraction. The /(?:\s|$)/ tail prevents `e.g.` / `i.e.`
  // mis-splits when the abbreviation is mid-sentence (followed by ` ` not
  // `<EOL>`), though it does still split on a leading `e.g. ...` — that
  // edge case is documented in U1 test scenarios. Tool descriptions in
  // TOOL_REGISTRY don't start with abbreviations, audited at write-time.
  const sentenceMatch = text.match(/^[\s\S]+?[.!?](?:\s|$)/);
  const candidate = sentenceMatch ? sentenceMatch[0].trim() : text;
  if (utf8ByteLength(candidate) <= maxBytes) return candidate;
  // Byte-truncate without splitting a codepoint mid-cut. TextEncoder
  // produces one byte per UTF-8 byte; walk codepoints forward and stop
  // when adding the next would exceed maxBytes.
  const encoder = new TextEncoder();
  let out = '';
  let used = 0;
  for (const ch of candidate) {
    const chBytes = encoder.encode(ch).length;
    if (used + chBytes > maxBytes) break;
    out += ch;
    used += chBytes;
  }
  return out;
}
