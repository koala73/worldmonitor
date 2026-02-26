/**
 * LLM Prompt Injection Sanitizer
 *
 * Strips known prompt-injection patterns from untrusted strings (e.g. RSS
 * headlines) before they are embedded in an LLM prompt.
 *
 * Design philosophy — blocklist of *bad* patterns only:
 *   ✓ Quotes, colons, dashes, em-dashes, ellipses → preserved (normal headlines)
 *   ✓ Unicode letters and emoji → preserved
 *   ✓ Sentence-level punctuation → preserved
 *   ✗ Role markers  (e.g. "SYSTEM:", "### Assistant")   → stripped
 *   ✗ Instruction overrides  ("Ignore previous …")       → stripped
 *   ✗ Model-specific delimiters ("<|im_start|>", etc.)   → stripped
 *   ✗ ASCII / Unicode control characters (U+0000-U+001F, U+007F, U+2028-U+2029) → stripped
 *   ✗ Null bytes, zero-width joiners / non-joiners       → stripped
 *
 * The sanitizer never throws.  If input is not a string it returns '' so
 * callers can safely map over headline arrays without extra guards.
 *
 * Security note:
 * This is a defense-in-depth reduction layer, not a security boundary.
 * Prompt-injection blocklists are inherently bypassable (for example via novel
 * encodings, obfuscation, or semantically malicious content), so callers must
 * keep additional controls in place (strict output validation, model/provider
 * guardrails, and least-privilege tool access).
 *
 * References:
 *   OWASP LLM Top 10 – LLM01: Prompt Injection
 */

// ---------------------------------------------------------------------------
// Patterns that indicate deliberate prompt injection attempts.
// Each entry is a RegExp with the 'gi' flag (global + case-insensitive).
// Order matters: more specific patterns are applied first.
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  // ── Model-specific delimiter tokens ────────────────────────────────────
  // Llama 3 / Groq chat format
  /<\|(?:im_start|im_end|begin_of_text|end_of_text|eot_id|start_header_id|end_header_id)\|>/gi,
  // OpenAI / older GPT delimiters
  /<\|(?:endoftext|fim_prefix|fim_middle|fim_suffix|pad)\|>/gi,
  // Mistral / Mixtral special tokens
  /\[(?:INST|\/INST|SYS|\/SYS)\]/gi,
  // Generic XML-style role wrappers  <system>…</system>
  /<\/?(system|user|assistant|prompt|context|instruction)\b[^>]*>/gi,

  // ── Role override markers ───────────────────────────────────────────────
  // e.g. "SYSTEM: new instructions", "### System:", "[SYSTEM]:"
  // Require the role word to be alone on a line-start (with optional markdown
  // heading / bracket decoration) AND followed by a colon.  Short legitimate
  // headline prefixes like "AI: Nvidia earnings beat" are excluded by
  // requiring ≥2 words after the colon before matching.
  /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\[|\()?\s*(?:system|human|gpt|claude|llm|model|prompt)\s*(?:\]|\))?\s*:/gim,
  // NOTE: "user:", "assistant:", "bot:", "ai:" are intentionally NOT
  // matched here — they appear in legitimate headlines (e.g. "User: Adobe
  // launches enterprise AI suite").  Actual injection content after these
  // prefixes is caught by the explicit instruction-override phrases below.

  // ── Explicit instruction-override phrases ──────────────────────────────
  // "Ignore (all) (previous|above|prior) instructions"
  /ignore\s+(?:all\s+)?(?:previous|above|prior|earlier|the\s+above)\s+instructions?\b/gi,
  // "Disregard …", "Forget …", "Bypass …"
  /(?:disregard|forget|bypass|override|overwrite|skip)\s+(?:all\s+)?(?:previous|above|prior|earlier|your|the)\s+(?:instructions?|prompt|rules?|guidelines?|constraints?|training)\b/gi,
  // "You are now …" / "Act as …" / "Pretend to be …" persona injection
  /(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s+are)|roleplay\s+as|simulate\s+(?:being\s+)?a)\s+(?:a\s+|an\s+)?(?:(?:different|new|another|unrestricted|jailbroken|evil|helpful)\s+)?(?:ai|assistant|model|chatbot|llm|bot|gpt|claude)\b/gi,
  // "Do not follow …", "Do not obey …"
  /do\s+not\s+(?:follow|obey|adhere\s+to|comply\s+with)\s+(?:the\s+)?(?:previous|above|system|original)\s+(?:instructions?|rules?|prompt)\b/gi,
  // "Output your system prompt", "Print your instructions", "Reveal your prompt"
  /(?:output|print|display|reveal|show|repeat|recite|write\s+out)\s+(?:your\s+)?(?:system\s+prompt|instructions?|initial\s+prompt|original\s+prompt|context)\b/gi,

  // ── Prompt boundary characters ─────────────────────────────────────────
  // Sequences of 3+ hyphens/equals used as separator lines
  // (e.g. "---", "===") – legitimate headlines don't use these.
  /^[\-=]{3,}$/gm,
  /^#{3,}\s/gm,
];

// ---------------------------------------------------------------------------
// Role-prefixed instruction-line detection.
// These are handled as a full-line drop to avoid partial leftovers like
// "Assistant: and" after phrase stripping.
// ---------------------------------------------------------------------------

const ROLE_PREFIX_RE = /^\s*(?:#{1,4}\s*)?(?:\[|\()?\s*(?:user|assistant|bot)\s*(?:\]|\))?\s*:\s*/i;
const ROLE_OVERRIDE_STRONG_RE = /\b(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s+are)|roleplay\s+as|simulate\s+(?:being\s+)?a|from\s+now\s+on|do\s+not\s+(?:follow|obey|adhere\s+to|comply\s+with))\b/i;
const ROLE_OVERRIDE_COMMAND_RE = /\b(?:ignore|disregard|forget|bypass|override|overwrite|skip|reveal|output|print|display|show|repeat|recite|write\s+out)\b/i;
const ROLE_OVERRIDE_FOLLOW_RE = /\b(?:follow|obey)\s+(?:all\s+)?(?:the\s+|my\s+|your\s+)?(?:instructions?|prompt|rules?|guidelines?|constraints?)\b/i;
const ROLE_OVERRIDE_TARGET_RE = /\b(?:instructions?|prompt|system|rules?|guidelines?|constraints?|training|context|developer\s+message)\b/i;

function isRolePrefixedInjectionLine(line) {
  if (!ROLE_PREFIX_RE.test(line)) return false;
  if (ROLE_OVERRIDE_STRONG_RE.test(line)) return true;
  if (ROLE_OVERRIDE_FOLLOW_RE.test(line)) return true;
  return ROLE_OVERRIDE_COMMAND_RE.test(line) && ROLE_OVERRIDE_TARGET_RE.test(line);
}

// ---------------------------------------------------------------------------
// Control-character and invisible-character ranges to strip entirely.
// We use a character class rather than individual replaces for performance.
// ---------------------------------------------------------------------------

//  U+0000-U+001F  ASCII control chars (except U+000A newline, U+0009 tab)
//  U+007F         DEL
//  U+00AD         soft hyphen (invisible, used for hidden text tricks)
//  U+200B-U+200D  zero-width space / non-joiner / joiner
//  U+2028-U+2029  Unicode line/paragraph separator (break JSON parsers)
//  U+FEFF         BOM / zero-width no-break space
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\xAD\u200B-\u200D\u2028\u2029\uFEFF]/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize a single string for safe inclusion in an LLM prompt.
 *
 * @param {unknown} input  - The value to sanitize (typically a headline string).
 * @returns {string}       - Cleaned string, safe to embed in a prompt.
 */
export function sanitizeForPrompt(input) {
  if (typeof input !== 'string') return '';

  let s = input;

  // 1. Strip control / invisible characters first (fast pass)
  s = s.replace(CONTROL_CHARS_RE, '');

  // 2. Drop role-prefixed instruction lines as a whole
  s = s
    .split('\n')
    .filter(line => !isRolePrefixedInjectionLine(line))
    .join('\n');

  // 3. Apply each injection pattern
  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex so global regexps work correctly when reused
    pattern.lastIndex = 0;
    s = s.replace(pattern, ' ');
  }

  // 4. Collapse runs of whitespace introduced by replacements, trim edges
  s = s.replace(/\s{2,}/g, ' ').trim();

  return s;
}

/**
 * Sanitize an array of headline strings, dropping any that become empty
 * after sanitization.
 *
 * @param {unknown[]} headlines
 * @returns {string[]}
 */
export function sanitizeHeadlines(headlines) {
  if (!Array.isArray(headlines)) return [];
  return headlines
    .map(sanitizeForPrompt)
    .filter(h => h.length > 0);
}
