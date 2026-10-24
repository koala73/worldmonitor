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

describe('rgb()/rgba() never wraps a hex-valued custom property', () => {
  it('finds the hex palette to check against', () => {
    assert.ok(hexVars.has('--semantic-critical'), 'expected --semantic-critical to be a hex colour');
  });

  // `rgba(var(--semantic-critical), 0.2)` with `--semantic-critical: #ff4444`
  // is invalid at computed-value time. A `background` then drops to
  // transparent, and an SVG `fill` drops to black: the settled mobile conflict
  // zones rendered solid black. Use color-mix() to tint a hex variable.
  it('has no invalid rgba(var(--hex-colour), alpha) declarations', () => {
    const offenders = [];
    for (const { name, css } of sheets) {
      const lines = css.split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/rgba?\(\s*var\((--[\w-]+)\)/g)) {
          if (hexVars.has(match[1])) offenders.push(`${name}:${index + 1} ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(offenders, []);
  });
});
