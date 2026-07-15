import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// #5332 (#4580 slice A): eager always-full panels grow their grid row when
// populated content replaces the loading state (rows are minmax-sized from
// intrinsic content height), shoving every row below — the dominant remaining
// desktop CLS mechanism (field: div.panel shift p75 0.244 on 9% of views).
// The fix pins the ranked offenders to their populated max so row height is
// deterministic from first paint. PR #5333 review hardened the contract:
// pins apply to NATURAL footprints only (user-resized .resized/.span-N
// panels keep the resize contract) and only inside #panelsGrid (panels
// dragged to the ultra-wide .map-bottom-grid keep that grid's sizing).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles/main.css'), 'utf-8');
const panels = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf-8');

const SPAN1_KEYS = [
  'threat-timeline', 'gdelt-intel', 'intel', 'live-news', 'politics',
  'energy-complex', 'global-procurement', 'strategic-posture', 'cascade',
  'live-webcams',
];
const SPAN2_DEFAULT_KEYS = ['threat-timeline', 'gdelt-intel', 'energy-complex', 'strategic-posture', 'global-procurement'];
const WIDE_KEYS = ['live-news', 'live-webcams'];

// The two pin blocks, extracted by their shared height declarations. Regex
// anchors on a line START so `min-height:` can never satisfy it (review P2).
const pinBlocks = [...css.matchAll(/(^|\n)([^{}]*?)\{\s*\n\s*height:\s*(var\(--dashboard-panel-row-max\)|calc\(var\(--dashboard-panel-row-max\) \* 2 \+ var\(--dashboard-grid-gap\)\));\s*\n\}/g)]
  .map((m) => ({ selectors: m[2].replace(/\/\*[\s\S]*?\*\//g, '').trim(), value: m[3] }));

describe('always-full panel row stability (#5332)', () => {
  it('has exactly two pin blocks with FIXED height (not min-height)', () => {
    assert.equal(pinBlocks.length, 2, 'expected the span-1 pin block and the two-row pin block, each declaring a bare `height:` line');
    const values = pinBlocks.map((b) => b.value).sort();
    assert.match(values[0], /^calc/, 'one block must pin the two-row populated max');
    assert.match(values[1], /^var/, 'one block must pin the single-row max');
  });

  it('pins every ranked offender in its natural footprint, scoped to #panelsGrid', () => {
    const single = pinBlocks.find((b) => b.value.startsWith('var'));
    const double = pinBlocks.find((b) => b.value.startsWith('calc'));
    assert.ok(single && double, 'both pin blocks must exist');
    for (const key of SPAN1_KEYS) {
      assert.match(
        single.selectors,
        new RegExp(`#panelsGrid > \\.panel\\[data-panel="${key}"\\]:not\\(\\.span-2\\):not\\(\\.span-3\\):not\\(\\.span-4\\):not\\(\\.panel-wide\\):not\\(\\.resized\\)`),
        `'${key}' must carry the #panelsGrid-scoped natural-footprint pin`,
      );
    }
    for (const key of SPAN2_DEFAULT_KEYS) {
      assert.match(
        double.selectors,
        new RegExp(`#panelsGrid > \\.panel\\[data-panel="${key}"\\]\\.span-2:not\\(\\.resized\\)`),
        `span-2 default '${key}' must be pinned at the two-row max for its NATURAL state only`,
      );
    }
    for (const key of WIDE_KEYS) {
      assert.match(
        double.selectors,
        new RegExp(`#panelsGrid > \\.panel\\[data-panel="${key}"\\]\\.panel-wide:not\\(\\.resized\\):not\\(\\.span-1\\)`),
        `'${key}' uses .panel-wide (2x2), needs the wide pin excluding user-resized span states (review P1: a .panel-wide.span-1.resized panel must NOT stay 764px)`,
      );
    }
  });

  it('never pins a resized panel or a panel outside #panelsGrid', () => {
    for (const block of pinBlocks) {
      for (const selector of block.selectors.split(',')) {
        const sel = selector.trim();
        if (!sel) continue;
        assert.ok(sel.startsWith('#panelsGrid > '), `pin selector must be scoped to #panelsGrid (review P1 bottom-grid leak): ${sel}`);
        assert.ok(sel.includes(':not(.resized)'), `pin selector must exclude user-resized panels (review P1): ${sel}`);
      }
    }
  });

  it('every pinned key still exists in the panel config (rename guard)', () => {
    for (const key of SPAN1_KEYS) {
      assert.match(
        panels,
        new RegExp(`(?:'${key}'|(?<![\\w-])${key}):\\s*\\{`),
        `pinned panel key '${key}' no longer exists in src/config/panels.ts — update the #5332 pin list and this test together`,
      );
    }
  });
});
