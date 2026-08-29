import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FOCUS_DEEMPHASIS_PARAMS,
  advanceFocusEvidenceNowMs,
  advanceSpriteFocus,
  focusNowMs,
  focusTargetEmphasis,
  nearFarScalarValueAtDistance,
  setFocusEvidenceNowMs,
  smoothFocusEmphasis,
} from './focusDeemphasis.js';

const params = { ...DEFAULT_FOCUS_DEEMPHASIS_PARAMS, paddingPx: 0 };
const target = {
  screenRect: { left: 40, top: 40, right: 60, bottom: 60 },
  paddingPx: 0,
  cameraDistance: 1000,
};

test('focus decision dims a farther sprite inside and preserves one outside', () => {
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 1200, target, params), 0.25);
  assert.equal(focusTargetEmphasis({ x: 61, y: 50 }, 1200, target, params), 1);
});

test('focus decision keeps nearer behavior tunable across allow, dim, and partial', () => {
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 800, target, { ...params, nearerBehavior: 'allow' }), 1);
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 800, target, { ...params, nearerBehavior: 'dim' }), 0.25);
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 800, target, { ...params, nearerBehavior: 'partial' }), 0.625);
});

test('focus decision applies padding and hysteresis at the boundary', () => {
  assert.equal(focusTargetEmphasis({ x: 64, y: 50 }, 1200, target, { ...params, paddingPx: 3 }), 1);
  assert.equal(focusTargetEmphasis({ x: 63, y: 50 }, 1200, target, { ...params, paddingPx: 3 }), 0.25);
  assert.equal(focusTargetEmphasis({ x: 65, y: 50 }, 1200, target, { ...params, hysteresisPx: 6 }, false), 1);
  assert.equal(focusTargetEmphasis({ x: 65, y: 50 }, 1200, target, { ...params, hysteresisPx: 6 }, true), 0.25);
});

test('focus overlap includes the ambient sprite own rendered extent', () => {
  assert.equal(focusTargetEmphasis({ x: 68, y: 50 }, 1200, target, params, false, 8, 8), 0.25);
  assert.equal(focusTargetEmphasis({ x: 68, y: 50 }, 1200, target, params, false, 2, 2), 1);
});

test('focus decision never falls below the configured floor', () => {
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 1200, target, { ...params, dimFloor: 0.41 }), 0.41);
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 1200, target, { ...params, dimFloor: 0 }), 0.01);
});

test('smoothing converges over configured attack and release instead of snapping', () => {
  const attackMid = smoothFocusEmphasis(1, 0.25, 150, params);
  assert.ok(attackMid < 1 && attackMid > 0.25, `attack midpoint=${attackMid}`);
  assert.equal(smoothFocusEmphasis(1, 0.25, 300, params), 0.25);
  const releaseMid = smoothFocusEmphasis(0.25, 1, 300, params);
  assert.ok(releaseMid > 0.25 && releaseMid < 1, `release midpoint=${releaseMid}`);
  assert.equal(smoothFocusEmphasis(0.25, 1, 600, params), 1);
});

test('default attack yields at least four distinct 80 ms sampled values', () => {
  const samples = [0, 80, 160, 240, 320]
    .map((elapsedMs) => smoothFocusEmphasis(1, 0.25, elapsedMs, params));
  assert.ok(new Set(samples.slice(1)).size >= 4, `samples=${samples.join(',')}`);
  assert.equal(samples.at(-1), 0.25);
});

test('per-sprite state attacks, restores after focus clears, and settles at one', () => {
  const sprite = {};
  const input = { screenPosition: { x: 50, y: 50 }, cameraDistance: 1200, target, params };
  assert.equal(advanceSpriteFocus(sprite, { ...input, nowMs: 0 }).factor, 1);
  const attack = advanceSpriteFocus(sprite, { ...input, nowMs: 150 });
  assert.ok(attack.factor < 1 && attack.factor > 0.25);
  assert.equal(advanceSpriteFocus(sprite, { ...input, nowMs: 300 }).factor, 0.25);
  assert.equal(advanceSpriteFocus(sprite, { ...input, target: null, nowMs: 300 }).factor, 0.25);
  const release = advanceSpriteFocus(sprite, { ...input, target: null, nowMs: 600 });
  assert.ok(release.factor > 0.25 && release.factor < 1);
  assert.equal(advanceSpriteFocus(sprite, { ...input, target: null, nowMs: 900 }).factor, 1);
});

test('distance chatter reanchors from current progress and converges toward the majority state', () => {
  const sprite = {};
  const chatterParams = { ...params, nearerBehavior: 'allow', distanceHysteresisRatio: 0.08 };
  const distances = [1200, 990, 1010, 995, 1005, 990, 1200, 990, 1010];
  const factors = distances.map((cameraDistance, index) => advanceSpriteFocus(sprite, {
    screenPosition: { x: 50, y: 50 },
    cameraDistance,
    target,
    params: chatterParams,
    nowMs: index * 80,
  }).factor);
  for (let index = 1; index < factors.length; index += 1) {
    assert.ok(factors[index] <= factors[index - 1] + 1e-12, `factors=${factors.join(',')}`);
  }
  assert.ok(factors.at(-1) < 0.5, `factors=${factors.join(',')}`);

  const dimSprite = {};
  const dimFactors = [0, 80, 160, 240].map((nowMs, index) => advanceSpriteFocus(dimSprite, {
    screenPosition: { x: 50, y: 50 },
    cameraDistance: index % 2 ? 990 : 1010,
    target,
    params: { ...params, nearerBehavior: 'dim' },
    nowMs,
  }).factor);
  assert.ok(dimFactors.at(-1) < 1, `dimFactors=${dimFactors.join(',')}`);
});

test('alternating desired state reanchors from sampled progress and converges to a stable cycle', () => {
  const sprite = {};
  const chatterParams = { ...params, nearerBehavior: 'allow', distanceHysteresisRatio: 0.08 };
  const factors = Array.from({ length: 20 }, (_, index) => advanceSpriteFocus(sprite, {
    screenPosition: { x: 50, y: 50 },
    // Cross both sides of the range hysteresis band every tick so `desired`
    // truly alternates instead of latching in the prior state.
    cameraDistance: index % 2 === 0 ? 1200 : 800,
    target,
    params: chatterParams,
    nowMs: index * 80,
  }).factor);

  assert.ok(new Set(factors).size >= 16, `factors=${factors.join(',')}`);
  const earlyEvenDelta = Math.abs(factors[4] - factors[2]);
  const lateEvenDelta = Math.abs(factors[18] - factors[16]);
  const earlyOddDelta = Math.abs(factors[5] - factors[3]);
  const lateOddDelta = Math.abs(factors[19] - factors[17]);
  assert.ok(lateEvenDelta < earlyEvenDelta, `even factors=${factors.join(',')}`);
  assert.ok(lateOddDelta < earlyOddDelta, `odd factors=${factors.join(',')}`);
});

test('advanceSpriteFocus returns its documented module singleton', () => {
  const sprite = {};
  const input = { screenPosition: { x: 50, y: 50 }, cameraDistance: 1200, target, params };
  const first = advanceSpriteFocus(sprite, { ...input, nowMs: 0 });
  const second = advanceSpriteFocus(sprite, { ...input, nowMs: params.attackMs });
  assert.strictEqual(first, second);
  assert.equal(first.factor, params.dimFloor, 'the prior reference reflects the next call');
});

test('evidence clock produces identical alpha sequences across repeated captures', () => {
  const sequenceOffsets = [0, 80, 160, 240, 320, 400, 560, 720, 880, 1040];
  const capture = (productionClockBase, productionClockStep) => {
    setFocusEvidenceNowMs(10_000);
    const sprite = {};
    const sequence = sequenceOffsets.map((offset, index) => {
      if (index > 0) advanceFocusEvidenceNowMs(offset - sequenceOffsets[index - 1]);
      const nowMs = focusNowMs(productionClockBase + index * productionClockStep);
      return advanceSpriteFocus(sprite, {
        screenPosition: { x: 50, y: 50 },
        cameraDistance: 1200,
        target: offset <= 320 ? target : null,
        params,
        nowMs,
      }).factor;
    });
    setFocusEvidenceNowMs(null);
    return sequence;
  };
  assert.deepEqual(capture(1_000, 1), capture(1_000_000, 9_999));
});

test('NearFarScalar rendered-size interpolation matches Cesium clamp endpoints', () => {
  const scalar = { near: 1000, nearValue: 3, far: 8_000_000, farValue: 0.5 };
  assert.equal(nearFarScalarValueAtDistance(scalar, 500), 3);
  assert.equal(nearFarScalarValueAtDistance(scalar, 9_000_000), 0.5);
  const middle = nearFarScalarValueAtDistance(scalar, 1_000_000);
  assert.ok(middle > 0.5 && middle < 3);
});
