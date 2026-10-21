import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectTsFiles, lexSource, stripComments } from '../scripts/lib/source-scan.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Why this test exists (#7833)
// ---------------------------------------------------------------------------
//
// `stripComments` is shared infrastructure for two merge-blocking gates
// (`enforce-panel-content-writes`, and `enforce-safe-local-storage` until it
// moved to the AST). Its failure mode is not a crash — it is blanking real code
// so the gate scans less than it reports, then passes green over the very edit
// it exists to catch. That has now happened twice, from two different lexing
// bugs, so the assertions below are about what SURVIVES stripping, not only
// about what gets removed. A test that checks comments are gone cannot see
// this class at all.

/** The last line is the code the gate must still be able to see. */
function survives(source: string): boolean {
  return stripComments(source).split('\n').pop()!.trim() !== '';
}

describe('stripComments', () => {
  it('removes comments while preserving line count and offsets', () => {
    const src = ['// a line comment', '/* a block', '   comment */', 'const x = 1;'].join('\n');
    const out = stripComments(src);
    assert.equal(out.length, src.length, 'offsets must be preserved');
    assert.equal(out.split('\n').length, src.split('\n').length, 'line count must be preserved');
    assert.match(out, /const x = 1;/);
    assert.doesNotMatch(out, /line comment|block/);
  });

  it('does not let a comment opener inside a LINE comment open a region', () => {
    // The first blindness: the old two-regex stripper ran its block-comment
    // pass over raw source, so this `/*` opened a region running to the next
    // `*/` — 1826 of panel-layout.ts's 4554 lines, in practice.
    assert.ok(survives([
      "// declared in src/components/*Panel.ts). A deferred note",
      'this.content.append(row);',
    ].join('\n')));
  });

  it('does not let a comment opener inside a STRING open a region', () => {
    assert.ok(survives(["const glob = '../locales/*.json';", 'localStorage.getItem(k);'].join('\n')));
    assert.ok(survives(["const url = 'https://example.com/x';", 'localStorage.getItem(k);'].join('\n')));
  });

  it('resumes the right template when an interpolation nests another', () => {
    // The second blindness: a single in-string flag treats the INNER opening
    // backtick as the outer closing quote, drops back to code mid-string, and
    // the `/*` in the remaining text then blanks everything to EOF — so the
    // panel gate passed green over a newly added direct content write.
    assert.ok(survives(['const s = `outer ${`/*`}`;', 'this.content.append(row);'].join('\n')));
    assert.ok(survives(['const a = `x ${ obj[`y ${z}`] } w`;', 'localStorage.getItem(k);'].join('\n')));
  });

  it('still strips a template that is genuinely unterminated-looking but closed', () => {
    const out = stripComments(['const t = `hello ${name}`; /* gone */', 'const y = 2;'].join('\n'));
    assert.match(out, /const t = `hello \$\{name\}`;/);
    assert.doesNotMatch(out, /gone/);
    assert.match(out, /const y = 2;/);
  });

  it('does not run the string state past an escaped closing quote', () => {
    // A trailing backslash before the quote would otherwise swallow it and
    // leak the string state into the code that follows.
    assert.ok(survives(["const b = '\\\\';", 'this.content.append(row);'].join('\n')));
  });

  it('reads a regex literal as a regex, not as quoted string content', () => {
    // Live in src/main.ts:454 — `!/^'[^']*'$/.test(token)`. An odd number of
    // apostrophes inside a regex de-synced the lexer for the entire rest of
    // the file, which is how 13 src/ files were being mis-scanned.
    const src = [
      "const ok = tokens.some(t => !/^'[^']*'$/.test(t));",
      'this.content.append(row);',
    ].join('\n');
    assert.ok(survives(src));
    assert.equal(lexSource(src).ok, true);
  });

  it('does not mistake division for a regex', () => {
    // The other half of the ambiguity: after a value, `/` divides. Reading it
    // as a regex would swallow code up to the next slash.
    const src = ['const ratio = width / height;', 'this.content.append(row);'].join('\n');
    assert.ok(survives(src));
    assert.equal(lexSource(src).ok, true);
  });

  it('reports an untrustworthy lex instead of silently blanking', () => {
    // The backstop for whatever the regex heuristic still gets wrong: a
    // terminal state other than `code` means the scan cannot be trusted, and
    // the gates fail on it rather than reporting a clean run over unread code.
    assert.equal(lexSource("const s = 'unterminated;").ok, false);
    assert.equal(lexSource('const t = `unterminated;').ok, false);
    assert.equal(lexSource('const u = `a ${ b ;').ok, false);
    assert.equal(lexSource('const v = 1; // fine\n/* also fine */').ok, true);
  });

  it('lexes every scanned source file cleanly', () => {
    // The assertion that would have caught this class at the source: if any
    // real file fails to lex, both gates are scanning less than they claim.
    const files = collectTsFiles(join(REPO_ROOT, 'src'), { readdirSync, lstatSync, join });
    const bad = files
      .map((abs) => [abs, lexSource(readFileSync(abs, 'utf8'))] as const)
      .filter(([, r]) => !r.ok)
      .map(([abs, r]) => `${abs} (ended in ${r.terminalMode})`);
    assert.deepEqual(bad, []);
  });
});
