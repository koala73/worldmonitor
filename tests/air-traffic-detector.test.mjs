import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const detector = require('../scripts/shared/air-traffic-detector.cjs');
const { evaluateCollapse, sameLocalBin, ENTER_RATIO } = detector;

const BIN = 300_000;
const T0 = Date.parse('2026-11-13T20:30:00Z');
const NORMAL = { status: 'ok', usSeen: 3000, euAirborne: 2000, usLowClimbingAirline: 100 };
const at = (signal, extra = {}) => ({ ...NORMAL, usLowClimbingAirline: Math.round(signal * 100), ...extra });

// Four prior weeks of ordinary traffic at every bin, unless a test trims them.
function history({ weeks = 4 } = {}) {
  const cutoff = T0 - weeks * 7 * 86_400_000 - 86_400_000;
  return (t) => (t < T0 - 3_600_000 && t > cutoff ? NORMAL : undefined);
}

function run(points, { getPoint = history(), wingbits = [], peakBaseline = 100, start = null } = {}) {
  let state = start;
  const out = [];
  points.forEach((point, i) => {
    const t = T0 + i * BIN;
    const result = evaluateCollapse(state, { t, point, wingbits: wingbits[i], getPoint, peakBaseline });
    state = result.state;
    out.push({ verdict: state.verdict, event: result.event });
  });
  return { state, out, events: out.map((o) => o.event).filter(Boolean) };
}

test('the baseline bin keeps local wall-clock time across a DST change', () => {
  const t = Date.parse('2026-11-13T20:55:00Z');
  assert.equal(new Date(sameLocalBin(t, 1, 'America/New_York')).toISOString(), '2026-11-06T20:55:00.000Z', 'both after the US change on 2026-11-01');
  assert.equal(new Date(sameLocalBin(t, 2, 'America/New_York')).toISOString(), '2026-10-30T19:55:00.000Z', '15:55 EST is 15:55 EDT two weeks earlier');
  assert.equal(new Date(sameLocalBin(t, 3, 'Europe/Paris')).toISOString(), '2026-10-23T19:55:00.000Z', 'Europe changed on 2026-10-25');
  assert.equal(new Date(sameLocalBin(t, 1, 'Europe/Paris')).toISOString(), '2026-11-06T20:55:00.000Z');
});

test('two consecutive bins under the entry ratio raise one collapse; one bin does not', () => {
  assert.equal(run([at(0.3), at(1)]).events.length, 0, 'a single-bin dip');
  const { events } = run([at(1), at(0.35), at(0.3), at(0.2)]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'collapse');
  assert.equal(events[0].t, T0 + 2 * BIN);
  assert.equal(events[0].onset, T0 + BIN);
  assert.ok(Math.abs(events[0].ratio - 0.3) < 1e-9);
  assert.equal(run([at(ENTER_RATIO), at(ENTER_RATIO)]).events.length, 0, 'the entry ratio itself is not under it');
});

test('a gap inside the run waits for two ok points rather than counting as low', () => {
  const { events, out } = run([at(0.3), { status: 'gap' }, undefined, at(0.3)]);
  assert.deepEqual(out.map((o) => o.verdict), ['normal', 'gap', 'gap', 'entered']);
  assert.equal(events.length, 1);
});

test('a dead OpenSky feed, seen in Europe, blocks the alert and resets the run', () => {
  const dead = (s) => at(s, { euAirborne: 500 });
  const { events, out } = run([dead(0.2), dead(0.2), at(0.2), dead(0.2)]);
  assert.equal(events.length, 0);
  assert.deepEqual(out.map((o) => o.verdict), ['blocked-feed', 'blocked-feed', 'normal', 'blocked-feed']);
});

test('OpenSky losing US coverage against Wingbits blocks the alert', () => {
  const wingbits = Array(3).fill({ status: 'ok', usSeen: 4000 });
  const { events, out } = run([at(0.2), at(0.2), at(0.2)], { wingbits });
  assert.equal(events.length, 0);
  assert.equal(out[0].verdict, 'blocked-coverage');
  assert.equal(run([at(0.2), at(0.2)], { wingbits: Array(2).fill({ status: 'ok', usSeen: 3100 }) }).events.length, 1);
});

test('without a Wingbits point, coverage is OpenSky against its own baseline', () => {
  const lostReceivers = (s) => at(s, { usSeen: 1500 });
  assert.equal(run([lostReceivers(0.2), lostReceivers(0.2)]).out[0].verdict, 'blocked-coverage');
  assert.equal(run([lostReceivers(0.2), lostReceivers(0.2)], { wingbits: [{ status: 'gap' }, undefined] }).events.length, 0);
});

test('fewer than two baseline weeks never alerts', () => {
  const { events, out } = run([at(0.1), at(0.1), at(0.1)], { getPoint: history({ weeks: 1 }) });
  assert.equal(events.length, 0);
  assert.equal(out[0].verdict, 'insufficient-baseline');
  assert.equal(run([at(0.1), at(0.1)], { getPoint: history({ weeks: 2 }) }).events.length, 1);
});

test('quiet hours neither alert nor break a run', () => {
  assert.equal(run([at(0.1), at(0.1)], { peakBaseline: 500 }).out[1].verdict, 'quiet');
  assert.equal(run([at(0.1), at(0.1)], { peakBaseline: 500 }).events.length, 0);
});

test('re-evaluating a bin after a restart does not raise a second event', () => {
  const first = run([at(0.3), at(0.3)]);
  assert.equal(first.events.length, 1);
  const again = evaluateCollapse(first.state, { t: T0 + BIN, point: at(0.3), getPoint: history(), peakBaseline: 100 });
  assert.equal(again.event?.kind, 'collapse', 'the same bin replays from the state before it');
  assert.equal(again.state.state, 'collapsed');
  const next = evaluateCollapse(again.state, { t: T0 + 2 * BIN, point: at(0.3), getPoint: history(), peakBaseline: 100 });
  assert.equal(next.event, null);
});

test('two consecutive bins over the exit ratio recover; the feed checks do not hold a collapse open', () => {
  const parked = (s) => at(s, { usSeen: 600, euAirborne: 900 });
  const { events } = run([at(0.3), at(0.3), parked(0.2), parked(0.8), parked(0.6), parked(0.8), parked(0.9)]);
  assert.deepEqual(events.map((e) => [e.kind, (e.t - T0) / BIN]), [['collapse', 1], ['recovery', 6]]);
  assert.equal(events[1].onset, T0);
});

test('the stored state keeps one level of history, so it does not grow tick by tick', () => {
  const { state } = run(Array(50).fill(at(1)));
  assert.equal(state.prior.prior, undefined);
  assert.ok(JSON.stringify(state).length < 1000);
});

test('the quiet-hours peak scans the whole local day, including the first hour of a 25-hour DST day', () => {
  // 2026-11-01 in New York runs 04:00Z to 05:00Z the next day. The busiest
  // baseline bin sits at 00:30 local (04:30Z), in the hour a fixed 24-hour
  // scan from the end-of-day offset would skip.
  const busy = new Set([1, 2, 3, 4].map((w) => sameLocalBin(Date.parse('2026-11-01T04:30:00Z'), w, 'America/New_York')));
  const getPoint = (t) => ({ ...NORMAL, usLowClimbingAirline: busy.has(t) ? 500 : 100 });
  assert.equal(detector.peakBaselineFor(Date.parse('2026-11-01T18:00:00Z'), getPoint), 500);
  // The last bin of the day, 04:55Z on 2026-11-02, belongs to it too.
  const late = new Set([1, 2, 3, 4].map((w) => sameLocalBin(Date.parse('2026-11-02T04:55:00Z'), w, 'America/New_York')));
  const lateGet = (t) => ({ ...NORMAL, usLowClimbingAirline: late.has(t) ? 700 : 100 });
  assert.equal(detector.peakBaselineFor(Date.parse('2026-11-01T18:00:00Z'), lateGet), 700);
});
