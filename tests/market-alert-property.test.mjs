import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MARKET_ALERT_ACTIVITY_GAP_MS,
  MARKET_ALERT_CONFIDENCE_GATE,
  MARKET_ALERT_TICK_MS,
  MARKET_ALERT_WINDOW_MS,
  ingestSignals,
} from '../scripts/_market-alert-ledger.mjs';
import { liveBaseline, parseSnapshot, snapshotHistory, snapshotOf } from '../scripts/seed-market-alert-ledger.mjs';

const MIN = 60 * 1000;
const START = Date.UTC(2026, 9, 6, 12, 0, 0);
const TIMELINES = 300;
const BASE_SEED = Number.parseInt(process.env.MARKET_ALERT_PROPERTY_SEED ?? '8951', 10);
const MARKET = { symbol: 'AVGO', name: 'Broadcom', display: 'AVGO', price: 1500, change: 5.0 };
const TYPES = { explained: 'explained_market_move', silent: 'silent_divergence', flow: 'flow_price_divergence' };
const TYPE_NAMES = Object.keys(TYPES);

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each entry is one kind of tick the generator can draw, with its weight. A
// step emits the timeline's current type unless the entry says otherwise. The
// last four break a stretch or blind the ledger; a calm timeline draws them
// a tenth as often so that stretches outlive the six-hour window.
const FEATURES = [
  ['emit', 55, (draw) => ({ feature: draw.current })],
  ['two', 6, (draw) => ({ types: [draw.current, draw.other()] })],
  ['dropout', 10, () => ({ types: [] })],
  ['gated', 6, () => ({ confidence: 0.5 })],
  ['feed-skipped', 5, () => ({ types: [], quoted: false })],
  ['stale', 4, (draw) => ({ advanceMs: (16 + draw.int(25)) * MIN })],
  ['missing', 5, (draw) => ({ advanceMs: (2 + draw.int(6)) * 5 * MIN })],
  ['rejected', 4, (draw) => ({ reject: draw.pick(['activity-object', 'no-emitted']) })],
];
const CALM_FEATURES = new Set(['feed-skipped', 'stale', 'missing', 'rejected']);
const COVERAGE_KEYS = [...TYPE_NAMES, ...FEATURES.slice(1).map(([name]) => name), 'cold', 'calm'];

function generateTimeline(baseSeed, index) {
  const seed = (baseSeed + Math.imul(index + 1, 0x9E3779B1)) >>> 0;
  const random = mulberry32(seed);
  const int = (n) => Math.floor(random() * n);
  const pick = (options) => options[int(options.length)];
  const length = 40 + int(81);
  const cold = random() < 0.3;
  const calm = random() < 0.4;
  const flip = pick([0.02, 0.07, 0.2]);
  const weights = FEATURES.map(([name, weight]) => (calm && CALM_FEATURES.has(name) ? weight / 10 : weight));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let current = pick(TYPE_NAMES);
  const draw = { int, pick, get current() { return current; }, other: () => pick(TYPE_NAMES.filter((name) => name !== current)) };
  const steps = [];
  for (let i = 0; i < length; i += 1) {
    if (random() < flip) current = draw.other();
    let roll = random() * totalWeight;
    const [feature, , step] = FEATURES.find((_, position) => (roll -= weights[position]) < 0);
    steps.push({ feature, types: [current], confidence: 0.7, quoted: true, advanceMs: 5 * MIN, reject: null, ...step(draw) });
  }
  return { index, seed, cold, calm, steps };
}

function marketSignal(type, market, { confidence, nowMs }) {
  return {
    id: `sig-${type}-${market.symbol}`,
    type,
    title: 'Market Alert',
    description: `${market.name} moved +${market.change.toFixed(2)}%`,
    confidence,
    timestamp: new Date(nowMs),
    data: { marketChange: market.change, newsVelocity: 0, correlatedEntities: [market.symbol] },
  };
}

function stored(snapshot, fetchedAt) {
  const envelope = { _seed: { fetchedAt, recordCount: 1, sourceVersion: 'market-alert-ledger-v1', schemaVersion: 1, state: 'OK' }, data: snapshot };
  return JSON.parse(JSON.stringify(envelope));
}

const REJECTED_SHAPES = {
  'activity-object': (envelope) => ({ ...envelope, data: { ...envelope.data, activity: { [MARKET.symbol]: { since: envelope.data.timestamp, until: envelope.data.timestamp } } } }),
  'no-emitted': (envelope) => ({ ...envelope, data: Object.fromEntries(Object.entries(envelope.data).filter(([key]) => key !== 'emitted')) }),
};

function runTimeline(timeline) {
  let ledger = {};
  let nowMs = START;
  let snapshot = timeline.cold
    ? null
    : stored(snapshotOf({ nowMs, predictions: [], predictionsFetchedAt: null, markets: [MARKET], emitted: [], activity: {} }), nowMs);
  const log = [];
  for (const step of timeline.steps) {
    nowMs += step.advanceMs;
    if (step.reject !== null && snapshot !== null) snapshot = REJECTED_SHAPES[step.reject](snapshot);
    const baseline = liveBaseline(parseSnapshot(snapshot), nowMs);
    const { observedAt, activity } = snapshotHistory(snapshot);
    const markets = step.quoted ? [MARKET] : [];
    const signals = step.types.map((name) => marketSignal(TYPES[name], MARKET, { confidence: step.confidence, nowMs }));
    const before = new Set(Object.keys(ledger));
    const ingested = ingestSignals(ledger, signals, { nowMs, runtimeMode: 'legacy', markets, predictions: [], baseline, activity, observedAt });
    ledger = ingested.ledger;
    snapshot = stored(snapshotOf({ nowMs, predictions: [], predictionsFetchedAt: null, markets, emitted: ingested.emitted, activity: ingested.activity }), nowMs);
    log.push({
      nowMs,
      step,
      emitted: step.confidence >= MARKET_ALERT_CONFIDENCE_GATE ? step.types.map((name) => TYPES[name]) : [],
      baseline: baseline === null ? 'null' : Object.hasOwn(baseline.marketChanges, MARKET.symbol) ? 'live' : 'unquoted',
      created: Object.values(ledger).filter((row) => !before.has(row.key)).map((row) => row.type).sort(),
    });
  }
  return { ledger, log };
}

// Consecutive emitting ticks are one stretch while the quiet between them,
// in observed time, is at most the activity gap: a seeder outage observes
// nothing, so the interval between two log entries counts for at most one
// tick. Dropouts, gated ticks and feed-skipped ticks inside the bound do not
// break a stretch, and neither does a snapshot rejected for a missing field,
// whose runs the seeder salvages. The object-valued activity of the previous
// snapshot shape cannot be salvaged, so that rejection breaks one.
function stretchesOf(log) {
  const stretches = [];
  let quiet = Infinity;
  for (let i = 0; i < log.length; i += 1) {
    if (i > 0) quiet += Math.min(log[i].nowMs - log[i - 1].nowMs, MARKET_ALERT_TICK_MS);
    if (log[i].step.reject === 'activity-object') quiet = Infinity;
    if (log[i].emitted.length === 0) continue;
    if (quiet <= MARKET_ALERT_ACTIVITY_GAP_MS) stretches.at(-1).last = i;
    else stretches.push({ first: i, last: i });
    quiet = 0;
  }
  return stretches;
}

const minutes = (ms) => `+${(ms - START) / MIN}m`;
const rowsCreated = (log) => log.flatMap((tick) => tick.created.map((type) => `${type}@${minutes(tick.nowMs)}`));

function atMostOneRowPerTypeInAStretch(log) {
  for (const { first, last } of stretchesOf(log)) {
    const counts = {};
    for (const tick of log.slice(first, last + 1)) for (const type of tick.created) counts[type] = (counts[type] ?? 0) + 1;
    const repeated = Object.entries(counts).find(([, count]) => count > 1);
    if (repeated) return `${repeated[1]} ${repeated[0]} rows in the stretch ${minutes(log[first].nowMs)}..${minutes(log[last].nowMs)}`;
  }
  return null;
}

// A stretch whose first emitting tick has no live baseline is held by design,
// and one that starts inside an earlier row's window, or within the gap of
// its deadline, updates or holds that row instead, so only stretches clear of
// both are checked.
function freshStretchOpensOneRowPerEmittedType(log) {
  for (const { first, last } of stretchesOf(log)) {
    const opening = log[first];
    if (opening.baseline !== 'live') continue;
    const clearSince = opening.nowMs - MARKET_ALERT_WINDOW_MS - MARKET_ALERT_ACTIVITY_GAP_MS;
    if (log.slice(0, first).some((tick) => tick.created.length > 0 && tick.nowMs >= clearSince)) continue;
    const expected = [...opening.emitted].sort();
    if (JSON.stringify(opening.created) !== JSON.stringify(expected)) {
      return `the stretch opening at ${minutes(opening.nowMs)} created [${opening.created}] on its first tick, expected [${expected}]`;
    }
    const later = log.slice(first + 1, last + 1).flatMap((tick) => tick.created.map((type) => `${type}@${minutes(tick.nowMs)}`));
    const allowed = opening.emitted.includes(TYPES.explained) ? [] : [TYPES.explained];
    if (later.length > 1 || later.some((row) => !allowed.includes(row.split('@')[0]))) {
      return `the stretch opening at ${minutes(opening.nowMs)} with [${opening.emitted}] later created [${later}]`;
    }
  }
  return null;
}

// A baseline-less tick holds every alert, so the tick after it is the first
// with a live baseline that could reopen what the held tick saw.
function noRowWithoutALiveQuotedBaseline(log) {
  for (let i = 0; i < log.length; i += 1) {
    const tick = log[i];
    if (tick.created.length === 0) continue;
    if (tick.baseline !== 'live') return `[${tick.created}] created at ${minutes(tick.nowMs)} with baseline ${tick.baseline}`;
    if (!tick.step.quoted) return `[${tick.created}] created at ${minutes(tick.nowMs)} on a feed-skipped tick`;
    const previous = log[i - 1];
    const reopened = previous?.baseline === 'null' ? tick.created.filter((type) => previous.emitted.includes(type)) : [];
    if (reopened.length > 0) return `[${reopened}] created at ${minutes(tick.nowMs)}, the tick after a baseline-less tick that emitted [${previous.emitted}]`;
  }
  return null;
}

// A stretch that opens without a live quoted baseline opens on a hold, and
// nothing later in it can say the move was new: it creates no row of a type
// its opening tick emitted, and no other row either, except one explained row
// when the opening tick emitted no explained alert, as a move that was silent
// and then found its news gets its explained row.
function heldOpeningCreatesNoRowOfItsTypes(log) {
  for (const { first, last } of stretchesOf(log)) {
    const opening = log[first];
    if (opening.baseline === 'live') continue;
    const allowed = opening.emitted.includes(TYPES.explained) ? [] : [TYPES.explained];
    const rows = log.slice(first, last + 1).flatMap((tick) => tick.created.map((type) => `${type}@${minutes(tick.nowMs)}`));
    if (rows.length > 1 || rows.some((row) => !allowed.includes(row.split('@')[0]))) {
      return `the stretch opening at ${minutes(opening.nowMs)} on a ${opening.baseline} baseline with [${opening.emitted}] created [${rows}]`;
    }
  }
  return null;
}

function describeStep(step) {
  const types = step.types.join('+');
  const detail = step.reject === null ? step.feature : `${step.feature}(${step.reject})`;
  return `+${step.advanceMs / MIN}m ${types ? `${detail}:${types}` : detail}`;
}

function shrink(timeline, violation) {
  const fails = (steps) => violation(runTimeline({ ...timeline, steps }).log) !== null;
  let steps = timeline.steps;
  while (steps.length > 1 && fails(steps.slice(0, -1))) steps = steps.slice(0, -1);
  for (let i = 0; i < steps.length;) {
    const candidate = [...steps.slice(0, i), ...steps.slice(i + 1)];
    if (candidate.length > 0 && fails(candidate)) steps = candidate;
    else i += 1;
  }
  return { ...timeline, steps };
}

function failureReport(violation, failing) {
  const shrunkReports = failing.slice(0, 3).map((index) => {
    const shrunk = shrink(timelines[index], violation);
    const { log } = runTimeline(shrunk);
    return [
      `timeline ${index} (seed ${shrunk.seed}, ${shrunk.cold ? 'cold' : 'warm'} start${shrunk.calm ? ', calm' : ''}) shrunk to ${shrunk.steps.length} ticks: ${violation(log)}`,
      `steps: ${shrunk.steps.map(describeStep).join(' | ')}`,
      `rows created: ${rowsCreated(log).join(', ') || 'none'}`,
    ].join('\n');
  });
  return [
    `${failing.length} of ${TIMELINES} timelines failed at seed ${BASE_SEED} (indexes ${failing.slice(0, 10).join(', ')}${failing.length > 10 ? ', ...' : ''})`,
    ...shrunkReports,
  ].join('\n\n');
}

const timelines = Array.from({ length: TIMELINES }, (_, index) => generateTimeline(BASE_SEED, index));
const runs = timelines.map((timeline) => runTimeline(timeline).log);

function check(violation) {
  const failing = timelines.filter((timeline) => violation(runs[timeline.index]) !== null).map((timeline) => timeline.index);
  assert.equal(failing.length, 0, failing.length === 0 ? '' : failureReport(violation, failing));
}

describe(`market-alert ledger property (seed ${BASE_SEED}, ${TIMELINES} timelines)`, () => {
  it('every generated feature appears in several timelines', (t) => {
    const coverage = Object.fromEntries(COVERAGE_KEYS.map((key) => [key, { timelines: 0, ticks: 0 }]));
    for (const timeline of timelines) {
      const seen = new Set([timeline.cold ? 'cold' : [], timeline.calm ? 'calm' : []].flat());
      for (const step of timeline.steps) {
        coverage[step.feature].ticks += 1;
        seen.add(step.feature);
      }
      for (const key of seen) coverage[key].timelines += 1;
    }
    const stretches = runs.map(stretchesOf);
    const checkedByB = runs.reduce((count, log) => count + stretchesOf(log).filter(({ first }) => {
      const opening = log[first];
      const clearSince = opening.nowMs - MARKET_ALERT_WINDOW_MS - MARKET_ALERT_ACTIVITY_GAP_MS;
      return opening.baseline === 'live' && !log.slice(0, first).some((tick) => tick.created.length > 0 && tick.nowMs >= clearSince);
    }).length, 0);
    const checkedByD = runs.reduce((count, log) => count + stretchesOf(log).filter(({ first }) => log[first].baseline !== 'live').length, 0);
    const ticks = runs.reduce((count, log) => count + log.length, 0);
    const rows = runs.reduce((count, log) => count + rowsCreated(log).length, 0);
    t.diagnostic(`seed ${BASE_SEED}: ${TIMELINES} timelines, ${ticks} ticks, ${stretches.flat().length} stretches (${checkedByB} opened clear with a live baseline, ${checkedByD} opened on a hold), ${rows} rows created`);
    for (const [key, counts] of Object.entries(coverage)) {
      t.diagnostic(`${key}: ${counts.timelines} timelines, ${counts.ticks} ticks`);
      assert.ok(counts.timelines >= 10, `${key} appears in only ${counts.timelines} timelines`);
    }
    assert.ok(checkedByB >= 50, `only ${checkedByB} stretches opened clear with a live baseline`);
    assert.ok(checkedByD >= 50, `only ${checkedByD} stretches opened on a hold`);
  });

  it('(a) creates at most one row per type inside a continuously active stretch', () => {
    check(atMostOneRowPerTypeInAStretch);
  });

  it('(b) a stretch opening on a live quoted baseline, clear of every earlier window, creates one row per emitted type on its first tick and afterwards at most an explained row after a quiet type', () => {
    check(freshStretchOpensOneRowPerEmittedType);
  });

  it('(c) creates no row on a tick whose baseline is null or lacks the quote, nor on a feed-skipped tick, nor on the tick after a baseline-less tick for a type it emitted', () => {
    check(noRowWithoutALiveQuotedBaseline);
  });

  it('(d) a stretch opening on a null or unquoted baseline creates no row of a type its opening tick emitted, and at most an explained row when the opening tick emitted no explained', () => {
    check(heldOpeningCreatesNoRowOfItsTypes);
  });
});
