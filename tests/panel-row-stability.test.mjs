import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// #5332 (#4580 slice A): eager always-full panels grow their grid row when
// populated content replaces the loading state (rows are minmax-sized from
// intrinsic content height), shoving every row below — the dominant remaining
// desktop CLS mechanism (field: div.panel shift p75 0.244 on 9% of views).
// The fix pins the ranked offender panels to the row max so the row height is
// deterministic from first paint. This guard keeps the pin present, keyed to
// the ranked offender list, and excluded for user-set spans.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles/main.css'), 'utf-8');
const panels = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf-8');

const OFFENDER_KEYS = [
  'threat-timeline', 'gdelt-intel', 'intel', 'live-news', 'politics',
  'energy-complex', 'global-procurement', 'strategic-posture', 'cascade',
  'live-webcams',
];

describe('always-full panel row stability (#5332)', () => {
  it('pins every ranked offender panel to the row max, excluding user spans', () => {
    for (const key of OFFENDER_KEYS) {
      assert.match(
        css,
        new RegExp(`\\.panel\\[data-panel="${key}"\\]:not\\(\\.span-2\\):not\\(\\.span-3\\):not\\(\\.span-4\\):not\\(\\.panel-wide\\)`),
        `.panel[data-panel="${key}"] must carry the fixed-row pin — without it the panel's row grows on content arrival and shifts every row below`,
      );
    }
    const block = css.slice(css.indexOf('.panel[data-panel="threat-timeline"]'));
    assert.match(
      block.slice(0, block.indexOf('}')),
      /height:\s*var\(--dashboard-panel-row-max\)/,
      'the pin must be a fixed height at the row max (min-height would still allow growth)',
    );
  });

  it('pins the two-row-default offenders (span-2 + panel-wide) at the populated two-row max', () => {
    for (const key of ['threat-timeline', 'gdelt-intel', 'energy-complex', 'strategic-posture', 'global-procurement']) {
      assert.match(
        css,
        new RegExp(`\\.panel\\[data-panel="${key}"\\]\\.span-2`),
        `span-2 default '${key}' needs its own pin — the span-1 rule excludes .span-2 and these grow 404px toward ~764px in the field`,
      );
    }
    for (const key of ['live-news', 'live-webcams']) {
      assert.match(
        css,
        new RegExp(`\\.panel\\[data-panel="${key}"\\]\\.panel-wide`),
        `'${key}' uses .panel-wide (2x2 grid area), not .span-2 — it needs the panel-wide pin or it keeps growing 404px toward ~764px`,
      );
    }
    assert.match(
      css,
      /\.panel\[data-panel="live-webcams"\]\.panel-wide \{\s*height:\s*calc\(var\(--dashboard-panel-row-max\) \* 2 \+ var\(--dashboard-grid-gap\)\)/,
      'the two-row pin must be the populated two-row max (2 x row-max + gap)',
    );
  });

  it('every pinned key still exists in the panel config (rename guard)', () => {
    for (const key of OFFENDER_KEYS) {
      assert.match(
        panels,
        new RegExp(`(?:'${key}'|(?<![\\w-])${key}):\\s*\\{`),
        `pinned panel key '${key}' no longer exists in src/config/panels.ts — update the #5332 pin list and this test together`,
      );
    }
  });
});
