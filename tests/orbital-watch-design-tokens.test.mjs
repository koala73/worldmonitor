/**
 * Orbital Watch is styled with WorldMonitor's tokens only, so it follows the
 * dark, light and happy themes and looks like the rest of the dashboard. Its
 * first sheet carried its own palette (amber accents and edges, a separate
 * sans font) that matched no other panel.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = ['orbital-watch.css', 'orbital-image-viewer.css'];
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi;

/** Literal colours with a reason they cannot follow the theme. */
const ALLOWED = [
  // The ink .time-btn.active and .map-pin-btn.active put on --green.
  { selector: '.oiv-tab[aria-selected="true"], .oiv-date[aria-pressed="true"], .oiv-toggle[aria-pressed="true"]', literal: '#0a0a0a' },
  // Text drawn straight on satellite imagery, which looks the same in every theme.
  { selector: '.ow-scale', literal: '#fff' },
  { selector: '.ow-scale', literal: '#000' },
];

function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(css));) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

describe('Orbital Watch design tokens', () => {
  for (const sheet of sheets) {
    it(`${sheet} has no colour literals beyond the justified ones`, () => {
      const found = rules(read(sheet)).flatMap(({ selector, body }) =>
        (body.match(COLOUR_LITERAL) ?? [])
          .filter((literal) => !ALLOWED.some((a) => a.selector === selector && a.literal === literal.toLowerCase()))
          .map((literal) => `${selector}: ${literal}`));
      assert.deepEqual(found, []);
    });

    it(`${sheet} reads only tokens main.css defines`, () => {
      const main = read('main.css');
      const css = read(sheet);
      const local = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
      // A var() with a fallback is a custom property the component sets at run time.
      const missing = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)].map((m) => m[1]))]
        .filter((ref) => !local.has(ref) && !new RegExp(`${ref}\\s*:`).test(main));
      assert.deepEqual(missing, []);
    });
  }

  it('has no lookup-only token stylesheet and no --ow-* palette', () => {
    assert.ok(!existsSync(new URL('../src/styles/orbital-tokens.css', import.meta.url)));
    for (const sheet of sheets) assert.doesNotMatch(read(sheet), /--ow-/, sheet);
  });

  it('keeps the amber palette out', () => {
    for (const sheet of sheets) assert.doesNotMatch(read(sheet), /f5a524|245,\s*165,\s*36|--ow-accent/i, sheet);
  });

  it('draws the map overlay (track, swath, reticle, label) in shared tokens on every renderer', () => {
    for (const file of ['DeckGLMap.ts', 'GlobeMap.ts', 'Map.ts']) {
      const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /f5a524|245,\s*165,\s*36|ecebe7|236,\s*235,\s*231|0b0c0e|11,\s*12,\s*14|--ow-/i, file);
      assert.match(source, /'--green'/, `${file} draws the overlay in --green`);
    }
  });
});
