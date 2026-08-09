// Executable coverage for the WTO tariff-trends contract (issue #6316).
//
// The defect these tests lock down: the seeded cache key carried the requested
// lookback (`…:${years}`) but was only ever written at years=10, so every other
// supported window built a key nothing had written and the handler answered
// `upstreamUnavailable: true` — reporting a fault for a request the contract
// accepted. Malformed codes were also silently rewritten to '840' (United
// States), and product_sector / partner_country were accepted without ever
// affecting the answer or naming a coverage gap.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COVERAGE_KEY,
  COVERED_PRODUCT_SECTOR,
  DEFAULT_REPORTING_COUNTRY,
  DEFAULT_YEARS,
  LEGACY_SEEDED_YEARS,
  MAX_YEARS,
  getTariffTrends,
  legacyTariffTrendSeedKey,
  normalizeTariffTrendRequest,
  sliceTariffsToWindow,
  tariffTrendSeedKey,
  TARIFF_TREND_REASON as R,
} from '../server/worldmonitor/trade/v1/get-tariff-trends';
import { GENERATED_MESSAGE_RULES } from '../src/generated/server/request_validation';
import { validateGeneratedRequest } from '../server/request-validator';
import {
  TARIFF_COVERAGE_KEY,
  TARIFF_KEY_PREFIX,
  TARIFF_META_KEY,
  TARIFF_SEED_YEARS,
  TARIFF_TTL,
  buildTariffDatapoints,
  publishTariffTrends,
  tariffTrendCoverageId,
  tariffTrendSeedKey as seedTariffTrendSeedKey,
} from '../scripts/seed-supply-chain-trade.mjs';

import type {
  GetTariffTrendsRequest,
  GetTariffTrendsResponse,
  ServerContext,
  TariffDataPoint,
} from '../src/generated/server/worldmonitor/trade/v1/service_server';

// ── Harness ────────────────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  localApiMode: process.env.LOCAL_API_MODE,
  validKeys: process.env.WORLDMONITOR_VALID_KEYS,
};
const REDIS_HOST = 'https://redis.test';
const ENTERPRISE_KEY = 'test-tariff-enterprise-key';

let redisStore: Map<string, unknown>;
let redisErrors: Set<string>;
let redisReads: string[];
let redisWrites: Array<{ key: string; value: unknown }>;

function keyFromUpstashUrl(href: string): string {
  return decodeURIComponent(href.slice(`${REDIS_HOST}/get/`.length));
}

beforeEach(() => {
  redisStore = new Map();
  redisErrors = new Set();
  redisReads = [];
  redisWrites = [];
  process.env.UPSTASH_REDIS_REST_URL = REDIS_HOST;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
  delete process.env.LOCAL_API_MODE;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = String(input);
    if (href.startsWith(`${REDIS_HOST}/get/`)) {
      const key = keyFromUpstashUrl(href);
      redisReads.push(key);
      if (redisErrors.has(key)) return new Response('boom', { status: 500 });
      const value = redisStore.get(key);
      return new Response(
        JSON.stringify({ result: value === undefined ? null : JSON.stringify(value) }),
        { status: 200 },
      );
    }
    // writeExtraKey / writeSeedMeta POST pipeline to the Upstash REST root
    if (href === REDIS_HOST || href === `${REDIS_HOST}/`) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (Array.isArray(body) && body[0] === 'SET') {
        const key = String(body[1]);
        const raw = body[2];
        let parsed: unknown = raw;
        try { parsed = JSON.parse(String(raw)); } catch { /* bare string */ }
        redisStore.set(key, parsed);
        redisWrites.push({ key, value: parsed });
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${href}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [name, value] of [
    ['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url],
    ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token],
    ['LOCAL_API_MODE', ORIGINAL_ENV.localApiMode],
    ['WORLDMONITOR_VALID_KEYS', ORIGINAL_ENV.validKeys],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function premiumCtx(): ServerContext {
  return {
    request: new Request('https://api.worldmonitor.app/api/trade/v1/get-tariff-trends', {
      headers: { 'X-WorldMonitor-Key': ENTERPRISE_KEY },
    }),
  } as ServerContext;
}

function freeCtx(): ServerContext {
  return {
    request: new Request('https://api.worldmonitor.app/api/trade/v1/get-tariff-trends'),
  } as ServerContext;
}

function request(partial: Partial<GetTariffTrendsRequest> = {}): GetTariffTrendsRequest {
  return {
    reportingCountry: '',
    partnerCountry: '',
    productSector: '',
    years: 0,
    ...partial,
  };
}

function tariffPoint(year: number, tariffRate = 3.5): TariffDataPoint {
  return {
    reportingCountry: 'United States of America',
    partnerCountry: 'World',
    productSector: 'All products',
    year,
    tariffRate,
    boundRate: 0,
    indicatorCode: 'TP_A_0010',
  };
}

function seededPayload(startYear: number, endYear: number): GetTariffTrendsResponse {
  const datapoints: TariffDataPoint[] = [];
  for (let year = startYear; year <= endYear; year += 1) datapoints.push(tariffPoint(year));
  return {
    datapoints,
    fetchedAt: '2026-08-09T00:00:00.000Z',
    upstreamUnavailable: false,
    unavailableReason: R.served,
    coverageStartYear: startYear,
    coverageEndYear: endYear,
  };
}

function seedUs(startYear = 1996, endYear = 2025): void {
  redisStore.set(tariffTrendSeedKey('840'), seededPayload(startYear, endYear));
}

function seedManifest(reporters: string[]): void {
  redisStore.set(COVERAGE_KEY, {
    reporters,
    startYear: 1996,
    endYear: 2026,
    fetchedAt: '2026-08-09T00:00:00.000Z',
  });
}

function assertTwoReads(reporter: string): void {
  assert.deepEqual(
    redisReads,
    [tariffTrendSeedKey(reporter), COVERAGE_KEY],
    'a miss must read the reporter key and the manifest, and nothing else',
  );
}

// ── Contract pins ─────────────────────────────────────────────────────────

describe('seeder and handler agree on the cache contract', () => {
  test('the seeded window equals the contract maximum lookback', () => {
    assert.equal(TARIFF_SEED_YEARS, MAX_YEARS);
    const rule = (GENERATED_MESSAGE_RULES as Record<string, { fields: Record<string, { numberLte?: number; numberGte?: number }> }>)['worldmonitor.trade.v1.GetTariffTrendsRequest'];
    assert.equal(rule.fields.years.numberLte, MAX_YEARS);
    assert.equal(rule.fields.years.numberGte, 0);
  });

  test('the gateway pattern and the handler guard accept the same codes', () => {
    const rule = (GENERATED_MESSAGE_RULES as Record<string, { fields: Record<string, { stringPattern?: string }> }>)['worldmonitor.trade.v1.GetTariffTrendsRequest'];
    assert.equal(rule.fields.reportingCountry.stringPattern, '^([0-9]{3})?$');
    assert.equal(rule.fields.partnerCountry.stringPattern, '^([0-9]{3})?$');
    assert.equal(rule.fields.productSector.stringPattern, '^([a-zA-Z0-9_-]{0,16})?$');
  });

  test('the gateway rejects the same inputs with a 400 before the handler runs', () => {
    assert.equal(validateGeneratedRequest('getTariffTrends', { reportingCountry: '', partnerCountry: '', productSector: '', years: 0 }), undefined);
    assert.equal(validateGeneratedRequest('getTariffTrends', { reportingCountry: '840', partnerCountry: '000', productSector: 'all', years: 30 }), undefined);
    for (const body of [
      { reportingCountry: 'XX', partnerCountry: '', productSector: '', years: 0 },
      { reportingCountry: '8400', partnerCountry: '', productSector: '', years: 0 },
      { reportingCountry: '', partnerCountry: '15', productSector: '', years: 0 },
      { reportingCountry: '', partnerCountry: '', productSector: 'x'.repeat(17), years: 0 },
      { reportingCountry: '', partnerCountry: '', productSector: '', years: 31 },
      { reportingCountry: '', partnerCountry: '', productSector: '', years: -1 },
      { reportingCountry: '', partnerCountry: '', productSector: '', years: Number.NaN },
    ]) {
      assert.ok(validateGeneratedRequest('getTariffTrends', body), `expected a violation for ${JSON.stringify(body)}`);
    }
  });

  test('handler and seeder share the same key prefix and coverage key', () => {
    assert.equal(seedTariffTrendSeedKey('840'), tariffTrendSeedKey('840'));
    assert.equal(TARIFF_COVERAGE_KEY, COVERAGE_KEY);
    assert.equal(TARIFF_KEY_PREFIX, 'trade:tariffs:v2');
    assert.equal(TARIFF_META_KEY, 'seed-meta:trade:tariffs');
    assert.equal(tariffTrendCoverageId('840'), '840');
  });

  test('TARIFF_TTL is 8h so the meta-only health budget can pin against it', () => {
    assert.equal(TARIFF_TTL, 28800);
  });
});

// ── Serving a seeded reporter ─────────────────────────────────────────────

describe('seeded reporter requests', () => {
  test('years=1 / 10 / 30 all slice the same key', async () => {
    seedUs(1996, 2025);
    seedManifest(['840']);

    const one = await getTariffTrends(premiumCtx(), request({ years: 1 }));
    assert.equal(one.upstreamUnavailable, false);
    assert.equal(one.unavailableReason, R.served);
    assert.equal(one.coverageEndYear, 2025);
    assert.equal(one.coverageStartYear, 2024);
    assert.equal(one.datapoints.length, 2); // inclusive of both endpoints

    redisReads = [];
    const ten = await getTariffTrends(premiumCtx(), request({ years: 10 }));
    assert.equal(ten.coverageStartYear, 2015);
    assert.equal(ten.datapoints.length, 11);

    redisReads = [];
    const thirty = await getTariffTrends(premiumCtx(), request({ years: 30 }));
    assert.equal(thirty.coverageStartYear, 1996);
    assert.equal(thirty.datapoints.length, 30);
    // All three hit the same cache key — years is not part of the key.
    assert.deepEqual(redisReads, [tariffTrendSeedKey('840')]);
  });

  test('default years=0 and empty reporter select documented defaults', async () => {
    seedUs(2010, 2025);
    const resp = await getTariffTrends(premiumCtx(), request());
    assert.equal(resp.datapoints.length, 11); // default 10 years inclusive
    assert.equal(normalizeTariffTrendRequest(request())?.reporter, DEFAULT_REPORTING_COUNTRY);
    assert.equal(normalizeTariffTrendRequest(request())?.years, DEFAULT_YEARS);
  });

  test('partner_country does not change the answer (MFN has no partner dimension)', async () => {
    seedUs(2015, 2025);
    const without = await getTariffTrends(premiumCtx(), request({ partnerCountry: '' }));
    redisReads = [];
    const withPartner = await getTariffTrends(premiumCtx(), request({ partnerCountry: '156' }));
    assert.deepEqual(withPartner.datapoints, without.datapoints);
    // Same key — partner never enters it.
    assert.deepEqual(redisReads, [tariffTrendSeedKey('840')]);
  });

  test('product_sector empty and "all" are covered; other sectors are not_covered', async () => {
    seedUs(2015, 2025);
    seedManifest(['840']);

    const empty = await getTariffTrends(premiumCtx(), request({ productSector: '' }));
    assert.equal(empty.unavailableReason, R.served);
    assert.ok(empty.datapoints.length > 0);

    redisReads = [];
    const all = await getTariffTrends(premiumCtx(), request({ productSector: 'all' }));
    assert.equal(all.unavailableReason, R.served);

    redisReads = [];
    const sector = await getTariffTrends(premiumCtx(), request({ productSector: '01' }));
    assert.equal(sector.unavailableReason, R.notCovered);
    assert.equal(sector.upstreamUnavailable, false);
    assert.equal(sector.datapoints.length, 0);
    // No Redis read for an out-of-coverage sector.
    assert.deepEqual(redisReads, []);
  });

  test('free tier returns empty without touching Redis', async () => {
    seedUs(2015, 2025);
    const resp = await getTariffTrends(freeCtx(), request());
    assert.equal(resp.datapoints.length, 0);
    assert.equal(resp.upstreamUnavailable, true);
    assert.deepEqual(redisReads, []);
  });
});

// ── Naming a miss ─────────────────────────────────────────────────────────

describe('a miss is attributed to a cause, not blamed on upstream', () => {
  test('reporter outside the manifest is not_covered (not a fault)', async () => {
    seedManifest(['840']);
    const resp = await getTariffTrends(premiumCtx(), request({ reportingCountry: '156' }));
    assert.equal(resp.unavailableReason, R.notCovered);
    assert.equal(resp.upstreamUnavailable, false);
    assert.equal(resp.fetchedAt, '');
    assertTwoReads('156');
  });

  test('reporter inside the manifest with no key is seed_missing (a fault)', async () => {
    seedManifest(['840', '156']);
    const resp = await getTariffTrends(premiumCtx(), request({ reportingCountry: '156' }));
    assert.equal(resp.unavailableReason, R.seedMissing);
    assert.equal(resp.upstreamUnavailable, true);
    assertTwoReads('156');
  });

  test('absent or corrupt manifest is coverage_unknown', async () => {
    const missing = await getTariffTrends(premiumCtx(), request({ reportingCountry: '840' }));
    assert.equal(missing.unavailableReason, R.coverageUnknown);
    assert.equal(missing.upstreamUnavailable, true);

    redisReads = [];
    redisStore.set(COVERAGE_KEY, { reporters: [null] });
    const corrupt = await getTariffTrends(premiumCtx(), request({ reportingCountry: '840' }));
    assert.equal(corrupt.unavailableReason, R.coverageUnknown);
  });

  test('cache read error is cache_unavailable', async () => {
    redisErrors.add(tariffTrendSeedKey('840'));
    const resp = await getTariffTrends(premiumCtx(), request());
    assert.equal(resp.unavailableReason, R.cacheUnavailable);
    assert.equal(resp.upstreamUnavailable, true);
  });

  test('legacy v1 key is served only while the v2 manifest is absent', async () => {
    // No v2 key, no manifest → coverage_unknown arm → bridge reads v1.
    redisStore.set(
      legacyTariffTrendSeedKey('840'),
      seededPayload(2015, 2024),
    );
    const bridged = await getTariffTrends(premiumCtx(), request({ years: 5 }));
    assert.equal(bridged.unavailableReason, R.served);
    assert.equal(bridged.coverageEndYear, 2024);
    assert.equal(bridged.datapoints.length, 6);
    assert.ok(redisReads.includes(legacyTariffTrendSeedKey('840')));

    // Once the v2 manifest exists, the bridge must not fire — seed_missing.
    redisReads = [];
    seedManifest(['840']);
    const noBridge = await getTariffTrends(premiumCtx(), request());
    assert.equal(noBridge.unavailableReason, R.seedMissing);
    assert.ok(!redisReads.includes(legacyTariffTrendSeedKey('840')));
  });
});

// ── Request validation ────────────────────────────────────────────────────

describe('malformed input is rejected instead of silently defaulted', () => {
  test('normalize rejects non-digit codes and out-of-range years', () => {
    assert.equal(normalizeTariffTrendRequest(request({ reportingCountry: 'XX' })), null);
    assert.equal(normalizeTariffTrendRequest(request({ reportingCountry: '84' })), null);
    assert.equal(normalizeTariffTrendRequest(request({ partnerCountry: 'USA' })), null);
    assert.equal(normalizeTariffTrendRequest(request({ years: 31 })), null);
    assert.equal(normalizeTariffTrendRequest(request({ years: -1 })), null);
    assert.equal(normalizeTariffTrendRequest(request({ productSector: 'too-long-sector-name!' })), null);
  });

  test('handler returns invalid_request for malformed codes (no US substitution)', async () => {
    seedUs(2015, 2025);
    const resp = await getTariffTrends(premiumCtx(), request({ reportingCountry: 'XX' }));
    assert.equal(resp.unavailableReason, R.invalidRequest);
    assert.equal(resp.upstreamUnavailable, false);
    assert.equal(resp.datapoints.length, 0);
    // Must not have answered about the United States.
    assert.deepEqual(redisReads, []);
  });

  test('normalize maps empty sector and "all" to the covered token', () => {
    assert.equal(normalizeTariffTrendRequest(request({ productSector: '' }))?.productSector, COVERED_PRODUCT_SECTOR);
    assert.equal(normalizeTariffTrendRequest(request({ productSector: 'ALL' }))?.productSector, COVERED_PRODUCT_SECTOR);
    assert.equal(normalizeTariffTrendRequest(request({ productSector: '01' }))?.productSector, '01');
  });
});

// ── Slice arithmetic ──────────────────────────────────────────────────────

describe('sliceTariffsToWindow', () => {
  test('inclusive endpoints and empty input', () => {
    const points = [tariffPoint(2015), tariffPoint(2020), tariffPoint(2025)];
    assert.deepEqual(
      sliceTariffsToWindow(points, 10).map((p) => p.year),
      [2015, 2020, 2025],
    );
    assert.deepEqual(
      sliceTariffsToWindow(points, 5).map((p) => p.year),
      [2020, 2025],
    );
    assert.deepEqual(sliceTariffsToWindow([], 10), []);
  });
});

// ── Seeder construction + publish ─────────────────────────────────────────

describe('buildTariffDatapoints', () => {
  test('parses WTO rows and drops unusable ones', () => {
    const points = buildTariffDatapoints('840', [
      { Year: '2020', Value: '3.4', ReportingEconomy: 'United States of America' },
      { Year: 'bad', Value: '1' },
      { year: '2021', value: '3.5' },
    ]);
    assert.equal(points.length, 2);
    assert.equal(points[0].year, 2020);
    assert.equal(points[0].tariffRate, 3.4);
    assert.equal(points[0].indicatorCode, 'TP_A_0010');
    assert.equal(points[0].partnerCountry, 'World');
    assert.equal(points[0].productSector, 'All products');
  });
});

describe('publishTariffTrends', () => {
  test('writes per-reporter keys, the coverage manifest, and fleet seed-meta', async () => {
    const trends = {
      [seedTariffTrendSeedKey('840')]: seededPayload(2015, 2025),
      [seedTariffTrendSeedKey('156')]: seededPayload(2015, 2025),
    };
    await publishTariffTrends({
      trends,
      manifest: {
        reporters: ['156', '840'],
        startYear: 2015,
        endYear: 2025,
        fetchedAt: '2026-08-09T00:00:00.000Z',
        reporterListIsFallback: false,
      },
    });

    assert.ok(redisStore.has(seedTariffTrendSeedKey('840')));
    assert.ok(redisStore.has(seedTariffTrendSeedKey('156')));
    assert.ok(redisStore.has(TARIFF_COVERAGE_KEY));
    assert.ok(redisStore.has(TARIFF_META_KEY));
    const meta = redisStore.get(TARIFF_META_KEY) as { recordCount: number };
    assert.equal(meta.recordCount, 2);
    const manifest = redisStore.get(TARIFF_COVERAGE_KEY) as { reporters: string[] };
    assert.deepEqual(manifest.reporters, ['156', '840']);
  });

  test('refuses to publish a coverage manifest from a fallback reporter list', async () => {
    const trends = { [seedTariffTrendSeedKey('840')]: seededPayload(2015, 2025) };
    await publishTariffTrends({
      trends,
      manifest: {
        reporters: ['840'],
        startYear: 2015,
        endYear: 2025,
        fetchedAt: '2026-08-09T00:00:00.000Z',
        reporterListIsFallback: true,
      },
    });
    assert.ok(redisStore.has(seedTariffTrendSeedKey('840')));
    assert.ok(!redisStore.has(TARIFF_COVERAGE_KEY));
    // Meta still lands so health can see the fleet size.
    assert.ok(redisStore.has(TARIFF_META_KEY));
  });

  test('writes nothing when the fleet is empty (leaves prior meta alone)', async () => {
    redisStore.set(TARIFF_META_KEY, { fetchedAt: 1, recordCount: 99 });
    await publishTariffTrends({
      trends: {},
      manifest: {
        reporters: [],
        startYear: 2015,
        endYear: 2025,
        fetchedAt: '2026-08-09T00:00:00.000Z',
        reporterListIsFallback: false,
      },
    });
    const meta = redisStore.get(TARIFF_META_KEY) as { recordCount: number };
    assert.equal(meta.recordCount, 99);
  });
});

// ── Dashboard call site ───────────────────────────────────────────────────

describe('the dashboard asks for a combination the seed can answer', () => {
  test('data-loader US call with partner China still resolves after partner is ignored', async () => {
    // src/app/data-loader.ts: fetchTariffTrends('840', '156', '', 10)
    seedUs(2015, 2025);
    const resp = await getTariffTrends(
      premiumCtx(),
      request({ reportingCountry: '840', partnerCountry: '156', productSector: '', years: 10 }),
    );
    assert.equal(resp.unavailableReason, R.served);
    assert.ok(resp.datapoints.length > 0);
  });

  test('data-loader call site still passes the codes the contract accepts', () => {
    const src = readFileSync(resolve('src/app/data-loader.ts'), 'utf8');
    assert.match(src, /fetchTariffTrends\('840',\s*'156',\s*'',\s*10\)/);
  });
});

// ── Legacy years baked into the key is gone ───────────────────────────────

describe('the years component is no longer part of the cache key', () => {
  test('legacy years=10 key shape is only used by the cutover bridge', () => {
    assert.equal(legacyTariffTrendSeedKey('840'), `trade:tariffs:v1:840:all:${LEGACY_SEEDED_YEARS}`);
    assert.equal(tariffTrendSeedKey('840'), 'trade:tariffs:v2:840');
    assert.notEqual(tariffTrendSeedKey('840'), legacyTariffTrendSeedKey('840'));
  });
});
