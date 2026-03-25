/**
 * Tests for globe tooltip enrichment (PR: fix/globe-tooltip-enrichment).
 *
 * Covers:
 * - Compass heading calculation for flight tooltips (pure math)
 * - Conflict tooltip includes eventType field
 * - GPS jamming tooltip uses human-readable label
 * - Rich tooltip kinds get extended hide delay
 * - Content-heavy tooltip kinds get wider max-width (300px)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ========================================================================
// 1. Compass heading calculation (pure math, mirrors GlobeMap logic)
// ========================================================================

/** Replicates the compass formula from GlobeMap.showMarkerTooltip */
function headingToCompass(heading) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((heading ?? 0) % 360 + 360) % 360 / 22.5) % 16];
}

describe('headingToCompass', () => {
  it('returns N for heading 0', () => {
    assert.equal(headingToCompass(0), 'N');
  });

  it('returns E for heading 90', () => {
    assert.equal(headingToCompass(90), 'E');
  });

  it('returns S for heading 180', () => {
    assert.equal(headingToCompass(180), 'S');
  });

  it('returns W for heading 270', () => {
    assert.equal(headingToCompass(270), 'W');
  });

  it('returns NE for heading 45', () => {
    assert.equal(headingToCompass(45), 'NE');
  });

  it('returns SE for heading 135', () => {
    assert.equal(headingToCompass(135), 'SE');
  });

  it('returns SW for heading 225', () => {
    assert.equal(headingToCompass(225), 'SW');
  });

  it('returns NW for heading 315', () => {
    assert.equal(headingToCompass(315), 'NW');
  });

  it('returns N for heading 360 (wraps around)', () => {
    assert.equal(headingToCompass(360), 'N');
  });

  it('handles negative heading (-20 → NNW)', () => {
    // -20° = 340°, which falls in NNW sector (326.25°–348.75°)
    assert.equal(headingToCompass(-20), 'NNW');
  });

  it('handles near-zero negative heading (-10 → N)', () => {
    // -10° = 350°, which falls in N sector (348.75°–11.25°)
    assert.equal(headingToCompass(-10), 'N');
  });

  it('handles large heading (720 → N)', () => {
    assert.equal(headingToCompass(720), 'N');
  });

  it('returns N for undefined/null heading', () => {
    assert.equal(headingToCompass(undefined), 'N');
    assert.equal(headingToCompass(null), 'N');
  });

  it('handles boundary at 11.25 (exact midpoint between N and NNE)', () => {
    // Math.round(0.5) = 1 in JS, so 11.25° / 22.5 = 0.5 rounds to index 1 → NNE
    assert.equal(headingToCompass(11.25), 'NNE');
  });
});

// ========================================================================
// 2. Source-level assertions on GlobeMap.ts tooltip code
// ========================================================================

describe('GlobeMap tooltip enrichment', () => {
  const src = readSrc('src/components/GlobeMap.ts');

  it('uses 280px base max-width for all tooltips', () => {
    assert.match(src, /max-width:280px/, 'base max-width should be 280px');
  });

  it('conflict tooltip renders eventType when available', () => {
    assert.ok(src.includes('esc(d.eventType)'), 'conflict tooltip must escape eventType');
  });

  it('flight tooltip includes compass direction from heading', () => {
    assert.ok(src.includes('compass'), 'flight tooltip must compute compass direction');
    assert.ok(src.includes('Heading:'), 'flight tooltip must display Heading label');
  });

  it('GPS jamming tooltip uses human-readable satellite label', () => {
    assert.ok(src.includes('Avg satellites visible'), 'gpsjam must show readable label');
    assert.ok(!src.includes('NP avg:'), 'gpsjam must not use cryptic NP avg label');
  });

  it('extends hide delay to 6s for rich tooltip kinds', () => {
    assert.match(src, /richKinds\.has\(d\._kind\) \? 6000 : 3500/,
      'hide delay should be 6000 for rich kinds, 3500 for others');
  });

  it('richKinds includes repairShip and aisDisruption', () => {
    const richLine = src.match(/const richKinds = new Set\(\[([^\]]+)\]\)/);
    assert.ok(richLine, 'richKinds set must exist');
    const kinds = richLine[1];
    assert.ok(kinds.includes("'repairShip'"), 'richKinds must include repairShip');
    assert.ok(kinds.includes("'aisDisruption'"), 'richKinds must include aisDisruption');
  });

  it('widens content-heavy tooltip types to 300px', () => {
    const wideLine = src.match(/const wideKinds = new Set\(\[([^\]]+)\]\)/);
    assert.ok(wideLine, 'wideKinds set must exist');
    const kinds = wideLine[1];
    assert.ok(kinds.includes("'flightDelay'"), 'wideKinds must include flightDelay');
    assert.ok(kinds.includes("'conflictZone'"), 'wideKinds must include conflictZone');
    assert.ok(kinds.includes("'cableAdvisory'"), 'wideKinds must include cableAdvisory');
    assert.ok(kinds.includes("'satellite'"), 'wideKinds must include satellite');
  });
});
