// The committed CII fixtures (tests/fixtures/cii/) as a regression snapshot
// and as the proof that the scoring seam reproduces production. See
// docs/methodology/cii-change-brief.md.
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCiiFixture,
  CII_FIXTURE_DIR,
  CII_FIXTURE_SCHEMA,
  ciiScoredVersion,
  expectedFromTable,
  loadCiiFixtures,
  readCiiVersionClaim,
  recordExpectedTable,
  scoreCiiFixture,
  trimCiiRawInputs,
} from '../scripts/lib/cii-fixtures.mts';
import { computeCiiScoreTable } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { TIER1_COUNTRIES } from '../server/worldmonitor/intelligence/v1/_shared.ts';

const FIXTURES = loadCiiFixtures();
const CLAIM = readCiiVersionClaim();
// The version whose table this tree's scorer must reproduce: the in-progress
// next version on an integration branch, else CII_FORMULA_VERSION.
const SCORED = ciiScoredVersion(CLAIM);
const TIER1_NAMES = new Set(Object.values(TIER1_COUNTRIES));

describe('CII fixtures', () => {
  it('cover at least three production captures on at least two days, all in the current schema', () => {
    const files = readdirSync(CII_FIXTURE_DIR).filter((name) => name.endsWith('.json'));
    assert.equal(FIXTURES.length, files.length, 'every fixture file must use the current schema');
    assert.ok(new Set(FIXTURES.map((f) => f.capturedAt)).size >= 3, 'need three distinct captures');
    assert.ok(new Set(FIXTURES.map((f) => f.capturedAt.slice(0, 10))).size >= 2, 'need captures from two days');
    for (const f of FIXTURES) {
      assert.equal(f.schema, CII_FIXTURE_SCHEMA);
      assert.ok(files.includes(`${f.label}.json`), `${f.label} must be stored as ${f.label}.json`);
    }
  });

  it('stay small: under 1 MB in total', () => {
    const bytes = readdirSync(CII_FIXTURE_DIR).reduce((sum, name) => sum + statSync(join(CII_FIXTURE_DIR, name)).size, 0);
    assert.ok(bytes < 1024 * 1024, `fixtures total ${bytes} bytes`);
  });

  it('are already trimmed, and keep no strike-feed text or headline other than a country name', () => {
    for (const f of FIXTURES) {
      assert.deepEqual(trimCiiRawInputs(f.inputs), f.inputs, `${f.label} holds untrimmed inputs`);
      for (const event of (f.inputs.iranEvents as { events?: object[] } | null)?.events ?? []) {
        assert.deepEqual(Object.keys(event).sort(), ['countryCode', 'severity', 'timestamp'], `${f.label} strike event keeps extra fields`);
      }
      for (const story of (f.inputs.newsInsights as { topStories?: Array<{ primaryTitle: string }> } | null)?.topStories ?? []) {
        assert.ok(story.primaryTitle === '' || TIER1_NAMES.has(story.primaryTitle), `${f.label} keeps a headline`);
      }
    }
  });

  it(`reproduce the recorded ${SCORED} table on every fixture`, () => {
    for (const f of FIXTURES) {
      const expected = f.expected[SCORED];
      assert.ok(expected, `${f.label} has no ${SCORED} table; record one with scripts/cii-table-diff.mts --write-expected`);
      assert.deepEqual(expectedFromTable(scoreCiiFixture(f)), expected,
        SCORED === CII_FORMULA_VERSION
          ? `${f.label}: scores moved without a CII_FORMULA_VERSION bump`
          : `${f.label}: the ${SCORED} table is out of date; regenerate it with scripts/cii-table-diff.mts --write-expected`);
    }
  });

  it('keep the table production stored as provenance: it equals the recorded table of its own version, 31/31', () => {
    const captured = FIXTURES.filter((f) => f.production);
    assert.ok(captured.filter((f) => f.production!.methodologyVersion === 'v14').length >= 2, 'v14 has two production captures');
    for (const f of captured) {
      const { methodologyVersion, scores } = f.production!;
      const recorded = f.expected[methodologyVersion];
      assert.ok(recorded, `${f.label}: no ${methodologyVersion} table to compare ${f.production!.key} with`);
      assert.equal(Object.keys(scores).length, 31);
      assert.deepEqual(Object.fromEntries(Object.entries(recorded).map(([code, row]) => [code, row.combinedScore])), scores,
        `${f.label}: the recorded ${methodologyVersion} table disagrees with ${f.production!.key}`);
    }
  });

  it('reproduce the table production stored, 31/31, wherever it was captured', {
    skip: CLAIM.inProgress === true
      ? `cii-next.json marks ${CLAIM.next} in progress on ${CLAIM.branch}: this tree scores ${CLAIM.next}, not the ${CII_FORMULA_VERSION} production stored (provenance is checked above); runs again once ${CLAIM.next} ships and is captured`
      : false,
  }, () => {
    const proofs = FIXTURES.filter((f) => f.production?.methodologyVersion === CII_FORMULA_VERSION);
    if (CII_FORMULA_VERSION === 'v14') assert.ok(proofs.length >= 2, 'v14 has two production captures');
    for (const f of proofs) {
      const scores = Object.fromEntries(scoreCiiFixture(f).scores.map((s) => [s.region, s.combinedScore]));
      assert.equal(Object.keys(scores).length, 31);
      assert.deepEqual(scores, f.production!.scores, `${f.label}: the seam disagrees with ${f.production!.key}`);
    }
  });

  it('never overwrite a released version\'s table; only the in-progress next version is regenerated', () => {
    const fixture = structuredClone(FIXTURES.at(-1)!);
    const v14 = structuredClone(fixture.expected.v14!);
    const moved = structuredClone(v14);
    moved.US = { ...moved.US!, combinedScore: moved.US!.combinedScore + 1 };
    const released = { next: 'v15', claimedBy: 'test', claimedAt: '2026-10-23T00:00:00Z' };
    const inProgress = { ...released, inProgress: true, branch: 'cii-v15' };

    assert.throws(() => recordExpectedTable(fixture, moved, released, 'v14'), /v14 is released/);
    assert.equal(recordExpectedTable(fixture, v14, released, 'v14'), false, 'an identical table is a no-op');
    assert.deepEqual(fixture.expected.v14, v14);

    assert.equal(ciiScoredVersion(inProgress, 'v14'), 'v15');
    assert.equal(recordExpectedTable(fixture, moved, inProgress, 'v14'), true);
    assert.equal(recordExpectedTable(fixture, v14, inProgress, 'v14'), true, 'the in-progress table may be overwritten');
    assert.deepEqual(fixture.expected.v15, v14);
    assert.deepEqual(fixture.expected.v14, v14, 'writing the in-progress table leaves v14 untouched');
  });

  it('refuse an in-progress claim that names the released version, so it can never make that table writable', () => {
    const fixture = structuredClone(FIXTURES.at(-1)!);
    const v14 = structuredClone(fixture.expected.v14!);
    const moved = structuredClone(v14);
    moved.US = { ...moved.US!, combinedScore: moved.US!.combinedScore + 1 };
    const selfClaim = { next: 'v14', claimedBy: 'test', claimedAt: '2026-10-23T00:00:00Z', inProgress: true, branch: 'cii-v15' };

    assert.throws(() => ciiScoredVersion(selfClaim, 'v14'), /names the released v14/);
    assert.throws(() => recordExpectedTable(fixture, moved, selfClaim, 'v14'), /names the released v14/);
    assert.deepEqual(fixture.expected.v14, v14, 'v14 stays untouched');
  });

  it('refuse a capture on an integration branch, whose scorer is not the released one', {
    skip: CLAIM.inProgress === true ? false : 'no version is in progress',
  }, () => {
    const f = FIXTURES.at(-1)!;
    assert.throws(() => buildCiiFixture(f.inputs, {
      label: 'x', capturedAt: f.capturedAt, nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled, notes: [], production: null,
    }), /capture fixtures from a released checkout/);
  });
});

describe('CII scoring seam', () => {
  it('reads no clock: Date.now is never called', () => {
    const f = FIXTURES.at(-1)!;
    const realNow = Date.now;
    Date.now = () => { throw new Error('the seam read the clock'); };
    try {
      computeCiiScoreTable(f.inputs, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled });
    } finally {
      Date.now = realNow;
    }
  });

  it('is deterministic and reports every term behind each score', () => {
    const f = FIXTURES.at(-1)!;
    const a = computeCiiScoreTable(f.inputs, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled });
    const b = computeCiiScoreTable(f.inputs, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled });
    assert.deepEqual(a.rows, b.rows);
    assert.deepEqual(a.rows.map((r) => r.region), a.scores.map((s) => s.region));
    for (const row of a.rows) {
      const sum = row.baseline * 0.4 + row.eventScore * 0.6 + Object.values(row.boosts).reduce((s, x) => s + x, 0);
      assert.ok(Math.abs(sum - row.blended) < 1e-9, `${row.region}: the boosts do not sum to the blend`);
      assert.equal(row.combinedScore, Math.min(100, Math.max(row.floor, Math.round(row.blended))));
      assert.equal(row.floor, Math.max(...Object.values(row.floors)));
      assert.equal(row.bindingFloors.length > 0, row.floor > Math.round(row.blended));
    }
  });

  it('takes IRAN_EVENTS_ENABLED as a parameter: off ignores the strike feed and its tally', () => {
    const f = FIXTURES.at(-1)!;
    const off = computeCiiScoreTable(f.inputs, { nowMs: f.nowMs, iranEventsEnabled: false });
    const stripped = computeCiiScoreTable({ ...f.inputs, iranEvents: null, strikePressure: null }, { nowMs: f.nowMs, iranEventsEnabled: true });
    assert.deepEqual(off.rows, stripped.rows);
    assert.equal(off.aux.inputReads?.iranEvents, 'not_configured');
  });
});

// CII v15 B3. The fixtures hold the relay's output, so they cannot show a
// change in how the relay counts strikes. This case runs posts with the v14
// feed's defects through the relay, the fixture trim and the scorer, on the
// latest fixture's other inputs.
describe('strike feed through the relay and the trimmed fixture path', () => {
  const require = createRequire(import.meta.url);
  const strikes = require('../scripts/lib/middle-east-strikes.cjs');
  const f = FIXTURES.at(-1)!;
  const now = f.nowMs;
  const MIN = 60_000;
  const posts: Array<[string, string, number, Record<string, unknown>]> = [
    // [channel, text, minutes before now, classification]
    ['wfwitness', 'Drone strike hits King Fahd International Airport in Dammam, one killed', 200, { place: 'Dammam', severity: 'critical' }],
    ['Alsaa_plus_EN', 'Saudi aviation authority confirms the attack on King Fahd airport, one dead', 165, { place: 'King Fahd International Airport', when: 'update', severity: 'critical' }],
    ['VahidOnline', 'Report: King Fahd International Airport in Dammam was targeted in an attack', 114, { place: 'King Fahd International Airport, Dammam', severity: 'critical' }],
    ['wfwitness', 'Leaked images show the damage at Prince Sultan Air Base after the missile strikes', 90, { place: 'Prince Sultan Air Base', severity: 'critical' }],
    ['OSINTdefender', 'Video of a missile hitting a US base in Saudi Arabia during the summer war', 80, { place: 'Prince Sultan Air Base', when: 'past', severity: 'critical' }],
    ['SaudiDCD', 'Air defences intercepted a drone over Riyadh', 70, { place: 'Riyadh', kind: 'intercept', severity: 'elevated' }],
    ['wfwitness', 'A tanker was struck by a projectile off Jizan, crew safe', 60, { place: 'Jizan', atSea: true, severity: 'elevated' }],
    ['wfwitness', 'Two tankers exploded after hitting naval mines in the Strait of Hormuz', 50, { place: 'Strait of Hormuz', countryIso2: 'IR', severity: 'critical' }],
  ];
  const items = posts.map(([channel, text, minutes], i) => ({
    id: `${channel.toLowerCase()}:${9000 + i}`, channel: channel.toLowerCase(), url: `https://t.me/${channel}/${9000 + i}`,
    ts: new Date(now - minutes * MIN).toISOString(), text,
  }));
  const classify = async (texts: string[]) => texts.map((t, i) => {
    const [, , , c] = posts.find(([, text]) => t.endsWith(text))!;
    return { i, isStrike: true, kind: 'strike', when: 'new', atSea: false, countryIso2: 'SA', ...c };
  });
  const relay = async (subset: typeof items) => {
    const cycle = await strikes.runStrikeCycle({
      now, telegramItems: subset, readCache: async () => null, writeCache: async () => {}, classify, telegramPolledAt: now,
    });
    return { iranEvents: cycle.payload, strikePressure: strikes.mergeStrikePressure(null, cycle.payload.events, now) };
  };
  // GDELT's own strike counter is left out so the feed alone sets strike pressure.
  const score = (feed: Record<string, unknown>) => {
    const raw = { ...f.inputs, gdeltCountryEvents: null, ...feed };
    const trimmed = trimCiiRawInputs(raw as any);
    const table = computeCiiScoreTable(trimmed, { nowMs: now, iranEventsEnabled: true });
    assert.deepEqual(table.rows, computeCiiScoreTable(raw as any, { nowMs: now, iranEventsEnabled: true }).rows, 'the trim changes no score');
    return Object.fromEntries(table.rows.map((r) => [r.region, r]));
  };

  it('scores the v14 defects as one airport strike: no repost, interception, ship or duplicate counts', async () => {
    const all = score(await relay(items));
    const one = score(await relay(items.slice(0, 1)));
    for (const code of Object.keys(one)) assert.deepEqual(all[code], one[code], code);
    assert.ok(one.SA.strikePressure > 0, 'the airport strike itself still counts');
    assert.equal(one.IR.strikePressure, 0, 'Iran, the actor in the Strait of Hormuz, is not struck');
    // The same posts as the v14 feed published them, one event each on the
    // country it named: Saudi Arabia and Iran score far higher.
    const v14Events = posts.map(([, , minutes, c], i) => ({
      id: `v14:${i}`, timestamp: now - minutes * MIN, severity: c.severity, countryCode: c.countryIso2 ?? 'SA', category: 'airstrike',
    }));
    const v14 = score({ iranEvents: { events: v14Events }, strikePressure: null });
    assert.ok(v14.SA.strikePressure > 4 * one.SA.strikePressure, `${v14.SA.strikePressure} vs ${one.SA.strikePressure}`);
    assert.ok(v14.IR.strikePressure > 0);
  });
});
