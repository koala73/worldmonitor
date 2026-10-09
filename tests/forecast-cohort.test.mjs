import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  COHORT_CLASSES,
  RESOLVER_CYCLE_MS,
  cohortSla,
  formatReconciliationMarkdown,
  freezeCohort,
  hashCohortManifest,
  reconcileCohort,
} from '../scripts/_forecast-cohort.mjs';
import { parseArgs, writeManifestFile } from '../scripts/forecast-cohort.mjs';
import { DEFAULT_JUDGED_SLA_MS, JUDGED_EVIDENCE_GRACE_MS, hardSlaMs } from '../scripts/_forecast-scorecard.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const T0 = Date.parse('2026-10-08T00:00:00Z');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function hardForecast(id, generatedAt, overrides = {}) {
  const deadline = overrides.deadline ?? generatedAt + 7 * DAY_MS;
  return {
    id,
    domain: 'market',
    region: 'Middle East',
    title: `${id} oil`,
    probability: 0.4,
    generationOrigin: 'legacy_detector',
    generatedAt,
    resolution: {
      kind: 'hard',
      metricKey: 'market:commodities-bootstrap:v1|price(symbol==CL=F)',
      operator: 'crosses',
      threshold: 80,
      baselineValue: 70,
      window: 'within-horizon',
      deadline,
      sourceFeed: 'market:commodities-bootstrap:v1',
    },
    ...overrides,
  };
}

function judgedForecast(id, generatedAt, overrides = {}) {
  const deadline = overrides.deadline ?? generatedAt + 7 * DAY_MS;
  return {
    id,
    domain: 'military',
    region: 'Syria',
    title: `${id} strikes`,
    probability: 0.3,
    generationOrigin: 'legacy_detector',
    generatedAt,
    resolution: { kind: 'judged', question: `Did ${id} happen?`, deadline },
    ...overrides,
  };
}

// A published forecast with a scored 24h projection contract.
function horizonForecast(id, generatedAt, h24Deadline) {
  return hardForecast(id, generatedAt, {
    projections: { h24: 0.4, d7: null, d30: null },
    horizonResolutions: {
      h24: {
        horizon: 'h24',
        timeHorizon: '24h',
        kind: 'hard',
        metricKey: 'market:commodities-bootstrap:v1|price(symbol==CL=F)',
        operator: 'crosses',
        threshold: 80,
        window: 'at-deadline',
        deadline: h24Deadline,
        sourceFeed: 'market:commodities-bootstrap:v1',
      },
    },
  });
}

const snapshot = (generatedAt, predictions, extra = {}) => ({ generatedAt, predictions, ...extra });
const envelope = (data, fetchedAt) => ({ _seed: { fetchedAt, recordCount: Object.keys(data).length }, data });
const betsHistory = [snapshot(T0 - DAY_MS, [])];

// A ledger the resolver wrote at T0 + 2h holding the window opened before the
// cohort and the first cohort window; the later cohort run is not registered.
function fixture() {
  const before = snapshot(T0 - DAY_MS, [hardForecast('fc-old', T0 - DAY_MS)]);
  const first = snapshot(T0 + HOUR_MS, [hardForecast('fc-old', T0 + HOUR_MS), hardForecast('fc-new', T0 + HOUR_MS)]);
  const second = snapshot(T0 + 3 * HOUR_MS, [
    hardForecast('fc-new', T0 + 3 * HOUR_MS),
    judgedForecast('fc-judged', T0 + 3 * HOUR_MS),
    hardForecast('fc-late', T0 + 3 * HOUR_MS, { deadline: T0 + 3.5 * HOUR_MS }),
    { id: 'fc-nospec', generatedAt: T0 + 3 * HOUR_MS, domain: 'market' },
  ], { codeVersion: SHA_B });
  const asEntry = (forecast) => {
    const { resolution, ...rest } = forecast;
    return { ...rest, spec: resolution, deadline: resolution.deadline, firstSeenAt: forecast.generatedAt, lastSeenAt: forecast.generatedAt, status: 'pending' };
  };
  const oldEntry = asEntry(hardForecast('fc-old', T0 - DAY_MS));
  const newEntry = asEntry(hardForecast('fc-new', T0 + HOUR_MS));
  return {
    ledger: envelope({ [`fc-old@${oldEntry.deadline}`]: oldEntry, [`fc-new@${newEntry.deadline}`]: newEntry }, T0 + 2 * HOUR_MS),
    historySnapshots: [second, first, before],
    betsSnapshots: betsHistory,
    traceRuns: [{ generatedAt: T0 + HOUR_MS, triggerContext: { deployRevision: SHA_A } }],
  };
}

function freezeFixture(overrides = {}) {
  return freezeCohort({
    cohortId: 'test-cohort',
    startMs: T0,
    endMs: T0 + 4 * HOUR_MS,
    nowMs: T0 + 4 * HOUR_MS,
    ...fixture(),
    ...overrides,
  });
}

const LATE_KEY = `fc-late@${T0 + 3.5 * HOUR_MS}`;

describe('freezeCohort (#7066)', () => {
  it('freezes the windows opened in the emission range under the keys the resolver gives them', () => {
    const manifest = freezeFixture();
    assert.deepEqual(manifest.entries.map((entry) => entry.key), [
      `fc-judged@${T0 + 3 * HOUR_MS + 7 * DAY_MS}`,
      LATE_KEY,
      `fc-new@${T0 + HOUR_MS + 7 * DAY_MS}`,
    ], 'fc-old opened before the range');
    const byId = Object.fromEntries(manifest.entries.map((entry) => [entry.id, entry]));
    assert.equal(byId['fc-judged'].lane, 'judged');
    assert.equal(byId['fc-new'].lane, 'hard');
    assert.equal(byId['fc-new'].registeredAtFreeze, true);
    assert.equal(byId['fc-judged'].registeredAtFreeze, false, 'projected from history the ledger has not read yet');
    assert.equal(byId['fc-new'].origin, 'legacy_detector');
    assert.equal(byId['fc-new'].domain, 'market');
    assert.equal(byId['fc-new'].publishedOrigin, true);
  });

  it('freezes a window the resolver never opens, whatever the freeze clock', () => {
    const late = freezeFixture().entries.find((entry) => entry.id === 'fc-late');
    assert.deepEqual(
      [late.registeredAtFreeze, late.statusAtFreeze, late.unregisteredReason],
      [false, 'unregistered', 'deadline_passed_before_registration'],
    );
    const early = freezeFixture({ endMs: T0 + 3.2 * HOUR_MS, nowMs: T0 + 3.2 * HOUR_MS }).entries.find((entry) => entry.id === 'fc-late');
    assert.equal(early.key, LATE_KEY, 'frozen before the deadline: the projection opens the same key');
  });

  it('freezes the missing horizon windows of a cohort window', () => {
    const hz = horizonForecast('fc-hz', T0 + 3 * HOUR_MS, T0 + 3.5 * HOUR_MS);
    const { historySnapshots, ...rest } = fixture();
    const manifest = freezeFixture({ ...rest, historySnapshots: [snapshot(T0 + 3 * HOUR_MS, [hz]), ...historySnapshots.slice(1)] });
    const parentKey = `fc-hz@${T0 + 3 * HOUR_MS + 7 * DAY_MS}`;
    const horizon = manifest.entries.find((entry) => entry.key === `${parentKey}@h24`);
    assert.ok(horizon, 'the h24 window is frozen though ingest skips it once its deadline passed');
    assert.deepEqual([horizon.lane, horizon.horizon, horizon.parentKey, horizon.deadline], ['horizon', 'h24', parentKey, T0 + 3.5 * HOUR_MS]);
    assert.equal(horizon.unregisteredReason, 'deadline_passed_before_registration');
  });

  it('records the code version of the run that opened each window', () => {
    const manifest = freezeFixture();
    const byId = Object.fromEntries(manifest.entries.map((entry) => [entry.id, entry]));
    assert.deepEqual([byId['fc-new'].codeVersion, byId['fc-new'].codeVersionSource], [SHA_A, 'trace_run']);
    assert.deepEqual([byId['fc-judged'].codeVersion, byId['fc-judged'].codeVersionSource], [SHA_B, 'history']);
    const { ledger, ...rest } = fixture();
    const stamped = structuredClone(ledger);
    Object.values(stamped.data).forEach((entry) => { entry.codeVersion = 'c'.repeat(40); });
    const fromLedger = freezeFixture({ ...rest, ledger: stamped }).entries.find((entry) => entry.id === 'fc-new');
    assert.deepEqual([fromLedger.codeVersion, fromLedger.codeVersionSource], ['c'.repeat(40), 'ledger']);
    const untraced = freezeFixture({ traceRuns: [] }).entries.find((entry) => entry.id === 'fc-new');
    assert.deepEqual([untraced.codeVersion, untraced.codeVersionSource], ['', 'unknown']);
    const carried = freezeFixture({ traceRuns: [], priorManifest: freezeFixture() }).entries.find((entry) => entry.id === 'fc-new');
    assert.deepEqual([carried.codeVersion, carried.codeVersionSource], [SHA_A, 'prior_manifest']);
  });

  it('accounts for every emission in the range', () => {
    const { emissions } = freezeFixture().counts;
    assert.deepEqual(emissions, {
      total: 6,
      inCohortWindow: 4,
      joinedPreCohortWindow: 1,
      filteredOut: 0,
      skipped: { no_resolution_spec: 1 },
      unregistered: { deadline_passed_before_registration: 1 },
    });
  });

  it('filters by origin and domain, and counts what the filter left out', () => {
    const manifest = freezeFixture({ domains: ['military'] });
    assert.deepEqual(manifest.entries.map((entry) => entry.id), ['fc-judged']);
    assert.equal(manifest.counts.emissions.filteredOut, 3);
    assert.deepEqual(manifest.filters, { origins: null, domains: ['military'] });
    assert.equal(freezeFixture({ origins: ['bet_engine'] }).entries.length, 0);
  });

  it('is deterministic and hashes the whole manifest', () => {
    const a = freezeFixture();
    const b = freezeFixture();
    assert.equal(a.manifestSha256, b.manifestSha256);
    assert.equal(a.manifestSha256, hashCohortManifest(a));
  });

  it('records each entry\'s service level: the row\'s stamp, else its spec', () => {
    const byId = Object.fromEntries(freezeFixture().entries.map((entry) => [entry.id, entry]));
    const spec = hardForecast('fc-new', T0 + HOUR_MS).resolution;
    assert.deepEqual(byId['fc-new'].sla, { lane: 'hard', ms: hardSlaMs(spec), source: 'spec' }, 'the hand-written ledger row carries no stamp');
    assert.deepEqual(byId['fc-judged'].sla, { lane: 'judged', ms: DEFAULT_JUDGED_SLA_MS, source: 'stamp' }, 'ingest stamps the row it opens');
    const settlement = { spec: { kind: 'hard', sourceFeed: 'prediction:markets-resolution:v1' }, sla: { lane: 'hard', ms: 15 * DAY_MS } };
    assert.deepEqual(cohortSla(settlement), { lane: 'hard', ms: 15 * DAY_MS, source: 'stamp' });
    assert.deepEqual(cohortSla({ ...settlement, sla: { lane: 'judged', ms: 1 } }).source, 'spec', 'a stamp from the other lane does not apply');
  });

  it('refuses a window that has not closed or a malformed id', () => {
    assert.throws(() => freezeFixture({ nowMs: T0 + HOUR_MS }), /only after its emission window closes/);
    assert.throws(() => freezeFixture({ cohortId: 'Bad Id' }), /cohortId/);
    assert.throws(() => freezeFixture({ endMs: T0 }), /start < end/);
  });

  it('refuses a trimmed, empty or expired history list', () => {
    const { historySnapshots } = fixture();
    const trimmed = historySnapshots.filter((row) => row.generatedAt >= T0);
    assert.throws(() => freezeFixture({ historySnapshots: trimmed }), /forecast history starts at .* not before the range start/);
    assert.throws(() => freezeFixture({ betsSnapshots: [snapshot(T0 + HOUR_MS, [])] }), /bet history starts at/);
    assert.throws(() => freezeFixture({ historySnapshots: [] }), /forecast history is empty or expired/);
    assert.throws(() => freezeFixture({ betsSnapshots: [] }), /bet history is empty or expired/);
  });
});

function manifestWith(entries) {
  const manifest = { schemaVersion: 3, cohortId: 'test-cohort', window: { start: 'a', end: 'b' }, filters: { origins: null, domains: null }, sla: { perEntry: true }, entries };
  return { ...manifest, manifestSha256: hashCohortManifest(manifest) };
}

const HARD_SLA = { lane: 'hard', ms: 2 * DAY_MS, source: 'stamp' };
const JUDGED_SLA = { lane: 'judged', ms: DEFAULT_JUDGED_SLA_MS, source: 'stamp' };

function frozen(key, overrides = {}) {
  const lane = overrides.lane ?? 'hard';
  return { key, id: key.split('@')[0], origin: 'legacy_detector', publishedOrigin: true, domain: 'market', lane, firstSeenAt: T0, deadline: T0 + DAY_MS, codeVersion: SHA_A, sla: lane === 'judged' ? JUDGED_SLA : HARD_SLA, ...overrides };
}

function row(overrides = {}) {
  return { spec: { kind: 'hard' }, deadline: T0 + DAY_MS, status: 'pending', ...overrides };
}

describe('reconcileCohort (#7066)', () => {
  const NOW = T0 + 10 * DAY_MS;
  const WRITTEN = NOW - 2 * HOUR_MS;
  const hardDue = T0 + DAY_MS + HARD_SLA.ms;
  const judgedDue = T0 + DAY_MS + JUDGED_EVIDENCE_GRACE_MS + DEFAULT_JUDGED_SLA_MS;
  const cases = {
    'a@1': [frozen('a@1', { deadline: NOW + DAY_MS }), row({ deadline: NOW + DAY_MS }), 'immature'],
    'b@1': [frozen('b@1', { deadline: NOW - HOUR_MS }), row({ deadline: NOW - HOUR_MS }), 'pending_in_sla'],
    'c@1': [frozen('c@1'), row(), 'pending_breach'],
    'd@1': [frozen('d@1'), row({ status: 'resolved', outcome: 'YES', resolvedAt: hardDue }), 'terminal_in_sla'],
    'e@1': [frozen('e@1'), row({ status: 'resolved', outcome: 'NO', resolvedAt: hardDue + 1 }), 'terminal_late'],
    'f@1': [frozen('f@1', { lane: 'judged' }), row({ spec: { kind: 'judged' }, status: 'resolved', outcome: 'VOID', evidence: { reason: 'beyond_archive_horizon' }, resolvedAt: judgedDue }), 'terminal_in_sla'],
    'g@1': [frozen('g@1', { lane: 'judged' }), row({ spec: { kind: 'judged' }, status: 'resolved', outcome: 'VOID', evidence: { reason: 'judge_retry_exhausted' }, resolvedAt: judgedDue + 1 }), 'terminal_late'],
    'h@1': [frozen('h@1'), row({ status: 'resolved', outcome: 'YES' }), 'sla_unmeasurable'],
    'i@1': [frozen('i@1', { deadline: NOW + DAY_MS }), null, 'missing_from_ledger'],
    // Emitted just before the ledger write: the resolver may have read history first.
    'j@1': [frozen('j@1', { firstSeenAt: WRITTEN - 60_000, deadline: NOW }), null, 'awaiting_registration'],
    // No ledger write since, but its SLA has ended.
    'k@1': [frozen('k@1', { firstSeenAt: NOW - HOUR_MS }), null, 'missing_from_ledger'],
    // Shadow: counted, but outside the published verdict.
    's@1': [frozen('s@1', { origin: 'bet_engine', publishedOrigin: false }), row(), 'pending_breach'],
  };
  const manifest = manifestWith(Object.values(cases).map(([entry]) => entry));
  const ledgerData = Object.fromEntries(Object.entries(cases).filter(([, [, entry]]) => entry).map(([key, [, entry]]) => [key, entry]));
  const report = reconcileCohort(manifest, envelope(ledgerData, WRITTEN), NOW);

  it('gives every frozen entry exactly one class', () => {
    for (const name of COHORT_CLASSES) {
      const expected = Object.values(cases).filter(([, , cls]) => cls === name).length;
      assert.equal(report.totals[name], expected, name);
    }
    assert.equal(COHORT_CLASSES.reduce((sum, name) => sum + report.totals[name], 0), report.totals.entries);
    assert.equal(report.totals.entries, Object.keys(cases).length);
  });

  it('waits one resolver cycle before calling an unregistered key missing', () => {
    const at = (firstSeenAt) => reconcileCohort(
      manifestWith([frozen('r@1', { firstSeenAt, deadline: NOW + DAY_MS })]), envelope({}, WRITTEN), NOW,
    ).totals;
    assert.equal(at(WRITTEN - 30_000).awaiting_registration, 1, 'pushed after the resolver read history, before it wrote');
    assert.equal(at(WRITTEN - RESOLVER_CYCLE_MS + 1).awaiting_registration, 1);
    assert.equal(at(WRITTEN - RESOLVER_CYCLE_MS).missing_from_ledger, 1);
  });

  it('starts the judged clock after the reporting grace', () => {
    assert.equal(report.byLane.judged.terminal_in_sla, 1);
    assert.equal(report.byLane.judged.terminal_late, 1);
  });

  it('judges the published population and reports shadow windows beside it', () => {
    assert.equal(report.slaVerdict, 'breached');
    assert.equal(report.breachCount, 6);
    assert.equal(report.unpublished.entries, 1);
    assert.equal(report.unpublishedBreachCount, 1);
    assert.equal(report.published.entries + report.unpublished.entries, report.totals.entries);
    const shadowOnly = reconcileCohort(manifestWith([cases['s@1'][0], frozen('d@1')]), envelope({ 's@1': cases['s@1'][1], 'd@1': cases['d@1'][1] }, WRITTEN), NOW);
    assert.equal(shadowOnly.slaVerdict, 'met', 'a shadow breach does not breach the published verdict');
    assert.equal(shadowOnly.unpublishedVerdict, 'breached');
  });

  it('lists each breach by key, published first, and tallies VOIDs by reason', () => {
    assert.deepEqual(report.breaches.map((breach) => [breach.key, breach.class]), [
      ['i@1', 'missing_from_ledger'],
      ['k@1', 'missing_from_ledger'],
      ['c@1', 'pending_breach'],
      ['h@1', 'sla_unmeasurable'],
      ['e@1', 'terminal_late'],
      ['g@1', 'terminal_late'],
      ['s@1', 'pending_breach'],
    ]);
    assert.deepEqual(report.voidByReason, { beyond_archive_horizon: 1, judge_retry_exhausted: 1 });
    assert.equal(report.totals.scored, 3);
    assert.equal(report.totals.void, 2);
    assert.equal(report.totals.matured, 10, 'every row but the 2 with deadlines ahead');
  });

  it('reads met only when every published entry is terminal within the SLA', () => {
    const met = reconcileCohort(manifestWith([frozen('d@1')]), envelope({ 'd@1': cases['d@1'][1] }, NOW), NOW);
    assert.equal(met.slaVerdict, 'met');
    const open = reconcileCohort(manifestWith([frozen('b@1', { deadline: NOW - HOUR_MS })]), envelope({ 'b@1': cases['b@1'][1] }, NOW), NOW);
    assert.equal(open.slaVerdict, 'open');
  });

  it('judges by the moved deadline of a settlement window', () => {
    const moved = reconcileCohort(manifestWith([frozen('m@1')]), envelope({ 'm@1': row({ deadline: NOW + DAY_MS }) }, NOW), NOW);
    assert.equal(moved.totals.immature, 1);
  });

  it('judges each entry by the service level frozen on it', () => {
    const strict = manifestWith([frozen('d@1', { sla: { ...HARD_SLA, ms: DAY_MS } })]);
    assert.equal(reconcileCohort(strict, envelope({ 'd@1': cases['d@1'][1] }, NOW), NOW).totals.terminal_late, 1);
    // A market settles 4 days after its deadline: inside a 15-day settlement level, late under 2 days.
    const settled = row({ status: 'resolved', outcome: 'YES', resolvedAt: T0 + DAY_MS + 4 * DAY_MS });
    const settlement = manifestWith([frozen('m@1', { sla: { lane: 'hard', ms: 15 * DAY_MS, source: 'stamp' } })]);
    assert.equal(reconcileCohort(settlement, envelope({ 'm@1': settled }, NOW), NOW).totals.terminal_in_sla, 1);
  });

  it('refuses a manifest whose entries, SLA, range or filters were edited', () => {
    const ledger = envelope(ledgerData, WRITTEN);
    for (const edit of [
      { entries: manifest.entries.slice(1) },
      { entries: manifest.entries.map((entry, i) => (i ? entry : { ...entry, sla: { ...entry.sla, ms: 1e15 } })) },
      { window: { ...manifest.window, start: 'z' } },
      { filters: { origins: ['bet_engine'], domains: null } },
    ]) {
      assert.throws(() => reconcileCohort({ ...manifest, ...edit }, ledger, NOW), /manifestSha256/, Object.keys(edit)[0]);
    }
  });

  it('renders the report with every class and the breach list', () => {
    const text = formatReconciliationMarkdown(report);
    assert.match(text, /\| Missing from ledger \(breach\) \| 2 \| 0 \|/);
    assert.match(text, /SLA verdict \(published origin\): breached, 6 breaches\. Shadow and synthetic: breached, 1 breaches/);
    assert.match(text, /\| `a{10}` \| 12 \| 10 \| 2 \| 7 \|/, 'the code-version breach column counts the unmeasurable row');
    assert.match(text, /`s@1` \| no \| pending_breach/);
  });
});

describe('forecast-cohort CLI and docs (#7066)', () => {
  it('never replaces a frozen manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cohort-'));
    try {
      const path = join(dir, 'nested', 'c.json');
      writeManifestFile(path, { cohortId: 'c' });
      assert.throws(() => writeManifestFile(path, { cohortId: 'other' }), /never replaced/);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { cohortId: 'c' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses commands and rejects a flag without a value', () => {
    assert.deepEqual(parseArgs(['reconcile', '--manifest', 'x.json', '--json']), { command: 'reconcile', flags: { manifest: 'x.json', json: true } });
    assert.throws(() => parseArgs(['freeze', '--id']), /needs a value/);
  });

  it('documents the cohort rules in both languages', () => {
    assert.equal(RESOLVER_CYCLE_MS, DAY_MS + HOUR_MS, 'the docs say 1 day and 1 hour');
    for (const path of ['docs/panels/forecast.mdx', 'docs/zh/panels/forecast.mdx']) {
      const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      for (const term of ['scripts/forecast-cohort.mjs', 'hardSlaMs', 'slaDueAt', 'RESOLVER_CYCLE_MS', 'missing_from_ledger', 'awaiting_registration', 'data/forecast-cohorts/', '--carry-code-versions', 'manifestSha256']) {
        assert.ok(text.includes(term), `${path} mentions ${term}`);
      }
    }
  });
});
