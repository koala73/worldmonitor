import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';

test('health registers and classifies per-source global tender freshness', () => {
  const { classifyKey, SEED_META, STANDALONE_KEYS, ZERO_RECORD_DATA_OK_KEYS } = __testing__;
  const sources = ['Sam', 'Ted', 'ContractsFinder', 'CanadaBuys', 'Gets', 'WorldBank'];

  for (const source of sources) {
    const name = `globalTenders${source}`;
    assert.match(STANDALONE_KEYS[name], /^economic:global-tenders:v1:source:/);
    assert.match(SEED_META[name].key, /^seed-meta:economic:global-tenders:/);
    assert.ok(ZERO_RECORD_DATA_OK_KEYS.has(name));
  }

  const name = 'globalTendersTed';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const now = Date.parse('2026-07-13T12:00:00Z');
  const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
    keyStrens: new Map([[dataKey, 256]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: now - 60_000,
      recordCount: 12,
      sourceState: 'stale',
      stale: true,
    })]]),
    keyMetaErrors: new Map(),
    now,
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.records, 12);
});

test('SAM health allows the effective paced cadence plus one hourly jitter gate', () => {
  const { classifyKey, SEED_META, STANDALONE_KEYS } = __testing__;
  const name = 'globalTendersSam';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const now = Date.parse('2026-07-22T12:00:00Z');

  assert.equal(SEED_META.globalTendersSam.maxStaleMin, 240);
  for (const source of ['Ted', 'ContractsFinder', 'CanadaBuys', 'Gets', 'WorldBank']) {
    assert.equal(SEED_META[`globalTenders${source}`].maxStaleMin, 180, `${source} keeps the hourly source SLA`);
  }

  const classifyAtAge = (ageMin) => classifyKey(name, dataKey, { allowOnDemand: true }, {
    keyStrens: new Map([[dataKey, 128]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: now - ageMin * 60_000,
      recordCount: 1,
      sourceState: 'ok',
      stale: false,
    })]]),
    keyMetaErrors: new Map(),
    now,
  });

  assert.equal(classifyAtAge(181).status, 'OK', 'normal post-180min scheduler jitter must not false-alarm');
  assert.equal(classifyAtAge(241).status, 'STALE_SEED', 'a genuinely missed paced refresh must still warn');
});

// An adapter the deployment never opted into is not a fault. fetchSam writes
// sourceState:'unavailable' when SAM_GOV_API_KEY is absent — the only place any
// producer emits that state. Grading it identically to a broken source (#5266
// shipped SAM unconfigured, so /api/health warned on every run) means the health
// endpoint can never be clean until an operator obtains a government API key.
test('an unconfigured source adapter is moot, not a health problem', () => {
  const { classifyKey, STATUS_COUNTS, SEED_META, STANDALONE_KEYS, healthResponseBody } = __testing__;
  const name = 'globalTendersSam';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const now = Date.parse('2026-07-13T12:00:00Z');

  const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
    keyStrens: new Map([[dataKey, 128]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: now - 60_000,
      recordCount: 0,
      sourceState: 'unavailable',
      stale: true,
    })]]),
    keyMetaErrors: new Map(),
    now,
  });

  assert.equal(entry.status, 'NOT_CONFIGURED');
  assert.equal(entry.records, 0);
  // STATUS_COUNTS[status] ?? 'warn' — an unregistered status silently buckets to
  // warn, so the mapping must be explicit for the exemption to actually hold.
  assert.equal(STATUS_COUNTS.NOT_CONFIGURED, 'ok');

  // ...and it must drop out of the compact /api/health `problems` map entirely.
  const body = healthResponseBody({
    status: 'HEALTHY',
    checkedAt: new Date(now).toISOString(),
    summary: { total: 1, ok: 1, warn: 0, crit: 0 },
    checks: { [name]: entry },
  }, true);
  assert.equal(body.problems, undefined);
});

// The exemption must hold on EVERY problem surface, not just the compact
// `problems` map. The console failure log and the ?history=1 incident signature
// only run when overall !== 'HEALTHY' — which is precisely the state a real,
// UNRELATED crit puts the fleet in. So a NOT_CONFIGURED key that is correctly
// absent from `problems` can still be reported as a permanent problem in the
// failure log the moment anything else breaks. This mirrors production: a
// defensePatents crit holds the fleet DEGRADED while SAM is unconfigured.
test('NOT_CONFIGURED stays out of the failure log even when the fleet is degraded', () => {
  const { collectFailureLogProblems, healthResponseBody, STATUS_COUNTS } = __testing__;

  const checks = {
    globalTendersSam: { status: 'NOT_CONFIGURED', records: 0, seedAgeMin: 103 },
    defensePatents: { status: 'EMPTY', records: 0 },                 // real crit
    newsRecallBenchmark: { status: 'EMPTY_ON_DEMAND', records: 0 },  // warn-for-visibility only
    seedEarthquakes: { status: 'OK', records: 42 },
  };

  const { problemKeys, sigKeys } = collectFailureLogProblems(checks);

  // The real fault is reported...
  assert.deepEqual(problemKeys, ['defensePatents:EMPTY']);
  // ...and the dedupe signature must not carry SAM either, or every incident
  // signature is permanently salted with a non-problem.
  assert.deepEqual(sigKeys, ['defensePatents:EMPTY']);

  // EMPTY_ON_DEMAND keeps its existing asymmetry: suppressed in the failure log,
  // but still surfaced in the compact problems map (prod reports it there today).
  const body = healthResponseBody({
    status: 'DEGRADED',
    checkedAt: new Date(Date.parse('2026-07-14T00:00:00Z')).toISOString(),
    summary: { total: 4, ok: 2, warn: 1, crit: 1 },
    checks,
  }, true);
  assert.deepEqual(Object.keys(body.problems).sort(), ['defensePatents', 'newsRecallBenchmark']);
  assert.equal(STATUS_COUNTS.EMPTY_ON_DEMAND, 'warn');
});

test('graced stale content stays in compact diagnostics but out of the failure log', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  const checks = {
    temporalAnomalies: {
      status: 'STALE_CONTENT',
      staleContentGraceUntil: new Date(now + 60_000).toISOString(),
    },
    defensePatents: { status: 'EMPTY', records: 0 },
  };

  const { problemKeys, sigKeys } = __testing__.collectFailureLogProblems(checks, now);
  assert.deepEqual(problemKeys, ['defensePatents:EMPTY']);
  assert.deepEqual(sigKeys, ['defensePatents:EMPTY']);

  const body = __testing__.healthResponseBody({
    status: 'DEGRADED',
    checkedAt: new Date(now).toISOString(),
    summary: { total: 2, ok: 1, warn: 0, crit: 1 },
    checks,
  }, true);
  assert.equal(body.pending.temporalAnomalies.status, 'STALE_CONTENT');
  assert.equal(body.problems.temporalAnomalies, undefined);

  const expired = { ...checks, temporalAnomalies: {
    ...checks.temporalAnomalies,
    staleContentGraceUntil: new Date(now).toISOString(),
  } };
  assert.deepEqual(
    __testing__.collectFailureLogProblems(expired, now).sigKeys,
    ['defensePatents:EMPTY', 'temporalAnomalies:STALE_CONTENT'],
  );
});

// Guard the exemption's blast radius: only 'unavailable' (= never configured) is
// exempt. A source that was configured and then broke must still warn.
test('a source that actually failed still reports SEED_ERROR', () => {
  const { classifyKey, SEED_META, STANDALONE_KEYS } = __testing__;
  const name = 'globalTendersSam';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const now = Date.parse('2026-07-13T12:00:00Z');

  for (const sourceState of ['stale', 'error']) {
    const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
      keyStrens: new Map([[dataKey, 128]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify({
        fetchedAt: now - 60_000,
        recordCount: 0,
        sourceState,
        stale: true,
      })]]),
      keyMetaErrors: new Map(),
      now,
    });
    assert.equal(entry.status, 'SEED_ERROR', `sourceState=${sourceState} must still warn`);
  }
});

const CF_NAME = 'globalTendersContractsFinder';
const CF_KEY = 'economic:global-tenders:v1';
const CF_NOW = Date.parse('2026-07-13T06:00:00Z');

async function failedContractsFinder() {
  const { fetchGlobalTenders, sourceStatus } = await import('../scripts/seed-global-tenders.mjs');
  const { normalizeContractsFinderRelease } = await import('../scripts/_global-tenders.mjs');
  const success = CF_NOW - 60 * 60_000;
  const record = normalizeContractsFinderRelease({
    id: 'health-fixture', date: new Date(success).toISOString(),
    tender: { title: 'Network services', status: 'active', tenderPeriod: { endDate: new Date(CF_NOW + 4 * 60 * 60_000).toISOString() } },
  });
  return fetchGlobalTenders({
    now: CF_NOW, previousSnapshot: {
      fetchedAt: success, dataAvailable: true, tenders: [record],
      sourceStatuses: [sourceStatus('contracts-finder', 'ok', [record], '', success)],
    },
    adapters: [['contracts-finder', async () => { throw new Error('The operation was aborted due to timeout'); }]],
  });
}

async function classifyContractsFinder(snapshot, now = CF_NOW, readFailed = false, metaOverride = {}) {
  const seed = await import('../scripts/seed-global-tenders.mjs');
  const meta = { ...seed.sourceHealthMeta(snapshot.sourceStatuses[0]), ...metaOverride };
  const evidence = new Map();
  const dataKey = __testing__.STANDALONE_KEYS[CF_NAME];
  const entry = __testing__.classifyKey(CF_NAME, dataKey, { allowOnDemand: true }, {
    keyStrens: new Map([[dataKey, 256]]), keyErrors: new Map(),
    keyMetaValues: new Map([[__testing__.SEED_META[CF_NAME].key, JSON.stringify(meta)]]),
    keyMetaErrors: new Map(), containmentEvidenceByName: evidence, now,
  });
  const composed = __testing__.composeContractsFinderHealth(entry, meta, snapshot, readFailed, now);
  evidence.set(CF_NAME, composed.evidence);
  return { ...composed, contained: __testing__.isContainedHealthWarning(composed.entry, composed.evidence, now) };
}

async function failedEmptyContractsFinder(previousSnapshot, siblingRecords = []) {
  const { fetchGlobalTenders, fetchContractsFinder, sourceStatus } = await import('../scripts/seed-global-tenders.mjs');
  const success = CF_NOW - 60 * 60_000;
  previousSnapshot ??= await fetchGlobalTenders({ now: success, adapters: [
    ['contracts-finder', () => fetchContractsFinder({ now: success, fetchJsonFn: async () => ({ releases: [] }) })],
  ] });
  return fetchGlobalTenders({ now: CF_NOW, previousSnapshot, adapters: [
    ['contracts-finder', async () => { throw new Error('timeout'); }],
    ['ted', async () => ({ records: siblingRecords, status: sourceStatus('ted', 'ok', siblingRecords, '', CF_NOW) })],
  ] });
}

test('verified empty source survives its first failed refresh with truthful producer-to-health evidence', async () => {
  const snapshot = await failedEmptyContractsFinder();
  const { entry, contained } = await classifyContractsFinder(snapshot);
  assert.equal(contained, true);
  assert.equal(entry.records, 0);
  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.lastSuccessAt, new Date(CF_NOW - 60 * 60_000).toISOString());
  assert.equal(entry.consecutiveSourceFailures, 1);
  assert.match(entry.error, /timeout/);
  assert.equal(entry.containmentUntil, new Date(CF_NOW + 90 * 60_000).toISOString());
  assert.equal((await classifyContractsFinder(snapshot, CF_NOW + 90 * 60_000)).contained, false);
  assert.equal((await classifyContractsFinder(await failedEmptyContractsFinder(snapshot))).contained, false);
  const record = { ...(await failedContractsFinder()).tenders[0], source: 'ted' };
  const populated = await failedEmptyContractsFinder(undefined, [record]);
  assert.equal(populated.tenders.length, 1);
  assert.equal((await classifyContractsFinder(populated)).contained, true);
  populated.tenders[0].countryCode = 123;
  assert.equal((await classifyContractsFinder(populated)).contained, false, 'reader cannot normalize a numeric country');
  const { fetchGlobalTenders, fetchContractsFinder } = await import('../scripts/seed-global-tenders.mjs');
  const recovered = await fetchGlobalTenders({ now: CF_NOW, previousSnapshot: snapshot, adapters: [
    ['contracts-finder', () => fetchContractsFinder({ now: CF_NOW, fetchJsonFn: async () => ({ releases: [] }) })],
  ] });
  assert.equal(recovered.sourceStatuses[0].consecutiveFailures, 0);
  assert.equal(recovered.sourceStatuses[0].confirmedEmpty, undefined);
  assert.equal(recovered.sourceStatuses[0].lastSuccessfulAt, new Date(CF_NOW).toISOString());
  const older = structuredClone(snapshot);
  older.sourceStatuses[0].lastSuccessfulAt = new Date(CF_NOW - 150 * 60_000).toISOString();
  assert.equal((await classifyContractsFinder(older)).entry.containmentUntil, new Date(CF_NOW + 30 * 60_000).toISOString());
  assert.equal((await classifyContractsFinder(older, CF_NOW + 30 * 60_000)).contained, false);
});

test('zero count alone cannot prove a verified empty source or a usable aggregate', async () => {
  const fixture = await failedEmptyContractsFinder();
  for (const [label, mutate] of [
    ['missing empty proof', s => { delete s.sourceStatuses[0].confirmedEmpty; }],
    ['missing success', s => { delete s.sourceStatuses[0].lastSuccessfulAt; }],
    ['missing canonical rows', s => { delete s.tenders; }],
    ['malformed canonical rows', s => { s.tenders = {}; }],
    ['unavailable aggregate', s => { s.dataAvailable = false; }],
    ['unavailable read model', s => { s.availability = 'unavailable'; }],
    ['duplicate source', s => { s.sourceStatuses.push(s.sourceStatuses[0]); }],
    ['malformed aggregate status', s => { s.sourceStatuses.push(null); }],
    ['stale aggregate', s => { s.fetchedAt = CF_NOW - 181 * 60_000; }],
    ['malformed aggregate row', s => { s.tenders = [null]; }],
  ]) {
    const snapshot = structuredClone(fixture);
    mutate(snapshot);
    assert.equal((await classifyContractsFinder(snapshot)).contained, false, label);
  }
  const nonempty = await failedContractsFinder();
  nonempty.tenders = [];
  assert.equal((await classifyContractsFinder(await failedEmptyContractsFinder(nonempty))).contained, false);
  const { fetchGlobalTenders, fetchContractsFinder } = await import('../scripts/seed-global-tenders.mjs');
  const good = await fetchGlobalTenders({ now: CF_NOW - 60 * 60_000, adapters: [
    ['contracts-finder', () => fetchContractsFinder({ now: CF_NOW - 60 * 60_000, fetchJsonFn: async () => ({ releases: [] }) })],
  ] });
  for (const mutate of [s => { delete s.tenders; }, s => { s.dataAvailable = false; },
    s => { s.sourceStatuses.push(s.sourceStatuses[0]); },
    s => { s.sourceStatuses[0].fetchedAt = new Date(CF_NOW).toISOString(); },
    s => { s.sourceStatuses[0].recordCount = 1; }]) {
    const malformed = structuredClone(good);
    mutate(malformed);
    assert.equal((await classifyContractsFinder(await failedEmptyContractsFinder(malformed))).contained, false);
  }
});

test('empty-source containment requires the complete tender reader shape', async () => {
  const record = { ...(await failedContractsFinder()).tenders[0], source: 'ted' };
  const fixture = await failedEmptyContractsFinder(undefined, [record]);
  for (const field of ['sourceNoticeId', 'officialUrl', 'status', 'participationMode',
    'eligibilityRequirements', 'submissionUrls']) {
    const snapshot = structuredClone(fixture);
    delete snapshot.tenders[0][field];
    assert.equal((await classifyContractsFinder(snapshot)).contained, false, `missing ${field}`);
  }
  for (const [label, mutate] of [
    ['matchReasons string', r => { r.automationFit.matchReasons = 'network'; }],
    ['evidence object', r => { r.automationFit.evidence = {}; }],
    ['missing score', r => { delete r.automationFit.score; }],
    ['invalid level', r => { r.automationFit.level = 1; }],
    ['missing version', r => { delete r.automationFit.classificationVersion; }],
    ['null automation', r => { r.automationFit = null; }],
    ['array money', r => { r.money = []; }],
    ['string amount', r => { r.money = { amount: '20' }; }],
    ['null money', r => { r.money = null; }],
    ['invalid eligibility', r => { r.eligibilityRequirements = [1]; }],
  ]) {
    const snapshot = structuredClone(fixture);
    mutate(snapshot.tenders[0]);
    assert.equal((await classifyContractsFinder(snapshot)).contained, false, label);
  }
  delete fixture.tenders[0].automationFit;
  delete fixture.tenders[0].money;
  assert.equal((await classifyContractsFinder(fixture)).contained, true, 'optional nested messages may be absent');
});

test('Contracts Finder producer-to-health retains every diagnostic during bounded first-failure containment', async () => {
  const snapshot = await failedContractsFinder();
  const { entry, contained } = await classifyContractsFinder(snapshot);
  assert.equal(contained, true);
  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.records, 1);
  assert.equal(entry.consecutiveSourceFailures, 1);
  assert.equal(entry.lastSuccessAt, snapshot.sourceStatuses[0].lastSuccessfulAt);
  assert.equal(entry.lastAttemptAt, snapshot.sourceStatuses[0].fetchedAt);
  assert.match(entry.error, /timeout/);
  assert.equal(entry.containmentUntil, new Date(CF_NOW + 90 * 60_000).toISOString());
  const verdict = __testing__.computeOverallStatus({ warn: 1, containedWarn: 1, onDemandWarn: 0, crit: 0 }, 292);
  assert.equal(verdict.overall, 'HEALTHY');
  assert.equal(verdict.realWarnCount, 1);
  const full = { status: verdict.overall, summary: { total: 292, warn: 1, containedWarn: 1 }, checkedAt: new Date(CF_NOW).toISOString(), checks: { [CF_NAME]: entry } };
  const compact = __testing__.healthResponseBody(full, true);
  assert.deepEqual(compact.problems[CF_NAME], entry);
  assert.deepEqual(__testing__.collectFailureLogProblems(full.checks, CF_NOW).sigKeys, [`${CF_NAME}:SEED_ERROR`]);
  const expiry = Date.parse(entry.containmentUntil);
  for (const view of [full, compact]) {
    assert.equal(__testing__.snapshotTtlSeconds(view, expiry - 10_500), 10);
    assert.equal(__testing__.hasExpiredActivationGrace(view, expiry), true);
  }
  assert.equal((await classifyContractsFinder(snapshot, expiry)).contained, false);
});

test('Contracts Finder cannot contain repeated, stale, malformed, mismatched, or unusable evidence', async () => {
  const fixture = await failedContractsFinder();
  const cases = [
    ['second failure', s => { s.sourceStatuses[0].consecutiveFailures = 2; }],
    ['missing failure count', s => { delete s.sourceStatuses[0].consecutiveFailures; }],
    ['missing success', s => { s.sourceStatuses[0].lastSuccessfulAt = ''; }],
    ['future attempt', s => { s.sourceStatuses[0].fetchedAt = new Date(CF_NOW + 60_000).toISOString(); }],
    ['false dataAvailable', s => { s.dataAvailable = false; }],
    ['empty', s => { s.tenders = []; }],
    ['malformed row', s => { s.tenders[0].officialUrl = 'https://example.com'; }],
    ['unreadable categories', s => { s.tenders[0].categoryCodes = null; }],
    ['expired row', s => { s.tenders[0].deadline = new Date(CF_NOW).toISOString(); }],
    ['mismatched count', s => { s.sourceStatuses[0].recordCount = 2; }],
  ];
  for (const [label, mutate] of cases) {
    const snapshot = structuredClone(fixture);
    mutate(snapshot);
    assert.equal((await classifyContractsFinder(snapshot)).contained, false, label);
  }
  assert.equal((await classifyContractsFinder(fixture, CF_NOW, true)).contained, false);
  assert.equal((await classifyContractsFinder(fixture, CF_NOW, false, { fetchedAt: CF_NOW })).contained, false);
  const legacy = await classifyContractsFinder(fixture, CF_NOW, false, {
    error: undefined, lastAttemptAt: undefined, lastSuccessfulAt: undefined, consecutiveFailures: undefined,
  });
  assert.equal(legacy.contained, false);
  assert.equal(legacy.entry.error, fixture.sourceStatuses[0].error, 'legacy warnings retain their canonical source detail');
  const deadline = structuredClone(fixture);
  deadline.tenders[0].deadline = new Date(CF_NOW + 30_000).toISOString();
  assert.equal((await classifyContractsFinder(deadline)).entry.containmentUntil, deadline.tenders[0].deadline);
});

test('Contracts Finder health checks the canonical payload, not the positive source-status count', async (t) => {
  const { default: handler } = await import('../api/health.js');
  const seed = await import('../scripts/seed-global-tenders.mjs');
  const snapshot = await failedContractsFinder();
  const meta = seed.sourceHealthMeta(snapshot.sourceStatuses[0]);
  const realEnv = { ...process.env };
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: 'https://mock-upstash.test', UPSTASH_REDIS_REST_TOKEN: 'mock-token' });
  t.after(() => {
    for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
      if (realEnv[key] === undefined) delete process.env[key]; else process.env[key] = realEnv[key];
    }
  });
  let clock = CF_NOW;
  t.mock.method(Date, 'now', () => clock);
  let canonical = snapshot;
  let canonicalReads = 0;
  let expireDuringWrite = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const commands = JSON.parse(init.body);
    return new Response(JSON.stringify(commands.map(([op, key]) => {
      if (expireDuringWrite && op === 'SET' && key === __testing__.HEALTH_VERDICT_SNAPSHOT_KEY) clock = CF_NOW + 90 * 60_000;
      if (op === 'STRLEN') return { result: key === CF_KEY && canonical === null ? 0 : 256 };
      if (op === 'GET' && key === CF_KEY) { canonicalReads++; return { result: canonical === null ? null : JSON.stringify(canonical) }; }
      if (op === 'GET' && key === __testing__.SEED_META[CF_NAME].key) return { result: JSON.stringify(meta) };
      if (op === 'GET' && key.startsWith('seed-meta:')) return { result: JSON.stringify({ fetchedAt: CF_NOW, recordCount: 1 }) };
      if (op === 'GET') return { result: null };
      if (op === 'LLEN') return { result: 1 };
      return { result: 'OK' };
    })));
  });
  const read = async () => (await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'))).json();
  const initial = await read();
  assert.equal(initial.problems[CF_NAME].containmentUntil, new Date(CF_NOW + 90 * 60_000).toISOString());
  canonical = await failedEmptyContractsFinder();
  Object.assign(meta, seed.sourceHealthMeta(canonical.sourceStatuses[0]));
  const empty = await read();
  assert.equal(empty.problems[CF_NAME].records, 0);
  assert.equal(empty.problems[CF_NAME].status, 'SEED_ERROR');
  assert.equal(empty.problems[CF_NAME].containmentUntil, initial.problems[CF_NAME].containmentUntil);
  assert.equal(empty.summary.containedWarn, initial.summary.containedWarn);
  expireDuringWrite = true;
  const slow = await read();
  assert.equal(slow.summary.containedWarn, initial.summary.containedWarn - 1,
    'a slow snapshot write must not extend the cold response containment');
  expireDuringWrite = false;
  clock = CF_NOW;
  canonical = null;
  const missing = (await read()).problems[CF_NAME];
  assert.equal(missing.status, 'EMPTY');
  assert.equal(missing.records, 0);
  assert.equal(missing.containmentUntil, undefined);
  meta.sourceState = 'ok';
  assert.equal((await read()).problems[CF_NAME].status, 'EMPTY', 'fresh source metadata cannot hide an absent canonical payload');
  canonical = snapshot;
  delete meta.sourceState;
  assert.equal((await read()).problems[CF_NAME].status, 'SEED_ERROR', 'unusable source metadata never reads OK');
  assert.ok(canonicalReads >= 2);
});
