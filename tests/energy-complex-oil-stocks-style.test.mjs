/**
 * The Energy Complex IEA oil-stocks section shipped (#2767) with badge and
 * regional-summary markup but no CSS for it. The badges rendered as plain
 * text glued to the value ("81 dBelow 90d"), and each regional row ran its
 * label into its figures ("Europeavg 118d / min 81d1 below 90d") at the
 * panel's body size and weight.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const css = readdirSync(new URL('src/styles/', root))
  .filter((name) => name.endsWith('.css'))
  .map((name) => read(`src/styles/${name}`))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const panel = read('src/components/EnergyComplexPanel.ts');

/** Declarations of every rule whose selector list contains exactly `.name`. */
function declarations(name) {
  const props = new Map();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map((s) => s.trim()).includes(`.${name}`)) continue;
    for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) props.set(d[1], d[2].trim());
  }
  return props;
}

describe('Energy Complex oil-stocks styles', () => {
  // "Below 90d" follows the days value on the same line; "Net exporter" stands
  // in for the value, so it starts flush.
  for (const [badge, spaced] of [['energy-net-exporter-badge', false], ['energy-below-obligation-badge', true]]) {
    it(`.${badge} renders as a separated badge`, () => {
      assert.match(panel, new RegExp(`class="${badge}"`), `${badge} is no longer rendered; update this test`);
      const props = declarations(badge);
      assert.equal(props.get('display'), 'inline-block', `.${badge} needs display: inline-block`);
      const margin = Number.parseFloat(props.get('margin-inline-start') ?? '0');
      if (spaced) assert.ok(margin > 0, `.${badge} needs space between it and the value before it`);
      else assert.equal(margin, 0, `.${badge} replaces the value, so it starts flush`);
      assert.ok(props.has('background'), `.${badge} needs a background`);
      assert.ok(props.has('color'), `.${badge} needs a text colour`);
    });
  }

  it('a regional summary row separates its label, figures and badge', () => {
    assert.match(panel, /class="oil-stocks-region-row"/);
    const row = declarations('oil-stocks-region-row');
    assert.equal(row.get('display'), 'flex');
    assert.ok(row.has('gap'), '.oil-stocks-region-row needs a gap between its parts');
    assert.ok(row.has('font-size'), '.oil-stocks-region-row needs the panel detail size');
    const name = declarations('oil-stocks-region-name');
    assert.ok(name.has('color'), '.oil-stocks-region-name needs a label colour');
  });
});
