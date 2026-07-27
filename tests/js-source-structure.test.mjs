import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  arrayLiteralHasStringMember,
  extractDelimitedBlock,
  objectLiteralEntryValue,
  stripJsComments,
} from '../scripts/lib/js-source-structure.mjs';

describe('stripJsComments', () => {
  it('blanks line and block comments while preserving offsets and newlines', () => {
    const source = "const a = 1; // trailing\n/* block\n   spans */ const b = 2;\n";
    const stripped = stripJsComments(source);
    assert.equal(stripped.length, source.length);
    assert.equal(
      stripped.split('\n').length,
      source.split('\n').length,
      'newlines inside block comments must survive so offsets stay aligned',
    );
    assert.ok(stripped.includes('const a = 1;'));
    assert.ok(stripped.includes('const b = 2;'));
    assert.doesNotMatch(stripped, /trailing|block|spans/);
  });

  it('keeps comment-looking text inside single, double, and template strings', () => {
    const source = [
      "const single = '// not a comment';",
      'const double = "/* also not */";',
      'const tpl = `path // ${inner} /* keep */`;',
    ].join('\n');
    assert.equal(stripJsComments(source), source);
  });

  it('keeps an escaped quote from ending the string early', () => {
    const source = "const s = 'it\\'s // fine'; // gone\n";
    const stripped = stripJsComments(source);
    assert.ok(stripped.includes("'it\\'s // fine';"));
    assert.doesNotMatch(stripped, /gone/);
  });

  it('does not read a regex literal containing // as a line comment', () => {
    const source = "const re = /https:\\/\\//;\nconst kept = 1; // dropped\n";
    const stripped = stripJsComments(source);
    assert.ok(stripped.includes('const kept = 1;'), 'code after a regex literal must survive');
    assert.doesNotMatch(stripped, /dropped/);
  });

  it('treats division as division, not as the start of a regex', () => {
    const source = 'const ratio = total / count; // note\nconst next = 2;\n';
    const stripped = stripJsComments(source);
    assert.ok(stripped.includes('const ratio = total / count;'));
    assert.ok(stripped.includes('const next = 2;'));
    assert.doesNotMatch(stripped, /note/);
  });

  it('treats a newline as whitespace when deciding regex vs division', () => {
    // A newline must not reset the "what came before" signal: the operand on
    // the previous line is what makes this division, and misreading it as a
    // regex swallows the rest of the line — including a real comment.
    const division = 'const x = a\n  / b; // dropped\nconst y = 2;\n';
    const stripped = stripJsComments(division);
    assert.doesNotMatch(stripped, /dropped/, 'a comment after a line-continued division must still be stripped');
    assert.ok(stripped.includes('const y = 2;'));

    const regex = 'const re =\n  /https:\\/\\//;\nconst kept = 1; // gone\n';
    const strippedRegex = stripJsComments(regex);
    assert.ok(strippedRegex.includes('const kept = 1;'), 'a regex on its own line must still parse as a regex');
    assert.doesNotMatch(strippedRegex, /gone/);
  });

  it('keeps offsets aligned when the source contains astral characters', () => {
    // The output buffer must be indexed the same way `source[n]` and
    // `indexOf` are — by UTF-16 code unit. A code-point-indexed buffer
    // desynchronizes on the first surrogate pair and blanks the wrong range,
    // which can leave a comment intact (a false pass for any caller relying
    // on comments being gone) while eating real code.
    const source = "const flag = '\u{1F1E8}\u{1F1F3}'; // strip me\nconst after = 1;\n";
    const stripped = stripJsComments(source);
    assert.equal(stripped.length, source.length);
    assert.doesNotMatch(stripped, /strip me/);
    assert.doesNotMatch(stripped, /\/\//, 'the comment marker itself must be blanked');
    assert.ok(stripped.includes('const after = 1;'), 'code after an astral char must survive intact');
    assert.ok(stripped.includes("'\u{1F1E8}\u{1F1F3}'"), 'the astral literal must survive');
  });

  it('finds an anchor that begins with a quote', () => {
    // extractDelimitedBlock matches anchors only at code-level positions, so a
    // quote-initial anchor is unfindable unless the opening quote is reported.
    const source = "const MAP = {\n  'a': { tier: 'fast' },\n};\n";
    const body = extractDelimitedBlock(source, "'a':");
    assert.ok(body !== null, 'a quote-initial anchor must be findable');
    assert.ok(body.includes("tier: 'fast'"));
  });

  it('is idempotent', () => {
    const source = 'const a = 1; // x\n/* y */\n';
    assert.equal(stripJsComments(stripJsComments(source)), stripJsComments(source));
  });
});

describe('extractDelimitedBlock', () => {
  const source = [
    'const OTHER = { skip: 1 };',
    'const MAP: Record<string, string> = {',
    "  'a': 'fast', // note with } brace",
    "  nested: { 'b': 'slow' },",
    "  'c': '} not a close',",
    '};',
    'const AFTER = 1;',
  ].join('\n');

  it('returns the balanced body that follows the anchor', () => {
    const body = extractDelimitedBlock(source, 'const MAP');
    assert.ok(body !== null);
    assert.ok(body.includes("'a': 'fast'"));
    assert.doesNotMatch(body, /AFTER/);
    assert.doesNotMatch(body, /skip/);
  });

  it('ignores closing delimiters that live inside comments or strings', () => {
    const body = extractDelimitedBlock(source, 'const MAP');
    assert.ok(body.includes("'c': '} not a close'"), 'the block must not end at a quoted brace');
  });

  it('fails closed when the anchor is absent', () => {
    assert.equal(extractDelimitedBlock(source, 'const RENAMED_MAP'), null);
  });

  it('does not match an anchor in the middle of a longer identifier', () => {
    const widened = source.replace('const MAP', 'const MAP_V2');
    assert.equal(
      extractDelimitedBlock(widened, 'const MAP'),
      null,
      'MAP_V2 is a different container — matching it would audit the wrong object',
    );
    const prefixed = 'const OTHER_MAP = { skip: 1 };\nconst MAP = {\n  ok: 1,\n};\n';
    const body = extractDelimitedBlock(prefixed, 'const MAP');
    assert.ok(body !== null && body.includes('ok: 1'), 'a real declaration must still match');
    assert.doesNotMatch(body, /skip/);
  });

  it('fails closed when the anchor only appears inside a comment', () => {
    const commented = `// const MAP = {\nconst OTHER = 1;\n`;
    assert.equal(extractDelimitedBlock(commented, 'const MAP'), null);
  });

  it('fails closed when the block never closes', () => {
    assert.equal(extractDelimitedBlock("const MAP = {\n  'a': 'fast',\n", 'const MAP'), null);
  });

  it('extracts bracket-delimited blocks too', () => {
    const set = "export const PATHS = new Set<string>([\n  '/a',\n  '/b',\n]);\n";
    const body = extractDelimitedBlock(set, 'export const PATHS', '[', ']');
    assert.ok(body.includes("'/a'"));
    assert.ok(body.includes("'/b'"));
  });
});

describe('objectLiteralEntryValue', () => {
  const body = [
    "  'top': 'fast',",
    '  nested: {',
    "    'deep': 'slow',",
    '  },',
    '  bare: 42,',
    "  'last': 'medium'",
  ].join('\n');

  it('returns the value of a top-level quoted key', () => {
    assert.equal(objectLiteralEntryValue(body, 'top'), "'fast'");
  });

  it('returns the value of the final entry without a trailing comma', () => {
    assert.equal(objectLiteralEntryValue(body, 'last'), "'medium'");
  });

  it('returns the value of a bare identifier key', () => {
    assert.equal(objectLiteralEntryValue(body, 'bare'), '42');
  });

  it('does not see keys nested inside a child object', () => {
    assert.equal(objectLiteralEntryValue(body, 'deep'), null);
  });

  it('does not see a key that only appears in a comment', () => {
    assert.equal(objectLiteralEntryValue("  // 'ghost': 'fast',\n  'real': 'slow',", 'ghost'), null);
  });

  it('does not see a key that only appears inside another value', () => {
    assert.equal(objectLiteralEntryValue("  'real': \"'ghost': 'fast'\",", 'ghost'), null);
  });

  it('returns null for a missing key rather than a falsy value', () => {
    assert.equal(objectLiteralEntryValue(body, 'absent'), null);
  });
});

describe('arrayLiteralHasStringMember', () => {
  const body = ["  '/a',", '  // \'/commented\',', '  nested([\'/deep\']),', "  '/b',"].join('\n');

  it('finds a top-level member', () => {
    assert.equal(arrayLiteralHasStringMember(body, '/a'), true);
    assert.equal(arrayLiteralHasStringMember(body, '/b'), true);
  });

  it('ignores commented-out members', () => {
    assert.equal(arrayLiteralHasStringMember(body, '/commented'), false);
  });

  it('ignores members nested inside a child expression', () => {
    assert.equal(arrayLiteralHasStringMember(body, '/deep'), false);
  });

  it('ignores object keys rather than counting them as members', () => {
    assert.equal(arrayLiteralHasStringMember("  { '/a': 1 },", '/a'), false);
  });

  it('requires an exact match, not a prefix', () => {
    assert.equal(arrayLiteralHasStringMember(body, '/'), false);
    assert.equal(arrayLiteralHasStringMember(body, '/a/b'), false);
  });

  it('decodes standard escape sequences rather than dropping the backslash', () => {
    assert.equal(arrayLiteralHasStringMember("  'a\\nb',", 'a\nb'), true);
    assert.equal(arrayLiteralHasStringMember("  'a\\nb',", 'anb'), false);
    assert.equal(arrayLiteralHasStringMember("  'it\\'s',", "it's"), true);
    assert.equal(arrayLiteralHasStringMember("  'back\\\\slash',", 'back\\slash'), true);
    assert.equal(arrayLiteralHasStringMember('  "tab\\there",', 'tab\there'), true);
  });
});

describe('keyword-preceded regex literals', () => {
  // `return /x/` ends in an identifier char, so a preceding-character-only
  // classifier reads the `/` as division and then scans the regex body as code.
  // A quote in that body is bounded by the newline guard, but a backtick opens
  // template mode — which has no newline guard — and swallows every container
  // after it. Both scanners have to agree, because extractDelimitedBlock strips
  // comments with one and then re-walks the result with the other.
  // Kept on ONE line with the regex. A stray quote opened by a misread regex is
  // bounded by the newline guard, so a container on a later line would be found
  // even with the bug present — the row would pass either way and prove
  // nothing. Same-line placement is what gives every row below teeth.
  const container = "const RPC_CACHE_TIER = { '/api/x': 'fast' };";

  for (const [name, guard] of [
    ['an apostrophe', "function m(s) { return /it's/.test(s); } "],
    ['a backtick', 'function m(s) { return /a`b/.test(s); } '],
    ['a double quote', 'function m(s) { return /a"b/.test(s); } '],
    ['a keyword other than return', 'const t = typeof /a\'b/; '],
    ['a case label', "switch (x) { case /a'b/.source: break; } "],
  ]) {
    it(`finds a same-line container past a regex containing ${name}`, () => {
      const body = extractDelimitedBlock(guard + container, 'const RPC_CACHE_TIER');
      assert.notEqual(body, null, 'the container must still be locatable');
      assert.equal(objectLiteralEntryValue(body, '/api/x'), "'fast'");
    });
  }

  it('reads a container whose own body contains a keyword-preceded regex', () => {
    // The regex sits INSIDE the container, so a misread body desynchronizes the
    // balanced-delimiter walk itself rather than just the text before it.
    const source = 'const RPC_CACHE_TIER = {\n'
      + "  '/api/x': 'fast',\n"
      + '  match: (s) => { return /a`{/.test(s); },\n'
      + '};\n';
    const body = extractDelimitedBlock(source, 'const RPC_CACHE_TIER');
    assert.notEqual(body, null, 'the container must still close');
    assert.equal(objectLiteralEntryValue(body, '/api/x'), "'fast'");
  });

  it('still reads a genuine division as division, not as a regex', () => {
    // The dangerous direction: misreading division as a regex skips real code,
    // which could carry the scanner past a closing delimiter.
    const source = 'const ratio = total / count;\nconst SIZES = {\n  small: 1,\n};\n';
    const body = extractDelimitedBlock(source, 'const SIZES');
    assert.notEqual(body, null);
    assert.equal(objectLiteralEntryValue(body, 'small'), '1');
  });

  it('treats an unterminated slash as division rather than eating the line', () => {
    const source = 'const half = value / 2;\nconst SIZES = { small: 1 };\n';
    const body = extractDelimitedBlock(source, 'const SIZES');
    assert.equal(objectLiteralEntryValue(body, 'small'), '1');
  });

  it('does not let a regex body hide a member from the real container', () => {
    // A commented-out or drifted member must stay invisible even when a regex
    // earlier in the file contains delimiter-looking text.
    const source = 'const re = /\\[\'\\/api\\/x\'\\]/;\n'
      + "export const PUBLIC = [\n  '/api/y',\n];\n";
    const body = extractDelimitedBlock(source, 'export const PUBLIC', '[', ']');
    assert.notEqual(body, null);
    assert.equal(arrayLiteralHasStringMember(body, '/api/y'), true);
    assert.equal(arrayLiteralHasStringMember(body, '/api/x'), false);
  });
});
