// src/data/trafficFlowStyle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowBucket,
  flowColor,
  flowSpeedScale,
  flowDensityMult,
  FLOW_BUCKET_RGBA,
} from './trafficFlowStyle.js';

// ── bucket thresholds ───────────────────────────────────────

test('flowBucket: >= 0.85 is free-flowing', () => {
  assert.equal(flowBucket(1), 'free');
  assert.equal(flowBucket(0.85), 'free');
  assert.equal(flowBucket(0.9), 'free');
});

test('flowBucket: [0.55, 0.85) is slow', () => {
  assert.equal(flowBucket(0.849999), 'slow');
  assert.equal(flowBucket(0.7), 'slow');
  assert.equal(flowBucket(0.55), 'slow');
});

test('flowBucket: < 0.55 is jammed', () => {
  assert.equal(flowBucket(0.549999), 'jam');
  assert.equal(flowBucket(0.2), 'jam');
  assert.equal(flowBucket(0), 'jam');
});

test('flowBucket: non-finite input degrades to free (no false alarms)', () => {
  assert.equal(flowBucket(NaN), 'free');
  assert.equal(flowBucket(undefined), 'free');
});

// ── colors ──────────────────────────────────────────────────

test('flowColor returns the rgba tuple for the level bucket', () => {
  assert.deepEqual(flowColor(1), FLOW_BUCKET_RGBA.free);
  assert.deepEqual(flowColor(0.7), FLOW_BUCKET_RGBA.slow);
  assert.deepEqual(flowColor(0.1), FLOW_BUCKET_RGBA.jam);
});

test('bucket palette: green #2ecc71 / amber #f0b23e / red #e05252 @ alpha 0.9', () => {
  assert.deepEqual(FLOW_BUCKET_RGBA.free, [46, 204, 113, 0.9]);
  assert.deepEqual(FLOW_BUCKET_RGBA.slow, [240, 178, 62, 0.9]);
  assert.deepEqual(FLOW_BUCKET_RGBA.jam, [224, 82, 82, 0.9]);
});

// ── speed scale ─────────────────────────────────────────────

test('flowSpeedScale: clamps level into [0.15, 1]', () => {
  assert.equal(flowSpeedScale(1), 1);
  assert.equal(flowSpeedScale(0.6), 0.6);
  assert.equal(flowSpeedScale(0.15), 0.15);
  assert.equal(flowSpeedScale(0.05), 0.15); // jam crawls, never freezes
  assert.equal(flowSpeedScale(0), 0.15);
  assert.equal(flowSpeedScale(1.5), 1);
});

test('flowSpeedScale: non-finite input keeps full speed (sim parity)', () => {
  assert.equal(flowSpeedScale(NaN), 1);
  assert.equal(flowSpeedScale(undefined), 1);
});

// ── density multiplier ──────────────────────────────────────

test('flowDensityMult: congestion packs more dots, capped at 2.5', () => {
  assert.equal(flowDensityMult(1), 1);
  assert.ok(Math.abs(flowDensityMult(0.5) - 2) < 1e-12);
  assert.equal(flowDensityMult(0.4), 2.5);
  assert.equal(flowDensityMult(0.1), 2.5); // 1/max(level, 0.4) caps the blowup
  assert.equal(flowDensityMult(0), 2.5);
});

test('flowDensityMult: non-finite input keeps neutral density (sim parity)', () => {
  assert.equal(flowDensityMult(NaN), 1);
  assert.equal(flowDensityMult(undefined), 1);
});

// ── jam-boost density curve (jamViz density prototype) ──────

test('flowDensityMult jamBoost: identical to base curve down to level 0.4', () => {
  assert.equal(flowDensityMult(1, { jamBoost: true }), 1);
  assert.ok(Math.abs(flowDensityMult(0.5, { jamBoost: true }) - 2) < 1e-12);
  assert.equal(flowDensityMult(0.4, { jamBoost: true }), 2.5);
});

test('flowDensityMult jamBoost: deep jams keep climbing to a 4.0 cap', () => {
  assert.ok(Math.abs(flowDensityMult(0.3, { jamBoost: true }) - (1 / 0.3)) < 1e-12);
  assert.equal(flowDensityMult(0.25, { jamBoost: true }), 4);
  assert.equal(flowDensityMult(0.1, { jamBoost: true }), 4);
  assert.equal(flowDensityMult(0, { jamBoost: true }), 4);
});

test('flowDensityMult jamBoost: non-finite input still neutral (sim parity)', () => {
  assert.equal(flowDensityMult(NaN, { jamBoost: true }), 1);
  assert.equal(flowDensityMult(undefined, { jamBoost: true }), 1);
});

test('flowDensityMult: opts omitted or jamBoost false keeps the shipped 2.5 cap', () => {
  assert.equal(flowDensityMult(0.1), 2.5);
  assert.equal(flowDensityMult(0.1, {}), 2.5);
  assert.equal(flowDensityMult(0.1, { jamBoost: false }), 2.5);
});
