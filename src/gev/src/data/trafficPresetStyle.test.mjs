import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trafficStyleProfile,
  presetDotRgba,
  presetSizeDelta,
  presetDotOutline,
  trafficBucketTier,
} from './trafficPresetStyle.js';

/** Rec.601 luma of an rgba tuple (rgb 0–255), normalized 0–1. */
const luma = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

const BUCKETS = ['free', 'slow', 'jam'];
const MONO_STYLES = ['surveillance', 'thermal', 'noir'];
const NORMAL_STYLES = ['normal', 'anime', 'snow', 'does-not-exist', '', undefined, null];

test('profile mapping: NVG/FLIR/noir are mono, retro is crt, everything else normal', () => {
  for (const s of MONO_STYLES) assert.equal(trafficStyleProfile(s), 'mono', s);
  assert.equal(trafficStyleProfile('retro'), 'crt');
  for (const s of NORMAL_STYLES) assert.equal(trafficStyleProfile(s), 'normal', String(s));
});

test('normal-profile styles never restyle: null rgba, zero size delta', () => {
  for (const s of NORMAL_STYLES) {
    for (const b of BUCKETS) {
      assert.equal(presetDotRgba(s, b), null, `${s}/${b}`);
      assert.equal(presetSizeDelta(s, b), 0, `${s}/${b}`);
    }
  }
});

test('sim/uncovered dots (null bucket) are untouched under EVERY style — keyless path stays byte-identical', () => {
  for (const s of [...MONO_STYLES, 'retro', ...NORMAL_STYLES]) {
    assert.equal(presetDotRgba(s, null), null, String(s));
    assert.equal(presetDotRgba(s, undefined), null, String(s));
    assert.equal(presetDotRgba(s, 'sim'), null, String(s));
    assert.equal(presetSizeDelta(s, null), 0, String(s));
  }
});

test('mono: EVERY colored dot is a bright white core (follow-up round 2: "just bright dots")', () => {
  for (const s of MONO_STYLES) {
    for (const b of BUCKETS) {
      const rgba = presetDotRgba(s, b);
      assert.ok(rgba, `${s}/${b} returns a tuple`);
      assert.ok(luma(rgba) >= 0.95, `${s}/${b} is near-white (luma ${luma(rgba).toFixed(2)})`);
      assert.ok(rgba[3] >= 0.8, `${s}/${b} stays opaque enough to read (alpha ${rgba[3]})`);
    }
  }
});

test('mono: jam is the biggest, sizes monotonic (queues read as fat beads)', () => {
  for (const s of MONO_STYLES) {
    assert.ok(presetSizeDelta(s, 'jam') >= 2, `${s} jam +2px or more`);
    assert.ok(presetSizeDelta(s, 'jam') > presetSizeDelta(s, 'slow'), s);
    assert.ok(presetSizeDelta(s, 'slow') >= presetSizeDelta(s, 'free'), s);
  }
});

test('crt palette: saturated hues that survive posterization, all buckets upsized, no pulse', () => {
  for (const b of BUCKETS) {
    const rgba = presetDotRgba('retro', b);
    assert.ok(rgba, `retro/${b}`);
    const [r, g, bl] = rgba;
    const sat = (Math.max(r, g, bl) - Math.min(r, g, bl)) / 255;
    assert.ok(sat >= 0.5, `retro/${b} saturation ${sat.toFixed(2)} ≥ 0.5`);
    assert.ok(presetSizeDelta('retro', b) >= 1, `retro/${b} at least +1px vs pixel grid`);
  }
  assert.ok(presetSizeDelta('retro', 'jam') > presetSizeDelta('retro', 'free'), 'jam still dominant');
});

test('outlines: mono buckets ALL get a dark halo (bright core + dark ring is the readable unit)', () => {
  for (const s of MONO_STYLES) {
    for (const b of BUCKETS) {
      const o = presetDotOutline(s, b);
      assert.ok(o && o.width >= 1, `${s}/${b} has an outline`);
      assert.ok(luma(o.rgba) <= 0.2, `${s}/${b} outline is dark (luma ${luma(o.rgba).toFixed(2)})`);
    }
    assert.ok(presetDotOutline(s, 'jam').width >= presetDotOutline(s, 'slow').width,
      `${s} jam outline at least as wide as slow`);
  }
  for (const b of ['jam', 'slow']) {
    assert.ok(presetDotOutline('retro', b)?.width >= 1, `retro/${b} outlined`);
  }
});

test('trafficBucketTier: flow buckets map to veh_* tiers, sim to veh_nodata, keyless (null) to null', () => {
  assert.equal(trafficBucketTier('jam'), 'veh_jam');
  assert.equal(trafficBucketTier('slow'), 'veh_slow');
  assert.equal(trafficBucketTier('free'), 'veh_free');
  assert.equal(trafficBucketTier('sim'), 'veh_nodata');
  assert.equal(trafficBucketTier(null), null);
  assert.equal(trafficBucketTier(undefined), null);
  assert.equal(trafficBucketTier('garbage'), null);
});

test('outlines: never under the normal profile, never for sim dots', () => {
  for (const s of NORMAL_STYLES) {
    for (const b of [...BUCKETS, 'sim', null]) {
      assert.equal(presetDotOutline(s, b), null, `${String(s)}/${String(b)}`);
    }
  }
  for (const s of [...MONO_STYLES, 'retro']) {
    assert.equal(presetDotOutline(s, null), null, String(s));
    assert.equal(presetDotOutline(s, 'sim'), null, String(s));
  }
});

test('all styled tuples are valid rgba: channels 0–255 ints, alpha in (0, 1]', () => {
  for (const s of [...MONO_STYLES, 'retro']) {
    for (const b of BUCKETS) {
      const [r, g, bl, a] = presetDotRgba(s, b);
      for (const c of [r, g, bl]) {
        assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, `${s}/${b} channel ${c}`);
      }
      assert.ok(a > 0 && a <= 1, `${s}/${b} alpha ${a}`);
    }
  }
});
