/**
 * Orbital Watch is styled with WorldMonitor's tokens only, so it follows the
 * dark, light and happy themes and looks like the rest of the dashboard. Its
 * first sheet carried its own palette (amber accents and edges, a separate
 * sans font) that matched no other panel.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = ['orbital-tokens.css', 'orbital-watch.css'];
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi;

/** Literal colours with a reason they cannot follow the theme. */
const ALLOWED = [
  // The ink .time-btn.active and .map-pin-btn.active put on --green.
  { selector: '.ow-tab[aria-selected="true"]', literal: '#0a0a0a' },
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
  }

  it('every colour, font and shadow token resolves to a WorldMonitor var()', () => {
    const root = rules(read('orbital-tokens.css')).find((r) => r.selector === ':root');
    const tokens = [...root.body.matchAll(/(--ow-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => ({ name, value: value.trim() }));
    const themed = tokens.filter(({ value }) => !/^-?[\d.]+(px|em|rem)?$/.test(value));
    assert.ok(themed.length >= 10, 'the palette and fonts are tokens');
    const main = read('main.css');
    for (const { name, value } of themed) {
      const refs = [...value.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
      assert.ok(refs.length > 0, `${name} reads a WorldMonitor token, not "${value}"`);
      for (const ref of refs) {
        assert.ok(ref.startsWith('--ow-') || new RegExp(`${ref}\\s*:`).test(main), `${name} reads ${ref}, which main.css defines`);
      }
    }
  });

  it('keeps the amber palette out', () => {
    for (const sheet of sheets) assert.doesNotMatch(read(sheet), /f5a524|245,\s*165,\s*36|--ow-accent/i, sheet);
  });

  it('draws the map overlay (track, swath, reticle, label) in Orbital Watch tokens on every renderer', () => {
    for (const file of ['DeckGLMap.ts', 'GlobeMap.ts', 'Map.ts']) {
      const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /f5a524|245,\s*165,\s*36|ecebe7|236,\s*235,\s*231|0b0c0e|11,\s*12,\s*14|--ow-accent/i, file);
      assert.match(source, /--ow-mark/, `${file} draws the overlay in --ow-mark`);
    }
  });
});
