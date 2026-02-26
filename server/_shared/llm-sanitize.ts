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
 * The sanitizer never throws. If input is not a string it returns '' so
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

const INJECTION_PATTERNS: RegExp[] = [
  /<\|(?:im_start|im_end|begin_of_text|end_of_text|eot_id|start_header_id|end_header_id)\|>/gi,
  /<\|(?:endoftext|fim_prefix|fim_middle|fim_suffix|pad)\|>/gi,
  /\[(?:INST|\/INST|SYS|\/SYS)\]/gi,
  /<\/?(system|user|assistant|prompt|context|instruction)\b[^>]*>/gi,
  /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\[|\()?\s*(?:system|human|gpt|claude|llm|model|prompt)\s*(?:\]|\))?\s*:/gim,
  /ignore\s+(?:all\s+)?(?:previous|above|prior|earlier|the\s+above)\s+instructions?\b/gi,
  /(?:disregard|forget|bypass|override|overwrite|skip)\s+(?:all\s+)?(?:previous|above|prior|earlier|your|the)\s+(?:instructions?|prompt|rules?|guidelines?|constraints?|training)\b/gi,
  /(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s+are)|roleplay\s+as|simulate\s+(?:being\s+)?a)\s+(?:a\s+|an\s+)?(?:(?:different|new|another|unrestricted|jailbroken|evil|helpful)\s+)?(?:ai|assistant|model|chatbot|llm|bot|gpt|claude)\b/gi,
  /do\s+not\s+(?:follow|obey|adhere\s+to|comply\s+with)\s+(?:the\s+)?(?:previous|above|system|original)\s+(?:instructions?|rules?|prompt)\b/gi,
  /(?:output|print|display|reveal|show|repeat|recite|write\s+out)\s+(?:your\s+)?(?:system\s+prompt|instructions?|initial\s+prompt|original\s+prompt|context)\b/gi,
  /^[\-=]{3,}$/gm,
  /^#{3,}\s/gm,
];

const ROLE_PREFIX_RE = /^\s*(?:#{1,4}\s*)?(?:\[|\()?\s*(?:user|assistant|bot)\s*(?:\]|\))?\s*:\s*/i;
const ROLE_OVERRIDE_STRONG_RE = /\b(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s+are)|roleplay\s+as|simulate\s+(?:being\s+)?a|from\s+now\s+on|do\s+not\s+(?:follow|obey|adhere\s+to|comply\s+with))\b/i;
const ROLE_OVERRIDE_COMMAND_RE = /\b(?:ignore|disregard|forget|bypass|override|overwrite|skip|reveal|output|print|display|show|repeat|recite|write\s+out)\b/i;
const ROLE_OVERRIDE_FOLLOW_RE = /\b(?:follow|obey)\s+(?:all\s+)?(?:the\s+|my\s+|your\s+)?(?:instructions?|prompt|rules?|guidelines?|constraints?)\b/i;
const ROLE_OVERRIDE_TARGET_RE = /\b(?:instructions?|prompt|system|rules?|guidelines?|constraints?|training|context|developer\s+message)\b/i;

function isRolePrefixedInjectionLine(line: string): boolean {
  if (!ROLE_PREFIX_RE.test(line)) return false;
  if (ROLE_OVERRIDE_STRONG_RE.test(line)) return true;
  if (ROLE_OVERRIDE_FOLLOW_RE.test(line)) return true;
  return ROLE_OVERRIDE_COMMAND_RE.test(line) && ROLE_OVERRIDE_TARGET_RE.test(line);
}

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\xAD\u200B-\u200D\u2028\u2029\uFEFF]/g;

export function sanitizeForPrompt(input: unknown): string {
  if (typeof input !== 'string') return '';

  let s = input;
  s = s.replace(CONTROL_CHARS_RE, '');
  s = s
    .split('\n')
    .filter(line => !isRolePrefixedInjectionLine(line))
    .join('\n');

  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    s = s.replace(pattern, ' ');
  }

  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

export function sanitizeHeadlines(headlines: unknown): string[] {
  if (!Array.isArray(headlines)) return [];
  return headlines
    .map(sanitizeForPrompt)
    .filter(h => h.length > 0);
}
