import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CPI_VECTOR_ID,
  LFS_UNEMPLOYMENT_VECTOR_ID,
  STATCAN_WDS_HOST,
  STATCAN_MAX_CONTENT_AGE_MIN,
  WDS_VECTORS_URL,
  buildStatcanPayload,
  changedCubeListUrl,
  computeCpiYoy,
  declareStatcanRecords,
  fetchApprovedWdsJson,
  fetchChangedCubeListBestEffort,
  fetchStatcanWds,
  isFutureStatcanDate,
  isUnreleasedStatcanProductError,
  parseChangedCubeList,
  parseVectorSeries,
  shiftIsoDate,
  statcanCacheKey,
  statcanContentMeta,
  torontoDateIso,
  utcDateIso,
  validateStatcanPayload,
  CPI_PRODUCT_ID,
  LFS_PRODUCT_ID,
} from '../scripts/lib/statcan-wds.mjs';
import { DAY_MIN } from '../scripts/_content-age-helpers.mjs';
import { __testing__ as healthTesting } from '../api/health.js';

const here = dirname(fileURLToPath(import.meta.url));
const changedDoc = JSON.parse(readFileSync(resolve(here, 'fixtures/statcan-wds/changed-cube-list.json'), 'utf8'));
const emptyDoc = JSON.parse(readFileSync(resolve(here, 'fixtures/statcan-wds/changed-cube-list-empty.json'), 'utf8'));
const vectorDoc = JSON.parse(readFileSync(resolve(here, 'fixtures/statcan-wds/cpi-lfs-vectors.json'), 'utf8'));
const libSrc = readFileSync(resolve(here, '../scripts/lib/statcan-wds.mjs'), 'utf8');
const seederSrc = readFileSync(resolve(here, '../scripts/seed-statcan-wds.mjs'), 'utf8');
const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');

const DAY_MS = 24 * 60 * 60 * 1000;

function inclusiveUtcDateDays(startDate, endTimestamp) {
  const endDate = typeof endTimestamp === 'string' ? endTimestamp.slice(0, 10) : '';
  assert.match(startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/);
  const elapsedMs = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  assert.equal(elapsedMs % DAY_MS, 0);
  return elapsedMs / DAY_MS + 1;
}

test('UTC date path is required in the change-list URL and cache key', () => {
  assert.equal(utcDateIso(Date.parse('2026-08-13T21:49:00Z')), '2026-08-13');
  const url = changedCubeListUrl('2026-08-13');
  assert.equal(url, 'https://www150.statcan.gc.ca/t1/wds/rest/getChangedCubeList/2026-08-13');
  assert.ok(statcanCacheKey(url).includes('2026-08-13'));
  assert.ok(statcanCacheKey(url).includes('/getChangedCubeList/2026-08-13'));
});

test('empty WDS change-list is valid quiet, not an error', () => {
  const cubes = parseChangedCubeList(emptyDoc);
  assert.deepEqual(cubes, []);
  const payload = buildStatcanPayload({
    asOfDate: '2026-08-13',
    changedCubes: cubes,
    cpiSeries: parseVectorSeries(vectorDoc, CPI_VECTOR_ID),
    lfsSeries: parseVectorSeries(vectorDoc, LFS_UNEMPLOYMENT_VECTOR_ID),
    seededAtMs: Date.parse('2026-08-13T21:00:00Z'),
  });
  assert.equal(payload.changedCount, 0);
  assert.equal(validateStatcanPayload(payload), true);
});

test('captured change-list and CPI/LFS vectors feed the resilience CA series', () => {
  const cubes = parseChangedCubeList(changedDoc);
  assert.ok(cubes.length >= 1);
  assert.equal(cubes[0].productId, 33100036);

  const cpi = parseVectorSeries(vectorDoc, CPI_VECTOR_ID);
  const yoy = computeCpiYoy(cpi.points);
  assert.equal(yoy.refPer, '2026-06-01');
  assert.equal(Number(yoy.inflationPct.toFixed(2)), 2.8);

  const lfs = parseVectorSeries(vectorDoc, LFS_UNEMPLOYMENT_VECTOR_ID);
  const payload = buildStatcanPayload({
    asOfDate: '2026-08-13',
    changedCubes: cubes,
    cpiSeries: cpi,
    lfsSeries: lfs,
    seededAtMs: Date.parse('2026-08-13T21:00:00Z'),
  });
  assert.equal(payload.unemploymentPct, 6.4);
  assert.equal(payload.unemploymentRefPer, '2026-07-01');
  assert.equal(payload.inflationRefPer, '2026-06-01');
  assert.equal(validateStatcanPayload(payload), true);
  assert.ok(declareStatcanRecords(payload) >= 2);
});

test('allowlist rejects a non-WDS host, errors on redirects, and sends Chrome UA', async () => {
  const url = changedCubeListUrl('2026-08-13');
  await assert.rejects(
    fetchApprovedWdsJson('https://example.com/t1/wds/rest/getChangedCubeList/2026-08-13'),
    /UNTRUSTED_SOURCE_HOST/,
  );

  let init;
  const cache = new Map();
  const doc = await fetchApprovedWdsJson(url, {
    fetchFn: async (_url, options) => {
      init = options;
      return new Response(JSON.stringify(emptyDoc), { headers: { 'content-type': 'application/json' } });
    },
    cache,
  });
  assert.equal(init.redirect, 'error');
  assert.match(init.headers['User-Agent'], /Chrome/);
  assert.equal(doc.status, 'SUCCESS');
  assert.ok(cache.has(statcanCacheKey(url)));
  assert.equal(STATCAN_WDS_HOST, 'www150.statcan.gc.ca');
  assert.match(WDS_VECTORS_URL, /www150\.statcan\.gc\.ca/);
});

test('America/Toronto date is used for the change-list, not the UTC calendar date', () => {
  // 02:00Z on 2026-08-14 is still 22:00 the previous evening in Toronto (EDT).
  const earlyUtc = Date.parse('2026-08-14T02:00:00Z');
  assert.equal(utcDateIso(earlyUtc), '2026-08-14');
  assert.equal(torontoDateIso(earlyUtc), '2026-08-13');
  assert.equal(isFutureStatcanDate('2026-08-14', earlyUtc), true);
  assert.equal(isFutureStatcanDate('2026-08-13', earlyUtc), false);
  assert.equal(shiftIsoDate('2026-08-14', -1), '2026-08-13');
});

test('404 or future-date change-list is quiet and still POSTs CPI/LFS vectors', async () => {
  const requested = [];
  const nowMs = Date.parse('2026-08-14T12:00:00Z'); // Toronto 08:00 on 2026-08-14
  assert.equal(torontoDateIso(nowMs), '2026-08-14');

  const future = await fetchChangedCubeListBestEffort({
    dateIso: '2026-08-15',
    nowMs,
    fetchFn: async () => {
      throw new Error('future-date must not hit the network');
    },
  });
  assert.deepEqual(future, { cubes: [], reason: 'future-date' });

  const payload = await fetchStatcanWds({
    nowMs,
    fetchFn: async (url, options) => {
      requested.push({ url, method: options?.method || 'GET' });
      if (String(url).includes('/getChangedCubeList/2026-08-14')) {
        return new Response('Not Found', { status: 404 });
      }
      if (String(url).includes('/getChangedCubeList/2026-08-13')) {
        return new Response(JSON.stringify(emptyDoc), { headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('getDataFromVectorsAndLatestNPeriods')) {
        assert.equal(options?.method, 'POST');
        return new Response(JSON.stringify(vectorDoc), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  assert.ok(requested.some((row) => row.url.includes('/getChangedCubeList/2026-08-14') && row.method === 'GET'));
  assert.ok(requested.some((row) => row.url.includes('getDataFromVectorsAndLatestNPeriods') && row.method === 'POST'));
  assert.equal(payload.asOfDate, '2026-08-14');
  assert.equal(payload.changedCount, 0);
  assert.equal(validateStatcanPayload(payload), true);
  assert.equal(payload.inflationRefPer, '2026-06-01');
  assert.equal(payload.unemploymentPct, 6.4);
});

test('Toronto-today 409 not-released-yet is quiet, falls back to yesterday, and still POSTs vectors', async () => {
  // Live probe 2026-08-14 05:20Z: getChangedCubeList/2026-08-14 → 409
  // {"message":"The product is not released yet"}. Cron 0 8 * * * is 08:00 UTC
  // = 04:00 ET, before StatCan ~08:30 ET, so Toronto-today IS today and
  // isFutureStatcanDate is false. A rethrown 409 used to abort Promise.all
  // and drop the vector POST.
  const requested = [];
  const nowMs = Date.parse('2026-08-14T08:00:00Z');
  assert.equal(torontoDateIso(nowMs), '2026-08-14');
  assert.equal(isFutureStatcanDate('2026-08-14', nowMs), false);

  const quiet = await fetchChangedCubeListBestEffort({
    dateIso: '2026-08-14',
    nowMs,
    fetchFn: async () => new Response(
      JSON.stringify({ message: 'The product is not released yet' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ),
  });
  assert.deepEqual(quiet, { cubes: [], reason: '409-unreleased' });
  assert.equal(
    isUnreleasedStatcanProductError({ status: 409, body: '{"message":"The product is not released yet"}' }),
    true,
  );
  // Do not rethrow 409 even when the body-read misses the live phrase.
  assert.equal(isUnreleasedStatcanProductError({ status: 409, message: 'HTTP_409' }), true);
  assert.equal(isUnreleasedStatcanProductError({ message: 'The product is not released yet' }), true);
  const bare409 = await fetchChangedCubeListBestEffort({
    dateIso: '2026-08-14',
    nowMs,
    fetchFn: async () => new Response('', { status: 409 }),
  });
  assert.deepEqual(bare409, { cubes: [], reason: '409-unreleased' });

  const payload = await fetchStatcanWds({
    nowMs,
    fetchFn: async (url, options) => {
      requested.push({ url, method: options?.method || 'GET' });
      if (String(url).includes('/getChangedCubeList/2026-08-14')) {
        return new Response(
          JSON.stringify({ message: 'The product is not released yet' }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(url).includes('/getChangedCubeList/2026-08-13')) {
        return new Response(JSON.stringify(changedDoc), { headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('getDataFromVectorsAndLatestNPeriods')) {
        assert.equal(options?.method, 'POST');
        return new Response(JSON.stringify(vectorDoc), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  assert.ok(requested.some((row) => row.url.includes('/getChangedCubeList/2026-08-14') && row.method === 'GET'));
  assert.ok(requested.some((row) => row.url.includes('/getChangedCubeList/2026-08-13') && row.method === 'GET'));
  assert.ok(requested.some((row) => row.url.includes('getDataFromVectorsAndLatestNPeriods') && row.method === 'POST'));
  assert.equal(payload.asOfDate, '2026-08-14');
  assert.equal(payload.changedCount, parseChangedCubeList(changedDoc).length);
  assert.ok(payload.changedCount >= 1);
  assert.equal(validateStatcanPayload(payload), true);
  assert.equal(payload.inflationRefPer, '2026-06-01');
  assert.equal(payload.unemploymentPct, 6.4);
});

test('tests import the lib, not the seeder main; neither binds fetch', () => {
  assert.doesNotMatch(testSrc, /from ['"][^'"]*seed-statcan-wds/);
  assert.doesNotMatch(libSrc, /fetch\.bind/);
  assert.doesNotMatch(seederSrc, /fetch\.bind/);
  assert.doesNotMatch(libSrc, /fetch\.bind\(globalThis\)/);
  assert.match(seederSrc, /from '\.\/lib\/statcan-wds\.mjs'/);
});

test('unrelated StatCan cubes do not mask stale CPI/LFS freshness', () => {
  const nowMs = Date.parse('2026-08-14T12:00:00Z');
  const unrelatedToday = parseChangedCubeList(changedDoc);
  assert.ok(unrelatedToday.length >= 1);
  assert.ok(unrelatedToday.every((row) => row.productId !== CPI_PRODUCT_ID && row.productId !== LFS_PRODUCT_ID));

  const payload = buildStatcanPayload({
    asOfDate: '2026-08-14',
    changedCubes: unrelatedToday,
    cpiSeries: parseVectorSeries(vectorDoc, CPI_VECTOR_ID),
    lfsSeries: parseVectorSeries(vectorDoc, LFS_UNEMPLOYMENT_VECTOR_ID),
    seededAtMs: nowMs,
  });
  const meta = statcanContentMeta(payload, nowMs);
  assert.ok(meta, 'CPI/LFS series must still produce content-age');
  assert.deepEqual(meta, {
    newestItemAt: Date.parse('2026-06-01T00:00:00Z'),
    oldestItemAt: Date.parse('2026-06-01T00:00:00Z'),
  });
  assert.equal(declareStatcanRecords(payload), 2, 'unrelated cubes must not pad the CPI/LFS record floor');

  const withCpiCube = statcanContentMeta({
    ...payload,
    changedCubes: [
      ...unrelatedToday,
      { productId: CPI_PRODUCT_ID, releaseTime: '2026-08-14T08:30' },
    ],
  }, nowMs);
  assert.deepEqual(withCpiCube, meta, 'even a CPI release-radar hit must not refresh its older observation');
});

test('StatCan content age uses the older required CPI/LFS reference period in both stale permutations', () => {
  const nowMs = Date.parse('2026-08-14T12:00:00Z');
  const cases = [
    {
      name: 'fresh CPI with stale LFS',
      inflationRefPer: '2026-08-01',
      unemploymentRefPer: '2025-01-01',
      expected: '2025-01-01T00:00:00Z',
    },
    {
      name: 'stale CPI with fresh LFS',
      inflationRefPer: '2025-02-01',
      unemploymentRefPer: '2026-08-01',
      expected: '2025-02-01T00:00:00Z',
    },
  ];

  for (const fixture of cases) {
    assert.deepEqual(
      statcanContentMeta({
        inflationRefPer: fixture.inflationRefPer,
        unemploymentRefPer: fixture.unemploymentRefPer,
        inflationReleaseTime: '2026-08-14T08:30',
        unemploymentReleaseTime: '2026-08-14T08:30',
      }, nowMs),
      {
        newestItemAt: Date.parse(fixture.expected),
        oldestItemAt: Date.parse(fixture.expected),
      },
      fixture.name,
    );
  }
});

test('StatCan content age fails closed when either required reference period is absent, malformed, or future-dated', () => {
  const nowMs = Date.parse('2026-08-14T12:00:00Z');
  const invalidRequiredRefPers = [
    undefined,
    null,
    '',
    'not-a-date',
    '2026-02-30',
    '2026-08-01T00:00',
    '2027-01-01',
  ];

  for (const invalid of invalidRequiredRefPers) {
    assert.equal(
      statcanContentMeta({ inflationRefPer: invalid, unemploymentRefPer: '2026-07-01' }, nowMs),
      null,
      `invalid CPI refPer ${JSON.stringify(invalid)} must fail closed`,
    );
    assert.equal(
      statcanContentMeta({ inflationRefPer: '2026-07-01', unemploymentRefPer: invalid }, nowMs),
      null,
      `invalid LFS refPer ${JSON.stringify(invalid)} must fail closed`,
    );
  }

  const nearMidnightMs = Date.parse('2026-08-14T23:30:00Z');
  assert.equal(
    statcanContentMeta({ inflationRefPer: '2026-08-15', unemploymentRefPer: '2026-08-01' }, nearMidnightMs),
    null,
    'a next-day observation inside the shared one-hour skew window must still fail closed for StatCan',
  );
});

test('StatCan scored freshness is invariant across UTC, Toronto, and Dubai process timezones', () => {
  const moduleUrl = new URL('../scripts/lib/statcan-wds.mjs', import.meta.url).href;
  const script = `
    import { statcanContentMeta } from ${JSON.stringify(moduleUrl)};
    const meta = statcanContentMeta({
      inflationRefPer: '2026-06-01',
      unemploymentRefPer: '2026-07-01',
      inflationReleaseTime: '2026-08-14T08:30',
      unemploymentReleaseTime: '2026-08-07T08:30',
      changedCubes: [{ productId: ${CPI_PRODUCT_ID}, releaseTime: '2026-08-14T08:30' }],
    }, Date.parse('2026-08-14T12:00:00Z'));
    process.stdout.write(JSON.stringify(meta));
  `;
  const results = ['UTC', 'America/Toronto', 'Asia/Dubai'].map((TZ) => JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { encoding: 'utf8', env: { ...process.env, TZ } },
  )));

  assert.deepEqual(results, [
    { newestItemAt: Date.parse('2026-06-01T00:00:00Z'), oldestItemAt: Date.parse('2026-06-01T00:00:00Z') },
    { newestItemAt: Date.parse('2026-06-01T00:00:00Z'), oldestItemAt: Date.parse('2026-06-01T00:00:00Z') },
    { newestItemAt: Date.parse('2026-06-01T00:00:00Z'), oldestItemAt: Date.parse('2026-06-01T00:00:00Z') },
  ]);
});

test('the StatCan and BoC EMPTY waivers are retired with independent issue ownership', () => {
  // Was: pinned both waivers' exact anchors, to prove they used the real 08:00
  // UTC tick rather than a mistaken 13:00 one. Both probes now publish, so the
  // monitor reports them as "no longer reported; remove it" and #6799 pruned
  // them. A waiver that outlives its problem is a suppression with nothing to
  // suppress, and would silently absorb the next real outage.
  //
  // What still has to hold: neither is re-suppressed, and the 08:00 cron the
  // anchors were derived from is still documented — the wrong-tick bug is only
  // avoidable while the runbook says what the tick actually is.
  const baseline = JSON.parse(readFileSync(resolve(here, '../scripts/seed-freshness-baseline.json'), 'utf8'));
  const healthSrc = readFileSync(resolve(here, '../api/health.js'), 'utf8');
  const runbook = readFileSync(resolve(here, '../docs/railway-seed-consolidation-runbook.md'), 'utf8');

  for (const name of ['statcanWds', 'bocValet']) {
    assert.equal(
      baseline.acknowledged.some((row) => row.name === name),
      false,
      `${name} publishes again; do not suppress a future recurrence`,
    );
  }

  assert.match(seederSrc, /Issue #6676\./, 'the StatCan seeder must point to its own tracking issue');
  assert.doesNotMatch(seederSrc, /Issue #6616\./, 'the StatCan seeder must not point to the BoC issue');
  assert.equal(
    healthTesting.SEED_META.statcanWds.cutover?.issue,
    6676,
    'the StatCan health cutover must point to its own tracking issue',
  );

  // The 13:00 anchor was never a real cron. Keep it out of every surface.
  assert.doesNotMatch(healthSrc, /2026-08-16T13:00/);
  for (const row of baseline.acknowledged) {
    assert.doesNotMatch(row.expiresAt ?? '', /T13:00/, `${row.name} must not anchor on a 13:00 tick`);
    assert.doesNotMatch(row.reason ?? '', /13:00/, `${row.name} must not cite a 13:00 tick`);
  }
  assert.match(runbook, /0 8 \* \* \*[^\n]*daily 08:00 UTC/);
});

test('STATCAN_MAX_CONTENT_AGE_MIN clears retained healthy cycles, catches a missed release, and is wired into the seeder', () => {
  // WDS refPer is the FIRST of the reference month, so a monthly series' newest
  // observation start-dates a month before the data exists. Content age
  // therefore sawtooths, and the budget must clear the PEAK of that tooth, not
  // its average.
  //
  // Derive both policy bounds from retained release history. A healthy cycle
  // peaks at `next release - held refPer + 1`; a one-release miss recovers at
  // `release after next - held refPer + 1`. The +1 accounts for the 08:00 UTC
  // seed preceding StatCan's 08:30 ET release, which makes the new observation
  // visible on the following day's tick. See docs/solutions/logic-errors/
  // a-guard-that-hardcodes-an-external-services-latency-goes-green-when-that-latency-drifts.md
  //
  // Unlike its two siblings in #6831 — China (tests/china-macro-production-
  // registration.test.mts) and CISS (tests/ciss-stale-threshold-consistency
  // .test.mjs) both pin their budgets — nothing else asserts this value or its
  // wiring. The generic seeder-content-age-coverage net skips StatCan because
  // www150.statcan.gc.ca is not one of its FREEZE_PRONE_MARKER hosts, so a
  // wrong value or a dropped maxContentAgeMin wiring would ship unnoticed.
  const cpiPoints = parseVectorSeries(vectorDoc, CPI_VECTOR_ID).points;
  const healthyCyclePeaks = cpiPoints.slice(0, -1).map((point, index) => (
    inclusiveUtcDateDays(point.refPer, cpiPoints[index + 1].releaseTime)
  ));
  const missedReleasePeaks = cpiPoints.slice(0, -2).map((point, index) => (
    inclusiveUtcDateDays(point.refPer, cpiPoints[index + 2].releaseTime)
  ));
  const measuredHealthyPeakDays = Math.max(...healthyCyclePeaks);
  const measuredMissedReleasePeakDays = Math.min(...missedReleasePeaks);

  assert.equal(cpiPoints.length, 15, 'the retained CPI fixture must cover 15 reference periods');
  assert.equal(healthyCyclePeaks.length, 14, 'the fixture must measure 14 healthy cycles');
  assert.equal(missedReleasePeaks.length, 13, 'the fixture must measure 13 one-release misses');
  assert.equal(measuredHealthyPeakDays, 85, 'the retained healthy-cycle maximum must remain explicit');
  assert.equal(measuredMissedReleasePeakDays, 106, 'the earliest one-release-miss peak must remain explicit');
  assert.equal(STATCAN_MAX_CONTENT_AGE_MIN, 90 * DAY_MIN);
  assert.ok(
    STATCAN_MAX_CONTENT_AGE_MIN > measuredHealthyPeakDays * DAY_MIN,
    `budget must exceed the measured ${measuredHealthyPeakDays}-day healthy-cycle peak, or it alarms on a current series`,
  );
  assert.ok(
    STATCAN_MAX_CONTENT_AGE_MIN < measuredMissedReleasePeakDays * DAY_MIN,
    'budget must stay under a missed-release peak, or a genuine StatCan stall goes undetected',
  );
  assert.match(
    seederSrc,
    /maxContentAgeMin:\s*STATCAN_MAX_CONTENT_AGE_MIN/,
    'seed-statcan-wds.mjs must wire the content-age budget from the shared constant',
  );
});
