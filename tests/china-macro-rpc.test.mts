import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getChinaMacroSnapshot } from '../server/worldmonitor/economic/v1/get-china-macro-snapshot';
import { normalizeHydratedChina } from '../src/components/macro-tiles-china';
import { parseNbsIndustrialRelease } from '../scripts/china-macro/adapters.mjs';
import {
  buildOfficialChinaMacroFixture,
  CHINA_MACRO_FIXTURE_RETRIEVAL_TIME,
  CHINA_MACRO_FIXTURE_SERIES_IDS,
} from './helpers/china-macro-fixture.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
};
const provenanceFixture = JSON.parse(readFileSync(
  new URL('fixtures/decision-signal-provenance/china-macro-official.json', import.meta.url),
  'utf8',
)).provenance;
const retrievalTime = CHINA_MACRO_FIXTURE_RETRIEVAL_TIME;
const industrialHtml = readFileSync(
  new URL('fixtures/china-macro/nbs-industrial.html', import.meta.url),
  'utf8',
);

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  Date.now = ORIGINAL_DATE_NOW;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configureRedis() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.VERCEL_GIT_COMMIT_SHA;
}

async function macroSnapshot(provenance?: unknown) {
  const snapshot = await buildOfficialChinaMacroFixture();
  if (provenance !== undefined) snapshot.observations[0].provenance = provenance;
  return snapshot;
}

const calendar = {
  events: [{
    id: 'pboc-lpr-2026-07',
    event: 'Loan Prime Rate (LPR)',
    countryCode: 'CN',
    releaseDate: '2026-07-20',
    releaseTime: '09:00',
    timezone: 'Asia/Shanghai',
    kind: 'pboc_lpr',
    status: 'provisional',
    source: 'PBoC rule; realized date verified by ChinaMoney/CFETS',
    sourceUrl: 'https://chinamoney.test',
  }],
  sourceDecisions: [],
};

function redisResponse(macro: unknown, releaseCalendar: unknown) {
  return new Response(JSON.stringify([
    { result: macro === null ? null : JSON.stringify(macro) },
    { result: releaseCalendar === null ? null : JSON.stringify(releaseCalendar) },
  ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('getChinaMacroSnapshot seeded RPC', () => {
  it('reads the complete v2 key and preserves provenance, vintages, failures, and preflight fields', async () => {
    configureRedis();
    Date.now = () => Date.parse(retrievalTime);
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      assert.deepEqual(JSON.parse(String(init?.body)), [
        ['GET', 'economic:china:macro:v2'],
        ['GET', 'economic:china:release-calendar:v1'],
      ]);
      return redisResponse(await macroSnapshot(), calendar);
    }) as typeof fetch;

    const response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'https://redis.example.test/pipeline');
    assert.equal(response.schemaVersion, 2);
    assert.equal(response.launchReady, true);
    assert.deepEqual(response.indicators.map((indicator) => indicator.id), CHINA_MACRO_FIXTURE_SERIES_IDS);
    assert.equal(response.indicators[0]?.hasValue, true);
    assert.equal(response.indicators[0]?.observationPeriod, '2026-06');
    assert.equal(response.indicators[0]?.revisionState, 'original');
    assert.equal(response.indicators[0]?.vintages.length, 1);
    assert.equal(
      JSON.parse(response.indicators[0]?.provenanceJson ?? '').familyId,
      provenanceFixture.familyId,
    );
    assert.equal(response.indicators[0]?.transportStatus, 'fresh');
    const blocked = response.indicators.filter((indicator) => !indicator.hasValue);
    assert.equal(blocked.length, 7);
    assert.deepEqual(
      [...new Set(blocked.map((indicator) => indicator.unavailableReason))],
      ['ROBOTS_DISALLOW', 'TLS_CERTIFICATE_ERROR'],
    );
    assert.ok(blocked.every((indicator) => indicator.transportStatus === 'blocked'));
    assert.equal(response.pillars[0]?.direction, 'strengthening');
    assert.equal(response.sourceDecisions[0]?.requestBudget, 8);
    assert.equal(response.releaseEvents[0]?.status, 'provisional');
    assert.equal(response.unavailable, false);
  });

  it('fails closed when current or vintage #5581 provenance is incomplete', async () => {
    configureRedis();
    Date.now = () => Date.parse(retrievalTime);
    const invalidCurrent = structuredClone(provenanceFixture);
    delete invalidCurrent.claims.publication_time;
    globalThis.fetch = (async () => redisResponse(await macroSnapshot(invalidCurrent), calendar)) as typeof fetch;
    let response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(response.unavailable, true);
    assert.equal(response.launchReady, false);
    assert.deepEqual(response.indicators, []);

    const invalidVintageSnapshot = await macroSnapshot();
    delete invalidVintageSnapshot.observations[0].vintages[0].provenance.claims.publication_time;
    globalThis.fetch = (async () => redisResponse(invalidVintageSnapshot, calendar)) as typeof fetch;
    response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(response.unavailable, true);
    assert.equal(response.launchReady, false);

    const lineageSnapshot = await macroSnapshot();
    const corrected = parseNbsIndustrialRelease(
      industrialHtml.replace('increased by 5.3%', 'increased by 5.1%'),
      {
        retrievalTime,
        sourceUrl: lineageSnapshot.observations[0].sourceUrl,
        previousObservation: lineageSnapshot.observations[0],
      },
    );
    lineageSnapshot.observations[0] = corrected;
    corrected.vintages[0].supersededBy = '';
    corrected.vintages[0].provenance.claims.supersession = {
      status: 'known',
      value: { state: 'current' },
    };
    globalThis.fetch = (async () => redisResponse(lineageSnapshot, calendar)) as typeof fetch;
    response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(response.unavailable, true);
    assert.equal(normalizeHydratedChina(lineageSnapshot, calendar, Date.parse(retrievalTime)), null);
  });

  it('keeps the macro pulse available when the independent calendar seed is missing', async () => {
    configureRedis();
    Date.now = () => Date.parse(retrievalTime);
    globalThis.fetch = (async () => redisResponse(await macroSnapshot(), null)) as typeof fetch;
    const response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(response.unavailable, false);
    assert.equal(response.launchReady, true);
    assert.equal(response.status, 'degraded');
    assert.deepEqual(response.indicators.map((indicator) => indicator.id), CHINA_MACRO_FIXTURE_SERIES_IDS);
    assert.deepEqual(response.releaseEvents, []);
  });

  it('fails closed on malformed macro preflight decisions and temporal bindings', async () => {
    configureRedis();
    Date.now = () => Date.parse(retrievalTime);
    const malformed = await macroSnapshot();
    malformed.sourceDecisions[0].requestBudget = 999;
    globalThis.fetch = (async () => redisResponse(malformed, calendar)) as typeof fetch;
    let response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(response.unavailable, true);

    const futurePeriod = await macroSnapshot();
    futurePeriod.observations[0].observationPeriod = '2099-06';
    globalThis.fetch = (async () => redisResponse(futurePeriod, calendar)) as typeof fetch;
    response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(response.unavailable, true);

    const fabricatedBlocked = await macroSnapshot();
    const pboc = fabricatedBlocked.observations.find(
      (observation) => observation.seriesId === 'pboc_m2_yoy',
    );
    Object.assign(pboc, {
      value: 99,
      observationPeriod: '2026-06',
      releaseTime: '2026-07-10T00:00:00.000Z',
      retrievalTime,
      unavailableReason: '',
      transportStatus: 'fresh',
      transportFailureReason: '',
    });
    globalThis.fetch = (async () => redisResponse(fabricatedBlocked, calendar)) as typeof fetch;
    response = await getChinaMacroSnapshot({} as never, {});
    assert.equal(response.unavailable, true);
  });

  it('recomputes content freshness before deciding launch readiness', async () => {
    configureRedis();
    Date.now = () => Date.parse('2026-08-16T00:00:00.000Z');
    globalThis.fetch = (async () => redisResponse(await macroSnapshot(), calendar)) as typeof fetch;

    const response = await getChinaMacroSnapshot({} as never, {});
    const reserves = response.indicators.find((indicator) => indicator.id === 'safe_fx_reserves');
    assert.equal(response.unavailable, false);
    assert.equal(response.launchReady, false);
    assert.equal(reserves?.stale, true);
    assert.equal(reserves?.unavailableReason, 'STALE_OBSERVATION');
    assert.equal(
      JSON.parse(reserves?.provenanceJson ?? '').claims.content_freshness.value.state,
      'stale',
    );
  });

  it('keeps bootstrap hydration and RPC envelopes in parity for the same cache payload', async () => {
    configureRedis();
    Date.now = () => Date.parse(retrievalTime);
    const macro = await macroSnapshot();
    const calendarWithDecision = {
      ...calendar,
      sourceDecisions: [{
        publisherId: 'publisher:pboc-cn',
        source: 'PBoC release calendar',
        host: 'www.pbc.gov.cn',
        status: 'blocked',
        reason: 'ROBOTS_DISALLOW',
        checkedAt: retrievalTime,
        optional: false,
        requestCount: 1,
        redirectBehavior: 'none',
        requestBudget: 1,
        robotsStatus: 'disallow_all',
        termsStatus: 'not_evaluated_robots_blocked',
        sourceUrl: 'https://www.pbc.gov.cn/',
      }],
    };
    globalThis.fetch = (async () => redisResponse(macro, calendarWithDecision)) as typeof fetch;

    const rpc = await getChinaMacroSnapshot({} as never, {});
    const hydrated = normalizeHydratedChina(macro, calendarWithDecision, Date.now());
    assert.ok(hydrated);
    assert.deepEqual(hydrated.indicators, rpc.indicators);
    assert.deepEqual(hydrated.sourceDecisions, rpc.sourceDecisions);
    assert.deepEqual(hydrated.releaseEvents, rpc.releaseEvents);
    assert.deepEqual(hydrated.pillars, rpc.pillars);
    assert.equal(hydrated.status, rpc.status);
    assert.equal(hydrated.launchReady, rpc.launchReady);
  });
});
