import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as canonical from '../shared/orbital/pass-geometry.js';
import * as mirror from '../scripts/shared/orbital/pass-geometry.js';
import { matchSensorProfile as matchCanonical } from '../shared/orbital/sensor-profiles.js';
import { matchSensorProfile as matchMirror } from '../scripts/shared/orbital/sensor-profiles.js';
import { decidePassTier as tierCanonical } from '../shared/orbital/tiers.js';
import { decidePassTier as tierMirror } from '../scripts/shared/orbital/tiers.js';

const CANONICAL_DIR = new URL('../shared/orbital/', import.meta.url);
const MIRROR_DIR = new URL('../scripts/shared/orbital/', import.meta.url);

describe('scripts/shared/orbital mirror', () => {
  it('holds the same files as shared/orbital, byte for byte', () => {
    const files = readdirSync(CANONICAL_DIR).sort();
    assert.deepEqual(readdirSync(MIRROR_DIR).sort(), files, 'copy shared/orbital/* to scripts/shared/orbital/');
    for (const file of files) {
      assert.equal(
        readFileSync(new URL(file, MIRROR_DIR), 'utf8'),
        readFileSync(new URL(file, CANONICAL_DIR), 'utf8'),
        `scripts/shared/orbital/${file} differs from shared/orbital/${file}`,
      );
    }
  });

  it('produces identical passes and tiers for the same golden fixture', () => {
    const { records } = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8'));
    const now = Date.parse('2026-11-13T12:00:00Z');
    const point = { lat: 48.85, lon: 2.35 };
    const window = { start: now - 7 * 86_400_000, end: now + 3 * 86_400_000 };
    const run = (geometry, match, decide) => records.map((omm) => {
      const elements = geometry.parseOrbitElements(omm);
      const profile = match(elements.noradId, elements.name);
      const result = geometry.findPasses({ elements, profile, point, window, now });
      return { ...result, tiers: result.passes.map((pass) => decide(pass, profile, { status: 'unanswered' }, now)) };
    });
    const fromCanonical = run(canonical, matchCanonical, tierCanonical);
    assert.ok(fromCanonical.some((result) => result.passes.length > 0));
    assert.deepEqual(run(mirror, matchMirror, tierMirror), fromCanonical);
  });
});
