import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { evaluateCollapse, peakBaselineFor, tzOffsetMinutes, US_TZ } = require('../scripts/shared/air-traffic-detector.cjs');

// Every bin of every archive day, replayed in time order through the detector.
// The archive has no Wingbits counterpart, so coverage falls back to OpenSky's
// own baseline, the stricter of the two checks.
const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/air-traffic-archive-series.json.gz', import.meta.url))));
const BIN_MS = 300_000;
const points = new Map();
for (const [day, bins] of Object.entries(fixture.days)) {
  const start = Date.parse(`${day}T00:00:00Z`);
  bins.forEach((bin, i) => {
    if (!bin) return;
    const [usSeen, euAirborne, usLowClimbingAirline] = bin;
    points.set(start + i * BIN_MS, { status: 'ok', usSeen, euAirborne, usLowClimbingAirline });
  });
}
const getPoint = (t) => points.get(t);
const peakCache = new Map();
// The peak is per US-local day, as the relay computes it for every bin.
const peakFor = (t) => {
  const key = Math.floor((t + tzOffsetMinutes(US_TZ, t) * 60_000) / 86_400_000);
  if (!peakCache.has(key)) peakCache.set(key, peakBaselineFor(t, getPoint));
  return peakCache.get(key);
};

const events = [];
const verdicts = new Map();
let state = null;
for (const day of Object.keys(fixture.days).sort()) {
  const start = Date.parse(`${day}T00:00:00Z`);
  for (let t = start; t < start + 86_400_000; t += BIN_MS) {
    const result = evaluateCollapse(state, { t, point: getPoint(t), wingbits: undefined, getPoint, peakBaseline: peakFor(t) });
    state = result.state;
    verdicts.set(state.verdict, (verdicts.get(state.verdict) || 0) + 1);
    if (result.event) events.push(result.event);
  }
}
const iso = (t) => new Date(t).toISOString().slice(0, 16);

test('the replay covers the 2026-11-13 stop and a broad set of ordinary days', () => {
  assert.ok(Object.keys(fixture.days).length >= 80, `${Object.keys(fixture.days).length} days`);
  assert.ok(verdicts.get('normal') > 10_000, JSON.stringify(Object.fromEntries(verdicts)));
});

test('the national ground stop of 2026-11-13 raises one collapse, 16 minutes after the official 20:54Z stop', () => {
  const collapses = events.filter((e) => e.kind === 'collapse');
  assert.deepEqual(collapses.map((e) => iso(e.t)), ['2026-11-13T21:10'], 'no other day in the archive raises a collapse');
  assert.equal(iso(collapses[0].onset), '2026-11-13T21:05');
  assert.ok(collapses[0].ratio < 0.4 && collapses[0].europe >= 0.3, JSON.stringify(collapses[0]));
});

test('one recovery follows, once the next morning\'s departures are back near normal', () => {
  // The stop was lifted at 01:15Z, but with 2,500 more cancellations departures
  // stayed near half of normal through the night.
  const recoveries = events.filter((e) => e.kind === 'recovery');
  assert.deepEqual(recoveries.map((e) => iso(e.t)), ['2026-11-14T12:25']);
  assert.ok(recoveries[0].ratio > 0.7);
});
