import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { evaluateCollapse, peakBaselineFor, tzOffsetMinutes, MARKETS } = require('../scripts/shared/air-traffic-detector.cjs');
const { EUROPE_MARKETS } = require('../scripts/shared/air-traffic-regions.cjs');

// Every bin of every archive day, replayed in time order through the detector,
// once per market. The archive has no Wingbits counterpart, so coverage falls
// back to OpenSky's own baseline, the stricter of the two checks.
const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/air-traffic-archive-series.json.gz', import.meta.url))));
const BIN_MS = 300_000;
const DAY_MS = 86_400_000;

function toPoint(row) {
  const point = { status: 'ok', markets: {} };
  fixture.fields.forEach((field, i) => {
    const value = row[i];
    if (value === null) return;
    const [code, measure] = field.split('.');
    if (measure) (point.markets[code] ??= {})[measure] = value;
    else point[code] = value;
  });
  return point;
}

const points = new Map();
for (const [day, bins] of Object.entries(fixture.days)) {
  const start = Date.parse(`${day}T00:00:00Z`);
  bins.forEach((row, i) => { if (row) points.set(start + i * BIN_MS, toPoint(row)); });
}
const getPoint = (t) => points.get(t);
const iso = (t) => new Date(t).toISOString().slice(0, 16);

function replay(market) {
  // The peak is per market-local day, as the relay computes it for every bin.
  const peaks = new Map();
  const peakFor = (t) => {
    const key = Math.floor((t + tzOffsetMinutes(market.tz, t) * 60_000) / DAY_MS);
    if (!peaks.has(key)) peaks.set(key, peakBaselineFor(t, getPoint, market));
    return peaks.get(key);
  };
  const events = [];
  const verdicts = new Map();
  let state = null;
  for (const day of Object.keys(fixture.days).sort()) {
    const start = Date.parse(`${day}T00:00:00Z`);
    for (let t = start; t < start + DAY_MS; t += BIN_MS) {
      const result = evaluateCollapse(state, { t, point: getPoint(t), getPoint, market, peakBaseline: peakFor(t) });
      state = result.state;
      verdicts.set(state.verdict, (verdicts.get(state.verdict) || 0) + 1);
      if (result.event) events.push(result.event);
    }
  }
  return { events, verdicts, collapses: events.filter((e) => e.kind === 'collapse'), recoveries: events.filter((e) => e.kind === 'recovery') };
}

const byCode = Object.fromEntries(MARKETS.map((market) => [market.code, replay(market)]));

test('the fixture carries every European market the relay records', () => {
  const codes = [...new Set(fixture.fields.filter((f) => f.includes('.')).map((f) => f.split('.')[0]))];
  assert.deepEqual(codes.sort(), EUROPE_MARKETS.map((m) => m.code).sort());
});

test('the replay covers the 2026-11-13 stop and a broad set of ordinary days', () => {
  assert.ok(Object.keys(fixture.days).length >= 80, `${Object.keys(fixture.days).length} days`);
  assert.ok(byCode.US.verdicts.get('normal') > 10_000, JSON.stringify(Object.fromEntries(byCode.US.verdicts)));
});

test('the national ground stop of 2026-11-13 raises one US collapse, 16 minutes after the official 20:54Z stop', () => {
  const { collapses } = byCode.US;
  assert.deepEqual(collapses.map((e) => iso(e.t)), ['2026-11-13T21:10'], 'no other day in the archive raises a collapse');
  assert.equal(iso(collapses[0].onset), '2026-11-13T21:05');
  assert.ok(collapses[0].ratio < 0.4 && collapses[0].control >= 0.3, JSON.stringify(collapses[0]));
});

test('one US recovery follows, once the next morning\'s departures are back near normal', () => {
  // The stop was lifted at 01:15Z, but with 2,500 more cancellations departures
  // stayed near half of normal through the night.
  const { recoveries } = byCode.US;
  assert.deepEqual(recoveries.map((e) => iso(e.t)), ['2026-11-14T12:20']);
  assert.ok(recoveries[0].ratio > 0.7);
});

// Days the archive extraction recorded with the European market counts.
const europeDays = Object.keys(fixture.days).filter((day) => fixture.days[day].some((row) => row && row[fixture.fields.indexOf('GB.dep')] !== null));

test('the European replay covers the 2026-09-08 NATS failure, the winter timetable change and at least 90 days', () => {
  assert.ok(europeDays.length >= 90, `${europeDays.length} days`);
  for (const day of ['2026-09-08', '2026-09-30', '2026-10-25', '2026-11-06', '2026-11-10']) assert.ok(europeDays.includes(day), day);
  assert.ok(byCode.GB.verdicts.get('normal') > 5_000, JSON.stringify(Object.fromEntries(byCode.GB.verdicts)));
});

test('the UK NATS flight-plan failure of 2026-09-08 raises one GB collapse and one recovery', () => {
  const { collapses, recoveries } = byCode.GB;
  assert.deepEqual(collapses.map((e) => iso(e.t)), ['2026-09-08T12:10'], 'no other UK day raises a collapse');
  assert.ok(collapses[0].ratio < 0.3 && collapses[0].control >= 0.3 && collapses[0].coverage >= 0.4, JSON.stringify(collapses[0]));
  assert.deepEqual(recoveries.map((e) => iso(e.t)), ['2026-09-08T18:35']);
});

test('France, Germany, Spain and Italy raise nothing, Italy\'s partial ATC strike of 2026-09-30 and the winter timetable included', () => {
  // Italy reaches the 30-departure window floor only around its daily peaks.
  // Germany's evenings and mornings shifted with the 2026-10-25 winter
  // timetable; without the latest-week cap they raised collapses on
  // 2026-11-06 and 2026-11-10.
  for (const code of ['FR', 'DE', 'ES', 'IT']) {
    assert.deepEqual(byCode[code].events, [], code);
    assert.ok(byCode[code].verdicts.get('normal') > 3_000, `${code} ${JSON.stringify(Object.fromEntries(byCode[code].verdicts))}`);
  }
});
