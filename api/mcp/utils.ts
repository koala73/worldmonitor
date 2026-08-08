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

// ---------------------------------------------------------------------------
// tools/list description compression (v1.5.0)
//
// `tools/list` is the largest fixed per-session input-token cost. v1.4.0's
// catalog is ~41.8 KB UTF-8; ~8 KB of that is tool-level `description`
// prose. The first sentence of a tool description carries nearly all the
// selection signal — the long tail is rarely load-bearing. Compress the
// top-level `description` to first-sentence-or-cap; route LLMs that want
// full text to the new `describe_tool` RPC (added in U3 below).
//
// PROPERTY descriptions are NOT compressed in v1 — audit found 53% of
// them encode contract details (defaults, optional flags, "currently
// supported" lists, examples) where naive compression would regress
// correctness. Deferred to a future PR with a per-property hand-audit.
//
// Both compress + describe_tool surfaces go through `buildPublicTool`
// (added in U2) so there's a single source of truth for the public shape.
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
