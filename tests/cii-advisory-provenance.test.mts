// Travel-advisory provenance in the CII. Until v15 a failed advisory read
// swapped the live US/Australian levels for an embedded table that disagreed
// with them (CU, LB, RU, IR, IQ) and had no entry for KP, QA, AE or SA. On
// 2026-10-21 between 15:00 and 16:50 UTC production served that table: QA
// 50→8, AE 50→16, KP 60→38, RU 72→54, with no alarm. The rule now: a missing
// or stale advisory read is unknown. The last good live snapshot stands in
// while it is younger than CII_ADVISORY_MAX_AGE_MS; past that the advisory
// terms are absent. Health names the input either way.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { loadCiiFixtures, trimCiiRawInputs } from '../scripts/lib/cii-fixtures.mts';
import * as riskScores from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import type { CiiRawInputs, CiiScoreTable } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import * as riskConfig from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { assessCiiInputs } from '../api/_cii-input-health.js';
import { ADVISORY_LEVEL_REGISTERS } from '../scripts/shared/advisory-registers.mjs';
import {
  ADVISORY_FEEDS,
  advisoryAfterPublish,
  advisoryPublishTransform,
  fetchAll,
} from '../scripts/seed-security-advisories.mjs';

// Namespace imports so each case reports on its own against a scorer that
// predates the snapshot path.
const { assessCiiInputAvailability, ciiAdvisoryLastGoodSnapshot, ciiInputDetails, computeCiiScoreTable, withCiiInputQuietClocks, CII_ADVISORY_DROPPED_RETENTION_MS } = riskScores;
const { CII_ADVISORY_MAX_AGE_MS } = riskConfig;
const FIXTURES = loadCiiFixtures();
const HOUR_MS = 60 * 60 * 1000;

function table(f: (typeof FIXTURES)[number], inputs: CiiRawInputs): CiiScoreTable {
  return computeCiiScoreTable(inputs, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled });
}
const liveLevels = (f: (typeof FIXTURES)[number]) => (f.inputs.advisories as { byCountry: Record<string, string> }).byCountry;
const disclosure = (t: CiiScoreTable) => Object.fromEntries(t.scores.map((s) => [s.region, `${s.advisoryLevel}/${s.advisoryProvenance}`]));
const combined = (t: CiiScoreTable) => Object.fromEntries(t.scores.map((s) => [s.region, s.combinedScore]));
/** The live payload as the build would have kept it, with the producer clock. */
const snapshot = (f: (typeof FIXTURES)[number], ageMs: number) => ({ byCountry: liveLevels(f), fetchedAt: f.nowMs - ageMs });

describe('CII advisory provenance', () => {
  it('fixtures carry live advisory levels to test against', () => {
    assert.ok(FIXTURES.length >= 3);
    for (const f of FIXTURES) assert.ok(Object.keys(liveLevels(f)).length >= 25, f.label);
  });

  it('a failed read with no snapshot scores no advisory level: every term is absent, none comes from a table', () => {
    for (const f of FIXTURES) {
      const t = table(f, { ...f.inputs, advisories: null });
      const used = t.scores.filter((s) => s.advisoryLevel !== '' || s.advisoryProvenance !== 'absent');
      assert.deepEqual(used.map((s) => `${s.region}=${s.advisoryLevel}/${s.advisoryProvenance}`), [], f.label);
      for (const row of t.rows) {
        assert.equal(row.boosts.advisory, 0, `${f.label} ${row.region} advisory boost`);
        assert.equal(row.floors.advisory, 0, `${f.label} ${row.region} advisory floor`);
      }
    }
  });

  it('a live map without a country leaves that country absent instead of filling it from a table', () => {
    for (const f of FIXTURES) {
      const byCountry = { ...liveLevels(f) };
      for (const code of ['UA', 'LB', 'CU']) delete byCountry[code];
      const d = disclosure(table(f, { ...f.inputs, advisories: { byCountry } }));
      for (const code of ['UA', 'LB', 'CU']) assert.equal(d[code], '/absent', `${f.label} ${code}`);
      assert.equal(d.QA, `${liveLevels(f).QA}/live`, `${f.label} QA keeps its live level`);
    }
  });

  it('a failed read with a snapshot inside the maximum age scores exactly the live table, disclosed as fallback', () => {
    for (const f of FIXTURES) {
      const live = table(f, f.inputs);
      const failed = table(f, { ...f.inputs, advisories: null, advisoriesLastGood: snapshot(f, 2 * HOUR_MS) });
      assert.deepEqual(combined(failed), combined(live), `${f.label}: a failed read must not move any country`);
      for (const s of failed.scores) {
        const level = liveLevels(f)[s.region];
        const scored = level === 'do-not-travel' || level === 'reconsider' || level === 'caution';
        assert.equal(`${s.advisoryLevel}/${s.advisoryProvenance}`, scored ? `${level}/fallback` : '/absent', `${f.label} ${s.region}`);
      }
    }
  });

  it('a snapshot past the maximum age is unknown, not used', () => {
    for (const f of FIXTURES) {
      const t = table(f, { ...f.inputs, advisories: null, advisoriesLastGood: snapshot(f, CII_ADVISORY_MAX_AGE_MS + 1) });
      assert.ok(t.scores.every((s) => s.advisoryProvenance === 'absent'), f.label);
      assert.equal(assessCiiInputAvailability([], t.aux, f.nowMs, false).advisories, 'missing');
    }
  });

  it('a snapshot without a producer clock, or with a future one, is not used', () => {
    const f = FIXTURES[0]!;
    for (const lastGood of [{ byCountry: liveLevels(f) }, { byCountry: liveLevels(f), fetchedAt: f.nowMs + HOUR_MS }]) {
      const t = table(f, { ...f.inputs, advisories: null, advisoriesLastGood: lastGood });
      assert.ok(t.scores.every((s) => s.advisoryProvenance === 'absent'), JSON.stringify(lastGood).slice(-40));
    }
  });

  it('a live read past the maximum age is unusable; the snapshot stands in only if it is younger', () => {
    const f = FIXTURES[0]!;
    const staleLive = { byCountry: liveLevels(f), fetchedAt: new Date(f.nowMs - CII_ADVISORY_MAX_AGE_MS - HOUR_MS).toISOString() };
    const alone = table(f, { ...f.inputs, advisories: staleLive });
    assert.ok(alone.scores.every((s) => s.advisoryProvenance === 'absent'));
    assert.equal(assessCiiInputAvailability([], alone.aux, f.nowMs, false).advisories, 'unusable');
    const withSnapshot = table(f, { ...f.inputs, advisories: staleLive, advisoriesLastGood: snapshot(f, HOUR_MS) });
    assert.ok(withSnapshot.scores.some((s) => s.advisoryProvenance === 'fallback'));
  });

  it('a fresh live read wins over any snapshot', () => {
    const f = FIXTURES[0]!;
    const other = { byCountry: { ...liveLevels(f), QA: 'do-not-travel' }, fetchedAt: f.nowMs - HOUR_MS };
    const t = table(f, { ...f.inputs, advisoriesLastGood: other });
    assert.equal(disclosure(t).QA, `${liveLevels(f).QA}/live`);
  });

  it('trimming a fixture keeps the producer clock the age gate reads', () => {
    const f = FIXTURES[0]!;
    const fetchedAt = new Date(f.nowMs - HOUR_MS).toISOString();
    const items = [
      { title: 'Qatar - Level 3', link: 'https://x.invalid', sourceCountry: 'US', country: 'QA', level: 'reconsider' },
      { title: 'Japan - Level 1', link: 'https://x.invalid', sourceCountry: 'US', country: 'JP', level: 'normal' },
      { title: 'Embassy alert', link: 'https://x.invalid', sourceCountry: 'US', country: 'UA', level: 'info' },
      { title: 'Qatar', link: 'https://x.invalid', sourceCountry: 'AU', country: 'QA', level: 'caution' },
    ];
    const trimmed = trimCiiRawInputs({ advisories: { byCountry: liveLevels(f), fetchedAt, advisories: items } });
    assert.deepEqual(Object.keys(trimmed.advisories as object).sort(), ['advisories', 'byCountry', 'fetchedAt']);
    assert.equal((trimmed.advisories as { fetchedAt: string }).fetchedAt, fetchedAt);
    // One level-bearing item per source keeps which level sources were present, and nothing else.
    assert.deepEqual((trimmed.advisories as { advisories: unknown[] }).advisories, [
      { sourceCountry: 'US', country: 'JP', level: 'normal' },
      { sourceCountry: 'AU', country: 'QA', level: 'caution' },
    ]);
    const auOnly = { ...f.inputs, advisories: { byCountry: liveLevels(f), advisories: items.filter((i) => i.sourceCountry === 'AU') } };
    const full = table(f, auOnly).aux.advisories?.sourcesMissing;
    const trimmedInputs = trimCiiRawInputs(auOnly);
    assert.deepEqual(table(f, trimmedInputs).aux.advisories?.sourcesMissing, full);
    assert.deepEqual(full, ['US']);
  });
});

describe('CII advisory provenance alarm', () => {
  function verdict(f: (typeof FIXTURES)[number], inputs: CiiRawInputs) {
    const t = table(f, inputs);
    const states = assessCiiInputAvailability([], t.aux, f.nowMs, false);
    const reports = withCiiInputQuietClocks(states, null, f.nowMs, { details: ciiInputDetails(t.aux) });
    return { states, reports, health: assessCiiInputs({ inputs: reports }, f.nowMs + 10 * 60_000) };
  }
  const advisoryAlarm = (v: ReturnType<typeof verdict>) => v.health.dead.find((d: { id: string }) => d.id === 'advisories');

  it('a live read raises no advisory alarm', () => {
    for (const f of FIXTURES) assert.equal(advisoryAlarm(verdict(f, f.inputs)), undefined, f.label);
  });

  it('a flip to the snapshot is an alarm that carries the snapshot age', () => {
    for (const f of FIXTURES) {
      const v = verdict(f, { ...f.inputs, advisories: null, advisoriesLastGood: snapshot(f, 2 * HOUR_MS) });
      assert.equal(v.states.advisories, 'fallback', f.label);
      assert.equal(v.reports.advisories.snapshotAt, f.nowMs - 2 * HOUR_MS, f.label);
      assert.deepEqual(advisoryAlarm(v), { id: 'advisories', state: 'fallback', ageMin: 130, filled: Object.keys(liveLevels(f)).sort() }, f.label);
    }
  });

  it('a flip to unknown is an alarm', () => {
    for (const f of FIXTURES) {
      assert.deepEqual(advisoryAlarm(verdict(f, { ...f.inputs, advisories: null })), { id: 'advisories', state: 'missing' }, f.label);
    }
  });

  it('no score is ever disclosed as fallback without the alarm', () => {
    for (const f of FIXTURES) {
      const cases: CiiRawInputs[] = [
        f.inputs,
        { ...f.inputs, advisories: { byCountry: { QA: 'reconsider' } } },
        { ...f.inputs, advisories: null },
        { ...f.inputs, advisories: null, advisoriesLastGood: snapshot(f, HOUR_MS) },
      ];
      for (const inputs of cases) {
        const t = table(f, inputs);
        const v = verdict(f, inputs);
        if (t.scores.some((s) => s.advisoryProvenance === 'fallback')) assert.ok(advisoryAlarm(v), `${f.label}: fallback without an alarm`);
      }
    }
  });
});

// A partial feed loss: the US register fails while Smartraveller is up (or the
// reverse). The read still clears the seeder's coverage bound and is live, so
// every Tier-1 country the surviving source does not list used to go absent
// with no alarm (QA −37 in P8a). The countries a fresh snapshot still lists are
// filled from it, disclosed as fallback, and the input alarms.
describe('CII advisory partial feed loss', () => {
  const LOST = ['LB', 'QA', 'UA'];
  const partial = (f: (typeof FIXTURES)[number]) => {
    const byCountry = { ...liveLevels(f) };
    for (const code of LOST) delete byCountry[code];
    return byCountry;
  };
  function verdict(f: (typeof FIXTURES)[number], inputs: CiiRawInputs) {
    const t = table(f, inputs);
    const states = assessCiiInputAvailability([], t.aux, f.nowMs, false);
    const reports = withCiiInputQuietClocks(states, null, f.nowMs, { details: ciiInputDetails(t.aux) });
    const health = assessCiiInputs({ inputs: reports }, f.nowMs);
    return { t, states, reports, alarm: health.dead.find((d: { id: string }) => d.id === 'advisories') };
  }

  it('a live map that lost Tier-1 countries is filled from a fresh snapshot and alarms', () => {
    for (const f of FIXTURES) {
      const v = verdict(f, { ...f.inputs, advisories: { byCountry: partial(f) }, advisoriesLastGood: snapshot(f, HOUR_MS) });
      assert.deepEqual(combined(v.t), combined(table(f, f.inputs)), `${f.label}: the lost countries keep their scores`);
      const d = disclosure(v.t);
      for (const code of LOST) assert.equal(d[code], `${liveLevels(f)[code]}/fallback`, `${f.label} ${code}`);
      assert.equal(d.IR, `${liveLevels(f).IR}/live`, `${f.label} IR stays live`);
      assert.equal(v.states.advisories, 'fallback', f.label);
      assert.deepEqual(v.alarm, { id: 'advisories', state: 'fallback', ageMin: 60, filled: LOST }, f.label);
    }
  });

  it('a lost country is not filled from an expired snapshot: it is absent', () => {
    const f = FIXTURES[0]!;
    const v = verdict(f, { ...f.inputs, advisories: { byCountry: partial(f) }, advisoriesLastGood: snapshot(f, CII_ADVISORY_MAX_AGE_MS + 1) });
    for (const code of LOST) assert.equal(disclosure(v.t)[code], '/absent', code);
  });

  // The snapshot is refreshed by every live read and carries each country's
  // last live sighting (`seenAt`). A country the feed stopped listing is filled
  // while its sighting is younger than the maximum age, then reads absent and
  // is reported as dropped, so it neither scores a stale level nor vanishes.
  it('a country the live feed stopped listing more than the maximum age ago is absent and reported as dropped', () => {
    for (const f of FIXTURES) {
      const byCountry = { ...liveLevels(f) };
      delete byCountry.LB;
      delete byCountry.QA;
      const seenAt = { ...Object.fromEntries(Object.keys(liveLevels(f)).map((code) => [code, f.nowMs - HOUR_MS])),
        LB: f.nowMs - CII_ADVISORY_MAX_AGE_MS - HOUR_MS, QA: f.nowMs - CII_ADVISORY_MAX_AGE_MS + HOUR_MS };
      const v = verdict(f, { ...f.inputs, advisories: { byCountry }, advisoriesLastGood: { byCountry: liveLevels(f), fetchedAt: f.nowMs - HOUR_MS, seenAt } });
      const d = disclosure(v.t);
      assert.equal(d.LB, '/absent', `${f.label}: LB last seen past the maximum age`);
      assert.equal(d.QA, `${liveLevels(f).QA}/fallback`, `${f.label}: QA last seen inside it`);
      assert.deepEqual(v.reports.advisories.droppedCountries, ['LB'], f.label);
      assert.deepEqual(v.alarm, {
        id: 'advisories', state: 'fallback', ageMin: Math.floor((CII_ADVISORY_MAX_AGE_MS - HOUR_MS) / 60_000), filled: ['QA'], droppedCountries: ['LB'],
      }, f.label);
    }
  });

  it('a country dropped at the source, with nothing filled, is a warning rather than an alarm', () => {
    const f = FIXTURES[0]!;
    const byCountry = { ...liveLevels(f) };
    delete byCountry.LB;
    const seenAt = { LB: f.nowMs - CII_ADVISORY_MAX_AGE_MS - HOUR_MS };
    const v = verdict(f, { ...f.inputs, advisories: { byCountry }, advisoriesLastGood: { byCountry: liveLevels(f), fetchedAt: f.nowMs - HOUR_MS, seenAt } });
    assert.equal(v.states.advisories, 'live');
    assert.equal(v.alarm, undefined);
    const health = assessCiiInputs({ inputs: v.reports }, f.nowMs);
    assert.deepEqual(health.warnings, [{ id: 'advisories', state: 'live', droppedCountries: ['LB'] }]);
  });

  it('the next snapshot keeps a lost country at its last sighting and refreshes the rest', () => {
    const f = FIXTURES[0]!;
    const byCountry = { ...liveLevels(f) };
    delete byCountry.QA;
    const old = { byCountry: liveLevels(f), fetchedAt: f.nowMs - 2 * HOUR_MS, seenAt: { QA: f.nowMs - 5 * HOUR_MS } };
    const fetchedAt = new Date(f.nowMs - 10 * 60_000).toISOString();
    const t = table(f, { ...f.inputs, advisories: { byCountry, fetchedAt }, advisoriesLastGood: old });
    const next = ciiAdvisoryLastGoodSnapshot(t.aux, f.nowMs)!;
    assert.equal(next.fetchedAt, Date.parse(fetchedAt));
    assert.equal(next.byCountry.QA, liveLevels(f).QA, 'the lost country is carried');
    assert.equal(next.seenAt.QA, f.nowMs - 5 * HOUR_MS, 'at its last live sighting, not this read');
    assert.equal(next.seenAt.IR, Date.parse(fetchedAt), 'a listed country is seen at this read');
    // Carried for the reporting window, then purged.
    const stale = { ...old, seenAt: { QA: f.nowMs - CII_ADVISORY_DROPPED_RETENTION_MS - 1 } };
    const purged = ciiAdvisoryLastGoodSnapshot(table(f, { ...f.inputs, advisories: { byCountry, fetchedAt }, advisoriesLastGood: stale }).aux, f.nowMs)!;
    assert.equal(Object.hasOwn(purged.byCountry, 'QA'), false);
  });

  it('a level source missing from the live read is reported and alarms', () => {
    const f = FIXTURES[0]!;
    // The seeder's stored list: only the level-issuing feeds (us, au parsers) carry a level other than info.
    const items = (sources: string[]) => [
      ...sources.map((sourceCountry) => ({ sourceCountry, country: 'QA', level: 'caution', title: 't', source: sourceCountry })),
      { sourceCountry: 'US', country: 'UA', level: 'info', title: 'embassy alert', source: 'US Embassy Ukraine' },
    ];
    const both = verdict(f, { ...f.inputs, advisories: { byCountry: liveLevels(f), advisories: items(['US', 'AU']) } });
    assert.equal(both.alarm, undefined);
    const auOnly = verdict(f, { ...f.inputs, advisories: { byCountry: liveLevels(f), advisories: items(['AU']) } });
    assert.deepEqual(auOnly.reports.advisories.sourcesMissing, ['US']);
    assert.deepEqual(auOnly.alarm, { id: 'advisories', state: 'live', sourcesMissing: ['US'] });
  });

  it('a payload without its item list cannot say which source failed, and claims nothing', () => {
    const f = FIXTURES[0]!;
    const v = verdict(f, f.inputs);
    assert.equal(v.reports.advisories.sourcesMissing, undefined);
    assert.equal(v.alarm, undefined);
  });

  it('the registers the scorer expects are the seeder feeds that parse a level', () => {
    const parsing = [...new Set((ADVISORY_FEEDS as Array<{ levelParser?: string; sourceCountry: string }>)
      .filter((feed) => feed.levelParser).map((feed) => feed.sourceCountry))].sort();
    assert.deepEqual([...ADVISORY_LEVEL_REGISTERS], parsing);
  });

  it('a failed snapshot read is unavailable, not a failed build, and health records it', () => {
    const f = FIXTURES[0]!;
    const live = verdict(f, { ...f.inputs, advisoriesLastGoodReadFailed: true });
    assert.equal(live.states.advisories, 'live');
    assert.equal(live.reports.advisories.snapshotReadFailed, true);
    assert.equal(live.alarm, undefined, 'live levels still score; the read failure is recorded, not alarmed');
    const missing = verdict(f, { ...f.inputs, advisories: null, advisoriesLastGoodReadFailed: true });
    assert.ok(missing.t.scores.every((s) => s.advisoryProvenance === 'absent'));
    assert.deepEqual(missing.alarm, { id: 'advisories', state: 'missing', snapshotReadFailed: true });
  });
});

describe('withCiiInputQuietClocks options', () => {
  const f = FIXTURES[0]!;
  const t = table(f, { ...f.inputs, advisories: null, advisoriesLastGood: snapshot(f, HOUR_MS) });
  const states = assessCiiInputAvailability([], t.aux, f.nowMs, false);

  it('takes its details as a named option', () => {
    const reports = withCiiInputQuietClocks(states, null, f.nowMs, { details: ciiInputDetails(t.aux) });
    assert.equal(reports.advisories.snapshotAt, f.nowMs - HOUR_MS);
  });

  it('throws when an object is passed in the old positional slot, instead of misreading it', () => {
    // Tests run without type checking: a details map, or any other branch's
    // positional argument (an exclusion list), must not be read as options.
    assert.throws(() => withCiiInputQuietClocks(states, null, f.nowMs, ciiInputDetails(t.aux) as never), /unknown option\(s\) advisories/);
    assert.throws(() => withCiiInputQuietClocks(states, null, f.nowMs, ['fires'] as never), /unknown option/);
    assert.throws(() => withCiiInputQuietClocks(states, null, f.nowMs, { details: {}, exclusions: {} } as never), /unknown option\(s\) exclusions/);
  });
});

// One definition of a missing register. The seeder writes `failedSources` to
// its seed-meta (#9596); the scorer derives `sourcesMissing` from the payload
// that seeder run stored. Both use scripts/shared/advisory-registers.mjs, and
// these runs of the real seeder pipeline prove they agree.
describe('advisory register loss: seeder failedSources and scorer sourcesMissing agree', () => {
  const STATE_DEPT = ADVISORY_FEEDS.find((feed: { name: string }) => feed.name === 'US State Dept');
  const SMARTRAVELLER = ADVISORY_FEEDS.find((feed: { name: string }) => feed.name === 'Australia DFAT Smartraveller');
  const CDC = ADVISORY_FEEDS.find((feed: { name: string }) => feed.name === 'CDC Travel Notices');
  const SMARTRAVELLER_RSS = readFileSync(new URL('./fixtures/smartraveller-advisories-2026-10-23.rss', import.meta.url), 'utf8');
  const COUNTRY_NAMES = Object.keys(JSON.parse(readFileSync(new URL('../scripts/shared/country-names.json', import.meta.url), 'utf8')));
  const STATE_DEPT_RSS = `<rss><channel>${COUNTRY_NAMES.slice(0, 400).map((name, i) => (
    `<item><title>${name} - Level ${(i % 4) + 1}: Advisory</title><link>https://travel.state.gov/${i}</link><pubDate>Mon, 20 Oct 2026 00:00:00 GMT</pubDate></item>`
  )).join('')}</channel></rss>`;
  const respond = (body: string, status = 200) => async () => new Response(body, { status });
  const routed = (routes: Record<string, () => Promise<Response>>) => async (proxyUrl: string) => {
    const handler = routes[new URL(proxyUrl).searchParams.get('url') ?? ''];
    return handler ? handler() : new Response('', { status: 404 });
  };

  async function both(routes: Record<string, () => Promise<Response>>) {
    const report = await fetchAll({ feeds: [STATE_DEPT, SMARTRAVELLER, CDC], doFetch: routed(routes) });
    const { freshnessMetaPatch } = await advisoryAfterPublish(report);
    const stored = advisoryPublishTransform(report);
    const f = FIXTURES[0]!;
    const nowMs = Date.parse(stored.fetchedAt) + 60_000;
    const t = computeCiiScoreTable({ ...f.inputs, advisories: stored }, { nowMs, iranEventsEnabled: f.iranEventsEnabled });
    // The fixture trim keeps what the scorer needs to say the same thing.
    const trimmed = trimCiiRawInputs({ advisories: stored }).advisories;
    const fromTrim = computeCiiScoreTable({ ...f.inputs, advisories: trimmed }, { nowMs, iranEventsEnabled: f.iranEventsEnabled });
    return {
      failedSources: freshnessMetaPatch.failedSources ?? [],
      sourcesMissing: t.aux.advisories?.sourcesMissing ?? [],
      fromTrim: fromTrim.aux.advisories?.sourcesMissing ?? [],
    };
  }

  it('Smartraveller down (HTTP 503): both say AU', async () => {
    const r = await both({ [STATE_DEPT.url]: respond(STATE_DEPT_RSS), [SMARTRAVELLER.url]: respond('{"error":"Feed in backoff"}', 503) });
    assert.deepEqual(r.failedSources, ['AU']);
    assert.deepEqual(r.sourcesMissing, r.failedSources);
    assert.deepEqual(r.fromTrim, r.failedSources);
  });

  it('Smartraveller up but unlevelled: both say AU', async () => {
    const unlevelled = SMARTRAVELLER_RSS.replace(/<ta:warnings>[\s\S]*?<\/ta:warnings>/g, '')
      .replace(/<description>[\s\S]*?<\/description>/g, '<description>See the website.</description>');
    const r = await both({ [STATE_DEPT.url]: respond(STATE_DEPT_RSS), [SMARTRAVELLER.url]: respond(unlevelled) });
    assert.deepEqual(r.failedSources, ['AU']);
    assert.deepEqual(r.sourcesMissing, r.failedSources);
    assert.deepEqual(r.fromTrim, r.failedSources);
  });

  it('both registers up: neither names a source', async () => {
    const r = await both({ [STATE_DEPT.url]: respond(STATE_DEPT_RSS), [SMARTRAVELLER.url]: respond(SMARTRAVELLER_RSS) });
    assert.deepEqual(r, { failedSources: [], sourcesMissing: [], fromTrim: [] });
  });
});
