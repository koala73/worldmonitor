import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// #5080 slice 2: applyTransform() runs on every render/data pass, and an
// unconditional setProperty('--marker-scale', ...) — even with an identical
// value — invalidates every var() consumer (~68 rules across all overlay
// markers). Chrome invalidation tracking measured 7,654 per-marker style
// recalcs in ONE 1.5s tap window (earthquake-marker 4356, hotspot 1694,
// conflict-zone 1210); gating the writes on a real zoom change cut that to
// 88 (-98.9%) and tap-scoped style/layout from 437ms to 267ms at 5x CPU.
// Map tests assert on source text by repo convention (no live map mount).
const mapSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src/components/Map.ts'),
  'utf-8',
);

describe('map overlay counter-scale var write gate (#5080 slice 2)', () => {
  it('declares the last-written zoom cache field', () => {
    assert.match(mapSrc, /private lastOverlayVarZoom = '';/);
  });

  it('gates the three overlay var writes on a real zoom change', () => {
    assert.match(
      mapSrc,
      /const overlayVarZoom = zoom\.toFixed\(4\);\s*if \(this\.lastOverlayVarZoom !== overlayVarZoom\) \{\s*this\.lastOverlayVarZoom = overlayVarZoom;[\s\S]{0,400}?setProperty\('--label-scale'[\s\S]{0,200}?setProperty\('--marker-scale'[\s\S]{0,200}?setProperty\('--zoom'/,
      'the counter-scale vars must be written only when zoom (4dp) changed — a same-value write restyles every marker on every render pass',
    );
    const outsideGate = mapSrc.replace(
      /const overlayVarZoom[\s\S]{0,700}?setProperty\('--zoom'[^;]*;\s*\}/,
      '',
    );
    for (const varName of ['--label-scale', '--marker-scale', '--zoom']) {
      assert.doesNotMatch(
        outsideGate,
        new RegExp(`setProperty\\('${varName}'`),
        `no other call site may write ${varName} outside the zoom-change gate — an ungated write restyles every var() consumer on every render pass`,
      );
    }
  });
});
