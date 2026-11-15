/**
 * The globe satellite card's watched-sites section (#10713 unit 3) draws only in
 * the shared main.css tokens: no lookup-only token sheet, no --ow-* palette and
 * no literal colours, so every theme applies unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const css = read('src/styles/orbital-satellite-sites.css');
const main = read('src/styles/main.css');

describe('satellite sites card tokens', () => {
  it('has no literal colours', () => {
    assert.deepEqual(css.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? [], []);
  });

  it('reads only tokens main.css defines, never the --ow-* palette', () => {
    assert.doesNotMatch(css, /--ow-/);
    const refs = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
    assert.ok(refs.length > 0);
    assert.deepEqual(refs.filter((ref) => !new RegExp(`${ref}\\s*:`).test(main)), []);
  });

  it('loads no Orbital Watch token sheet and no Orbital Watch classes', () => {
    for (const file of ['src/components/orbital-satellite-sites-view.ts', 'src/components/GlobeMap.ts']) {
      const source = read(file);
      assert.doesNotMatch(source, /orbital-tokens\.css/, file);
      assert.doesNotMatch(source, /['" ]ow-[a-z]/, file);
    }
  });
});
