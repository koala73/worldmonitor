import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stylesDir = resolve(__dirname, '../src/styles');
const sheets = readdirSync(stylesDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: readFileSync(resolve(stylesDir, name), 'utf8') }));

// Custom properties declared anywhere with a hex colour value.
const hexVars = new Set();
for (const { css } of sheets) {
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*#[0-9a-f]{3,8}\b/gi)) hexVars.add(match[1]);
}

// Matched on the whole sheet, not per line: `\s` lets `rgba(` and the var()
// sit on different lines, which a line split would miss.
function offendersIn(name, css) {
  const offenders = [];
  for (const match of css.matchAll(/rgba?\(\s*var\((--[\w-]+)\)/g)) {
    if (!hexVars.has(match[1])) continue;
    const line = css.slice(0, match.index).split('\n').length;
    offenders.push(`${name}:${line} ${css.split('\n')[line - 1].trim()}`);
  }
  return offenders;
}

describe('rgb()/rgba() never wraps a hex-valued custom property', () => {
  it('finds the hex palette to check against', () => {
    assert.ok(hexVars.has('--semantic-critical'), 'expected --semantic-critical to be a hex colour');
  });

  // `rgba(var(--semantic-critical), 0.2)` with `--semantic-critical: #ff4444`
  // is invalid at computed-value time. A `background` then drops to
  // transparent, and an SVG `fill` drops to black: the settled mobile conflict
  // zones rendered solid black. Use color-mix() to tint a hex variable.
  it('has no invalid rgba(var(--hex-colour), alpha) declarations', () => {
    assert.deepEqual(sheets.flatMap(({ name, css }) => offendersIn(name, css)), []);
  });

  it('catches a declaration split across lines and reports its first line', () => {
    const fixture = '.a {\n  fill: rgba(\n    var(--semantic-critical),\n    0.2\n  );\n}\n.b { fill: rgba(var(--not-a-hex-var), 0.2); }';
    assert.deepEqual(offendersIn('fixture.css', fixture), ['fixture.css:2 fill: rgba(']);
  });
});
