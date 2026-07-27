// Structural readers for JS/TS source text.
//
// Source-level audits in this repo used to ask "does this token appear
// somewhere in the file?" — which a commented-out entry, a dead duplicate, or
// a token that drifted into a neighbouring container all satisfy. These helpers
// answer the stronger question: "is this token a member of *that* container?"
//
// They are deliberately lexical, not a full parser: comments are blanked with a
// string/template/regex-aware scanner, then containers are located by balanced
// delimiters and split into their top-level entries. Everything fails closed —
// a renamed or deleted container returns null rather than silently widening to
// the rest of the file.

const QUOTE_MODES = { "'": 'squote', '"': 'dquote' };
const CLOSING_QUOTE = { squote: "'", dquote: '"' };

// A `/` starts a regex literal (rather than division) when the previous
// significant character cannot end an expression. Newlines are whitespace here,
// not a reset: `const x = a\n  / b` is division continued across a line, while
// `const re =\n  /abc/` is a regex — the operand before the break is what tells
// them apart.
const REGEX_PRECEDING = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);

/**
 * Replace every comment in `source` with spaces, preserving newlines so the
 * result has the same length and line numbering as the input.
 *
 * Comment-looking text inside string, template, and regex literals is kept.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripJsComments(source) {
  // split('') — NOT [...source]. The spread iterates by code point, so a single
  // surrogate pair (any emoji) makes the buffer shorter than the string and
  // desynchronizes it from the code-unit indices every write here uses
  // (`source[n]`, `indexOf`). The drift blanks the wrong range: it can leave a
  // comment intact while eating real code.
  const out = source.split('');
  const length = source.length;
  const stack = [];
  let prevSignificant = '';
  let i = 0;

  const blank = (from, to) => {
    for (let n = from; n < to; n += 1) {
      if (source[n] !== '\n') out[n] = ' ';
    }
  };

  while (i < length) {
    const mode = stack[stack.length - 1];
    const ch = source[i];

    if (mode === 'squote' || mode === 'dquote') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === CLOSING_QUOTE[mode]) { stack.pop(); prevSignificant = ch; }
      // An unterminated quote would otherwise swallow the rest of the file.
      if (ch === '\n') stack.pop();
      i += 1;
      continue;
    }

    if (mode === 'template') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { stack.pop(); prevSignificant = ch; i += 1; continue; }
      if (ch === '$' && source[i + 1] === '{') { stack.push('interp'); i += 2; continue; }
      i += 1;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? length : end);
      i = end === -1 ? length : end;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && REGEX_PRECEDING.has(prevSignificant)) {
      i += 1;
      let inClass = false;
      while (i < length) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { i += 1; break; }
        i += 1;
      }
      prevSignificant = '/';
      continue;
    }

    if (QUOTE_MODES[ch]) { stack.push(QUOTE_MODES[ch]); i += 1; continue; }
    if (ch === '`') { stack.push('template'); i += 1; continue; }
    if (ch === '{') { stack.push('brace'); }
    if (ch === '}' && (mode === 'brace' || mode === 'interp')) { stack.pop(); }

    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }

  return out.join('');
}

/**
 * Walk `text` (comments already blanked) from `start`, invoking `onCodeChar`
 * only for characters at code level — never for characters *inside* a string or
 * template literal, and never for the `}` that closes a `${}` interpolation.
 *
 * The delimiter that OPENS a string or template IS reported, so a caller
 * matching an anchor can find one that begins with a quote. The closing
 * delimiter is not: it is consumed by the string branch below.
 */
function walkCode(text, start, onCodeChar) {
  const stack = [];
  let i = start;
  while (i < text.length) {
    const mode = stack[stack.length - 1];
    const ch = text[i];

    if (mode === 'squote' || mode === 'dquote') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === CLOSING_QUOTE[mode] || ch === '\n') stack.pop();
      i += 1;
      continue;
    }

    if (mode === 'template') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') stack.pop();
      else if (ch === '$' && text[i + 1] === '{') { stack.push('interp'); i += 2; continue; }
      i += 1;
      continue;
    }

    if (QUOTE_MODES[ch]) stack.push(QUOTE_MODES[ch]);
    else if (ch === '`') stack.push('template');
    else if (ch === '{') stack.push('brace');
    else if (ch === '}') {
      if (mode === 'interp') { stack.pop(); i += 1; continue; }
      if (mode === 'brace') stack.pop();
    }

    if (onCodeChar(ch, i) === false) return;
    i += 1;
  }
}

const IDENTIFIER_CHAR = /[\w$]/;

/**
 * Report whether an anchor match at `index` sits on token boundaries, so an
 * anchor never matches the middle of a longer identifier (`const MAP` must not
 * match `const MAP_V2` — a different container entirely).
 */
function isTokenBoundedMatch(text, anchor, index) {
  const before = text[index - 1];
  if (before !== undefined && IDENTIFIER_CHAR.test(anchor[0]) && IDENTIFIER_CHAR.test(before)) {
    return false;
  }
  const after = text[index + anchor.length];
  const lastAnchorChar = anchor[anchor.length - 1];
  if (after !== undefined && IDENTIFIER_CHAR.test(lastAnchorChar) && IDENTIFIER_CHAR.test(after)) {
    return false;
  }
  return true;
}

/**
 * Return the text between the balanced `open`/`close` delimiters that follow
 * the first code-level occurrence of `anchor`.
 *
 * Returns null — never a wider slice — when the anchor is missing (renamed or
 * commented out), when no opening delimiter follows it, or when the block never
 * closes.
 *
 * @param {string} source
 * @param {string} anchor
 * @param {string} [open]
 * @param {string} [close]
 * @returns {string | null}
 */
export function extractDelimitedBlock(source, anchor, open = '{', close = '}') {
  const text = stripJsComments(source);

  let anchorEnd = -1;
  walkCode(text, 0, (_ch, index) => {
    if (!text.startsWith(anchor, index)) return true;
    if (!isTokenBoundedMatch(text, anchor, index)) return true;
    anchorEnd = index + anchor.length;
    return false;
  });
  if (anchorEnd === -1) return null;

  let bodyStart = -1;
  let bodyEnd = -1;
  let depth = 0;
  walkCode(text, anchorEnd, (ch, index) => {
    if (ch === open) {
      depth += 1;
      if (depth === 1) bodyStart = index + 1;
      return true;
    }
    if (ch === close && depth > 0) {
      depth -= 1;
      if (depth === 0) { bodyEnd = index; return false; }
    }
    return true;
  });

  if (bodyStart === -1 || bodyEnd === -1) return null;
  return text.slice(bodyStart, bodyEnd);
}

/**
 * Split a container body into its top-level, comma-separated entries. Entries
 * nested inside a child object, array, call, or template interpolation stay
 * inside their parent entry rather than becoming entries of their own.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function splitTopLevelEntries(body) {
  const text = stripJsComments(body);
  const entries = [];
  let start = 0;
  let depth = 0;

  walkCode(text, 0, (ch, index) => {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      entries.push(text.slice(start, index));
      start = index + 1;
    }
    return true;
  });
  entries.push(text.slice(start));

  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

const STRING_LITERAL = /^'((?:[^'\\]|\\.)*)'|^"((?:[^"\\]|\\.)*)"/;
const BARE_KEY = /^([A-Za-z_$][\w$]*)\s*:/;

// Standard single-character escapes. `\uXXXX` and `\xXX` are deliberately NOT
// decoded — they do not appear in the keys and members this module matches, and
// a half-correct unescaper is worse than an explicitly limited one. Anything
// else after a backslash decodes to the literal character, which is correct for
// \\, \', and \".
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

function unescapeStringLiteral(raw) {
  return raw.replace(/\\(.)/g, (_match, ch) => SIMPLE_ESCAPES[ch] ?? ch);
}

function readStringLiteral(entry) {
  const match = STRING_LITERAL.exec(entry);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  return { value: unescapeStringLiteral(raw), length: match[0].length };
}

/**
 * Return the value text of a top-level `key` entry in an object-literal body,
 * or null when the key is not a top-level key of that body.
 *
 * @param {string} body
 * @param {string} key
 * @returns {string | null}
 */
export function objectLiteralEntryValue(body, key) {
  for (const entry of splitTopLevelEntries(body)) {
    const literal = readStringLiteral(entry);
    if (literal) {
      const rest = entry.slice(literal.length);
      if (literal.value === key && /^\s*:/.test(rest)) return rest.replace(/^\s*:\s*/, '').trim();
      continue;
    }
    const bare = BARE_KEY.exec(entry);
    if (bare && bare[1] === key) return entry.slice(bare[0].length).trim();
  }
  return null;
}

/**
 * Report whether `value` is a top-level string member of an array-literal body.
 * An object key, a nested member, and a commented-out member all read false.
 *
 * @param {string} body
 * @param {string} value
 * @returns {boolean}
 */
export function arrayLiteralHasStringMember(body, value) {
  return splitTopLevelEntries(body).some((entry) => {
    const literal = readStringLiteral(entry);
    return literal !== null && literal.length === entry.length && literal.value === value;
  });
}
