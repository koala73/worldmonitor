import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEntsoEPrice,
  buildElectricityIndex,
  EIA_REGIONS,
  ELECTRICITY_INDEX_KEY,
  ELECTRICITY_KEY_PREFIX,
  ELECTRICITY_META_KEY,
  ELECTRICITY_TTL_SECONDS,
  fetchEiaRegion,
  fetchEntsoERegion,
  main,
  meetsEntsoPublicationFloor,
} from '../scripts/seed-electricity-prices.mjs';

// The transport-recovery cases drive withRetry to exhaustion. Cap the idle
// wait between attempts — attempt count and the logged wait stay real (see
// the WM_SEED_RETRY_DELAY_MS comment in scripts/_seed-utils.mjs withRetry).
const originalRetryDelay = process.env.WM_SEED_RETRY_DELAY_MS;
beforeEach(() => {
  process.env.WM_SEED_RETRY_DELAY_MS = '0';
});
afterEach(() => {
  if (originalRetryDelay === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
  else process.env.WM_SEED_RETRY_DELAY_MS = originalRetryDelay;
});

const ENTSO_API_PREFIX = 'https://web-api.tp.entsoe.eu/api?';
const ENTSO_REGION = { region: 'DE', eic: '10Y1001A1001A82H', name: 'Germany' };
const ENTSO_TODAY = new Date('2026-09-02T00:00:00Z');
const ENTSO_YESTERDAY = new Date('2026-09-01T00:00:00Z');

function entsoXml(price) {
  return `<TimeSeries><Period><Point><price.amount>${price}</price.amount></Point></Period></TimeSeries>`;
}

// ── parseEntsoEPrice ──────────────────────────────────────────────────────────

describe('parseEntsoEPrice', () => {
  it('extracts average from XML with 24 hourly price.amount values', () => {
    const prices = Array.from({ length: 24 }, (_, i) => 80 + i); // 80..103
    const xml = prices
      .map((p, i) => `<Point><position>${i + 1}</position><price.amount>${p}.00</price.amount></Point>`)
      .join('\n');
    const result = parseEntsoEPrice(xml);
    const expected = +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
    assert.equal(result, expected);
  });

  it('returns null when no price.amount tags present', () => {
    const xml = '<TimeSeries><Period><resolution>PT60M</resolution></Period></TimeSeries>';
    assert.equal(parseEntsoEPrice(xml), null);
  });

  it('handles a single price value', () => {
    const xml = '<price.amount>87.30</price.amount>';
    assert.equal(parseEntsoEPrice(xml), 87.3);
  });

  it('ignores non-numeric price values', () => {
    const xml = '<price.amount>abc</price.amount><price.amount>50.00</price.amount>';
    assert.equal(parseEntsoEPrice(xml), 50);
  });

  it('handles negative prices (common in EU wholesale markets)', () => {
    const xml = '<price.amount>-10.00</price.amount><price.amount>20.00</price.amount>';
    assert.equal(parseEntsoEPrice(xml), 5);
  });

  it('handles all-negative prices', () => {
    const xml = '<price.amount>-5.00</price.amount><price.amount>-15.00</price.amount>';
    assert.equal(parseEntsoEPrice(xml), -10);
  });
});

describe('fetchEntsoERegion transport recovery', () => {
  it('returns direct XML without calling the proxy', async () => {
    let proxyCalls = 0;
    const directCalls = [];
    const result = await fetchEntsoERegion(
      ENTSO_REGION,
      'test-token',
      ENTSO_TODAY,
      ENTSO_YESTERDAY,
      {
        fetchFn: async (url, init) => {
          directCalls.push({ url, init });
          return { ok: true, text: async () => entsoXml('87.30') };
        },
        proxyAuth: 'proxy-auth',
        proxyFetcher: async () => {
          proxyCalls += 1;
          return { buffer: Buffer.from(entsoXml('90.00')) };
        },
      },
    );

    assert.equal(proxyCalls, 0);
    assert.equal(directCalls.length, 1);
    const [{ url, init }] = directCalls;
    assert.ok(url.startsWith(ENTSO_API_PREFIX), `unexpected ENTSO-E URL: ${url}`);
    const params = new URL(url).searchParams;
    assert.equal(params.get('documentType'), 'A44');
    assert.equal(params.get('in_Domain'), ENTSO_REGION.eic);
    assert.equal(params.get('out_Domain'), ENTSO_REGION.eic);
    assert.equal(params.get('securityToken'), 'test-token');
    assert.equal(params.get('periodStart'), '202609010000');
    assert.equal(params.get('periodEnd'), '202609022300');
    assert.match(init.headers['User-Agent'], /Mozilla\/5\.0/, 'direct leg must send CHROME_UA');
    assert.equal(init.headers.Accept, 'application/xml');
    assert.equal(result.region, 'DE');
    assert.equal(result.source, 'entso-e');
    assert.equal(result.priceMwhEur, 87.3);
  });

  it('uses the proxy once after retryable direct failures', async () => {
    let directCalls = 0;
    const proxyCalls = [];
    const result = await fetchEntsoERegion(
      ENTSO_REGION,
      'test-token',
      ENTSO_TODAY,
      ENTSO_YESTERDAY,
      {
        fetchFn: async () => {
          directCalls += 1;
          return { ok: false, status: 503 };
        },
        proxyAuth: 'proxy-auth',
        proxyFetcher: async (url, auth, opts) => {
          proxyCalls.push({ url, auth, opts });
          return { buffer: Buffer.from(entsoXml('91.20')) };
        },
      },
    );

    assert.equal(directCalls, 3, 'must exhaust the existing direct retry path');
    assert.equal(proxyCalls.length, 1, 'proxy fallback must stay bounded');
    const [{ url, auth, opts }] = proxyCalls;
    assert.ok(url.startsWith(ENTSO_API_PREFIX), `proxy leg must request the same ENTSO-E URL, got: ${url}`);
    assert.equal(new URL(url).searchParams.get('securityToken'), 'test-token');
    assert.equal(auth, 'proxy-auth', 'proxy leg must use the resolved CONNECT auth string');
    assert.equal(opts.accept, 'application/xml');
    assert.equal(opts.timeoutMs, 20_000);
    assert.equal(result.priceMwhEur, 91.2);
  });

  it('keeps proxy failure visible when both routes fail', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const result = await fetchEntsoERegion(
        ENTSO_REGION,
        'test-token',
        ENTSO_TODAY,
        ENTSO_YESTERDAY,
        {
          fetchFn: async () => ({ ok: false, status: 503 }),
          proxyAuth: 'proxy-auth',
          proxyFetcher: async () => {
            throw new Error('proxy unavailable');
          },
        },
      );

      assert.equal(result, null);
      assert.ok(
        warnings.some((message) => message.includes('proxy unavailable')),
        `expected proxy failure in warnings, got: ${warnings.join('\n')}`,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it('contains direct failure when no proxy is configured', async () => {
    // resolveProxyForConnect() returns '' when PROXY_URL is unset. The
    // fallback must stay inert AND say so — otherwise the log line is
    // identical to the pre-fallback outage and reads as "proxy blocked too".
    let directCalls = 0;
    let proxyCalls = 0;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const result = await fetchEntsoERegion(
        ENTSO_REGION,
        'test-token',
        ENTSO_TODAY,
        ENTSO_YESTERDAY,
        {
          fetchFn: async () => {
            directCalls += 1;
            return { ok: false, status: 503 };
          },
          proxyAuth: '',
          proxyFetcher: async () => {
            proxyCalls += 1;
            return { buffer: Buffer.from(entsoXml('90.00')) };
          },
        },
      );

      assert.equal(directCalls, 3, 'direct retries still run without a proxy');
      assert.equal(proxyCalls, 0, 'proxy must not be attempted without auth');
      assert.equal(result, null);
      assert.ok(
        warnings.some((message) => /ENTSO-E DE failed: ENTSO-E DE HTTP 503$/.test(message)),
        `direct error must surface unchanged, got: ${warnings.join('\n')}`,
      );
      assert.ok(
        warnings.some((message) => message.includes('no proxy configured')),
        `skipped fallback must be visible, got: ${warnings.join('\n')}`,
      );
      assert.ok(
        !warnings.some((message) => message.includes('proxy=')),
        `no proxy error fragment expected, got: ${warnings.join('\n')}`,
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('ENTSO-E full-snapshot publication floor', () => {
  it('requires at least seven ENTSO-E regions', () => {
    assert.equal(meetsEntsoPublicationFloor(6), false);
    assert.equal(meetsEntsoPublicationFloor(7), true);
  });

  it('preserves full-snapshot freshness and rejects a failed degraded EIA write', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      ENTSO_E_TOKEN: process.env.ENTSO_E_TOKEN,
      EIA_API_KEY: process.env.EIA_API_KEY,
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    };
    const pipelines = [];

    delete process.env.ENTSO_E_TOKEN;
    process.env.EIA_API_KEY = 'test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href.startsWith('https://api.eia.gov/')) {
        return new Response(JSON.stringify({ response: { data: [{ value: 10_000 }] } }), {
          status: 200,
        });
      }

      const command = JSON.parse(init.body);
      if (href.endsWith('/pipeline')) {
        pipelines.push(command);
        if (command[0]?.[0] === 'SET') {
          return new Response(JSON.stringify([
            { error: 'ERR write failed' },
            ...command.slice(1).map(() => ({ result: 'OK' })),
          ]), { status: 200 });
        }
        return new Response(JSON.stringify(command.map(() => ({ result: 1 }))), { status: 200 });
      }

      return new Response(JSON.stringify({ result: command[0] === 'SET' ? 'OK' : 1 }), {
        status: 200,
      });
    };

    try {
      await assert.rejects(main(), /Redis pipeline: 1\/7 commands failed/);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const setPipeline = pipelines.find((pipeline) => pipeline[0]?.[0] === 'SET');
    assert.ok(setPipeline, 'expected a degraded EIA write');
    const setKeys = setPipeline.map((command) => command[1]);
    assert.equal(EIA_REGIONS.length, 7, 'fixture must represent the complete EIA cohort');
    assert.deepEqual(
      setKeys,
      EIA_REGIONS.map((region) => `${ELECTRICITY_KEY_PREFIX}${region.region}`),
    );
    assert.equal(setKeys.includes(ELECTRICITY_INDEX_KEY), false);
    assert.equal(setKeys.includes(ELECTRICITY_META_KEY), false);
    assert.ok(
      pipelines.some((pipeline) => {
        const expireKeys = pipeline
          .filter((command) => command[0] === 'EXPIRE')
          .map((command) => command[1]);
        return expireKeys.includes(ELECTRICITY_INDEX_KEY)
          && expireKeys.includes(ELECTRICITY_META_KEY);
      }),
      'expected the prior full snapshot and freshness metadata to retain their TTL',
    );
  });

});

// ── main() publication gate ───────────────────────────────────────────────────
//
// Drives the real main() with fetch mocked for Upstash, ENTSO-E and EIA-930
// (same shape as tests/seed-comtrade-bilateral-main.test.mjs) and asserts the
// commands that actually reach Redis. The degraded-write case above covers the
// failure path; these pin the three success shapes of the publication gate so
// a regression in how main() consumes the floor predicate (e.g. restoring the
// old `entsoToken &&` conjunct) cannot ship green.

describe('main() publication gate', () => {
  const REDIS_URL = 'https://fake-upstash.test';
  const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'ENTSO_E_TOKEN', 'EIA_API_KEY', 'PROXY_URL'];
  const ORIGINAL_FETCH = globalThis.fetch;
  const ORIGINAL_ERROR = console.error;
  const ORIGINAL_ENV = {};
  let redisCommands;
  let errors;
  let entsoCalls;
  let entsoStatus;

  function respond(body) {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  function runCommand(cmd) {
    redisCommands.push(cmd);
    switch (cmd[0]) {
      case 'SET': return { result: 'OK' };
      case 'EXPIRE': return { result: 1 };
      case 'EVAL': return { result: 1 };
      default: return { result: null };
    }
  }

  function setsFor(key) {
    return redisCommands.filter((c) => c[0] === 'SET' && c[1] === key);
  }

  function expiredKeys() {
    return redisCommands.filter((c) => c[0] === 'EXPIRE').map((c) => c[1]);
  }

  beforeEach(() => {
    redisCommands = [];
    errors = [];
    entsoCalls = 0;
    entsoStatus = 200;
    for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    process.env.EIA_API_KEY = 'eia-key';
    delete process.env.ENTSO_E_TOKEN;
    delete process.env.PROXY_URL;
    console.error = (...args) => errors.push(args.join(' '));

    globalThis.fetch = async (input, init) => {
      const href = String(input);
      if (href.startsWith(REDIS_URL)) {
        const body = JSON.parse(String(init?.body ?? '[]'));
        // The bare URL takes a single command; /pipeline takes an array of them.
        if (href.endsWith('/pipeline')) return respond(body.map(runCommand));
        return respond(runCommand(body));
      }
      if (href.startsWith('https://api.eia.gov/')) {
        return respond({ response: { data: [{ period: '2026-09-02T05', value: 10271, type: 'D' }] } });
      }
      if (href.startsWith(ENTSO_API_PREFIX)) {
        entsoCalls += 1;
        if (entsoStatus !== 200) return new Response('', { status: entsoStatus });
        return new Response(entsoXml('80.00'), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${href}`);
    };
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.error = ORIGINAL_ERROR;
    for (const key of ENV_KEYS) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
  });

  it('EIA-only run (no ENTSO_E_TOKEN) writes US keys but withholds the index and fresh seed meta', async () => {
    await main();

    assert.equal(entsoCalls, 0);
    for (const { region } of EIA_REGIONS) {
      assert.equal(setsFor(`${ELECTRICITY_KEY_PREFIX}${region}`).length, 1, `expected SET for ${region}`);
    }
    assert.equal(setsFor(ELECTRICITY_INDEX_KEY).length, 0, 'EIA-only run must not publish the EU index');
    assert.equal(setsFor(ELECTRICITY_META_KEY).length, 0, 'EIA-only run must not mark the seed fresh');
    assert.ok(expiredKeys().includes(ELECTRICITY_INDEX_KEY), 'previous index TTL must be extended');
    assert.ok(expiredKeys().includes(ELECTRICITY_META_KEY), 'previous seed meta TTL must be extended');
    assert.ok(
      errors.some((message) => message.includes('ENTSO_E_TOKEN not set')),
      `preserve reason must name the missing token, got: ${errors.join('\n')}`,
    );
  });

  it('full ENTSO-E outage with no proxy preserves the snapshot instead of publishing', async () => {
    process.env.ENTSO_E_TOKEN = 'entso-token';
    entsoStatus = 503;

    await main();

    assert.equal(entsoCalls, 30, '10 regions x 3 direct attempts, no proxy leg');
    assert.equal(setsFor(ELECTRICITY_INDEX_KEY).length, 0);
    assert.equal(setsFor(ELECTRICITY_META_KEY).length, 0);
    assert.equal(setsFor(`${ELECTRICITY_KEY_PREFIX}CISO`).length, 1, 'US keys still refresh below the floor');
    assert.ok(
      errors.some((message) => message.includes('Only 0 ENTSO-E regions returned valid prices')),
      `preserve reason must report the ENTSO-E shortfall, got: ${errors.join('\n')}`,
    );
  });

  it('publishes the index and fresh seed meta once the ENTSO-E floor is met', async () => {
    process.env.ENTSO_E_TOKEN = 'entso-token';

    await main();

    assert.equal(entsoCalls, 10, 'every ENTSO-E region fetched once on direct success');
    assert.equal(setsFor(ELECTRICITY_INDEX_KEY).length, 1);
    const meta = setsFor(ELECTRICITY_META_KEY);
    assert.equal(meta.length, 1, 'a full publish must write fresh seed meta');
    assert.equal(JSON.parse(meta[0][2]).recordCount, 17, '10 ENTSO-E + 7 EIA regions');
    assert.equal(expiredKeys().length, 0, 'a full publish does not fall back to TTL extension');
    assert.equal(errors.length, 0, `no preserve path expected, got: ${errors.join('\n')}`);
  });
});

// ── buildElectricityIndex ─────────────────────────────────────────────────────

describe('buildElectricityIndex', () => {
  function makeRegions(count, base = 100) {
    return Array.from({ length: count }, (_, i) => ({
      region: `R${i}`,
      source: 'entso-e',
      priceMwhEur: base - i,
      priceMwhUsd: null,
      date: '2026-04-05',
      unit: 'EUR/MWh',
      seededAt: new Date().toISOString(),
    }));
  }

  it('returns only regions with valid priceMwhEur, sorted descending', () => {
    const regions = [
      { region: 'DE', source: 'entso-e', priceMwhEur: 87.3, priceMwhUsd: null, date: '2026-04-05', unit: 'EUR/MWh', seededAt: '' },
      { region: 'FR', source: 'entso-e', priceMwhEur: 62.1, priceMwhUsd: null, date: '2026-04-05', unit: 'EUR/MWh', seededAt: '' },
      { region: 'CISO', source: 'eia-930', priceMwhEur: null, priceMwhUsd: null, date: '2026-04-05', unit: 'MWh', seededAt: '' },
    ];
    const index = buildElectricityIndex(regions, '2026-04-05');
    assert.equal(index.regions.length, 2, 'should exclude null priceMwhEur entries');
    assert.equal(index.regions[0].region, 'DE', 'highest price first');
    assert.equal(index.regions[1].region, 'FR', 'second highest price second');
  });

  it('caps at 20 entries', () => {
    const regions = makeRegions(25);
    const index = buildElectricityIndex(regions, '2026-04-05');
    assert.equal(index.regions.length, 20);
  });

  it('returns updatedAt and date fields', () => {
    const regions = makeRegions(3);
    const index = buildElectricityIndex(regions, '2026-04-05');
    assert.ok(typeof index.updatedAt === 'string');
    assert.equal(index.date, '2026-04-05');
    assert.ok(Array.isArray(index.regions));
  });

  it('returns empty regions array when no valid prices exist', () => {
    const regions = [
      { region: 'CISO', source: 'eia-930', priceMwhEur: null, priceMwhUsd: null, date: '2026-04-05', unit: 'MWh', seededAt: '' },
    ];
    const index = buildElectricityIndex(regions, '2026-04-05');
    assert.equal(index.regions.length, 0);
  });
});

// ── Missing ENTSO_E_TOKEN path ────────────────────────────────────────────────

describe('ENTSO_E_TOKEN handling', () => {
  it('ELECTRICITY_INDEX_KEY is defined as a string (token absence not needed at module import level)', () => {
    // The absence-of-token path is a runtime branch in main().
    // We verify the key constant is defined so the module imported cleanly
    // even without ENTSO_E_TOKEN set.
    assert.equal(typeof ELECTRICITY_INDEX_KEY, 'string');
  });
});

// ── Key constants ─────────────────────────────────────────────────────────────

describe('exported key constants', () => {
  it('ELECTRICITY_INDEX_KEY matches expected pattern', () => {
    assert.equal(ELECTRICITY_INDEX_KEY, 'energy:electricity:v1:index');
  });

  it('ELECTRICITY_KEY_PREFIX matches expected pattern', () => {
    assert.equal(ELECTRICITY_KEY_PREFIX, 'energy:electricity:v1:');
  });

  it('ELECTRICITY_TTL_SECONDS is at least 3 days', () => {
    assert.ok(
      ELECTRICITY_TTL_SECONDS >= 3 * 24 * 3600,
      `TTL ${ELECTRICITY_TTL_SECONDS}s is less than 3 days`,
    );
  });
});

// ── EIA region/respondent mapping ────────────────────────────────────────────

describe('EIA_REGIONS respondent codes', () => {
  const EXPECTED = {
    CISO: 'CISO',
    MISO: 'MISO',
    PJM: 'PJM',
    NYISO: 'NYIS',
    ERCO: 'ERCO',
    SPP: 'SWPP',
    ISNE: 'ISNE',
  };

  it('every entry has distinct region and respondent fields', () => {
    for (const entry of EIA_REGIONS) {
      assert.ok(typeof entry.region === 'string' && entry.region.length > 0, `missing region`);
      assert.ok(typeof entry.respondent === 'string' && entry.respondent.length > 0, `missing respondent for ${entry.region}`);
    }
  });

  it('maps public region IDs to correct EIA respondent codes', () => {
    for (const [region, respondent] of Object.entries(EXPECTED)) {
      const entry = EIA_REGIONS.find((r) => r.region === region);
      assert.ok(entry, `missing EIA_REGIONS entry for ${region}`);
      assert.equal(entry.respondent, respondent, `${region} should use respondent ${respondent}, got ${entry.respondent}`);
    }
  });

  it('covers all expected regions', () => {
    const regions = EIA_REGIONS.map((r) => r.region);
    for (const expected of Object.keys(EXPECTED)) {
      assert.ok(regions.includes(expected), `EIA_REGIONS missing ${expected}`);
    }
  });
});

// ── fetchEiaRegion query construction ────────────────────────────────────────
//
// EIA-930 region-data interleaves type=D (Demand), DF (Day-ahead Forecast),
// NG (Net Generation), and TI (Total Interchange) in one series. Without
// frequency=hourly + facets[type][]=D, `length=1 sort=desc` can return a
// forecast/generation/interchange row instead of actual demand — silent data
// corruption that goes undetected because the row still parses.

describe('fetchEiaRegion query construction', () => {
  const REGION = { region: 'ISNE', respondent: 'ISNE', name: 'New England' };
  const TODAY = new Date('2026-05-24T00:00:00Z');

  function mockFetch(response, captured) {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      captured.url = url;
      return response;
    };
    return () => {
      globalThis.fetch = original;
    };
  }

  it('pins frequency=hourly and facets[type][]=D so non-Demand rows cannot win sort=desc', async () => {
    const captured = {};
    const restore = mockFetch(
      {
        ok: true,
        json: async () => ({ response: { data: [{ period: '2026-05-24T05', value: 10271, type: 'D' }] } }),
      },
      captured,
    );
    try {
      await fetchEiaRegion(REGION, 'test-key', TODAY);
    } finally {
      restore();
    }
    const params = new URL(captured.url).searchParams;
    assert.equal(params.get('frequency'), 'hourly', 'must request hourly to avoid daily-aggregate fallback');
    assert.equal(params.get('facets[type][]'), 'D', 'must filter to Demand rows');
    assert.equal(params.get('facets[respondent][]'), 'ISNE');
  });

  it('parses a Demand row into a record with demandMwh + source=eia-930', async () => {
    const restore = mockFetch(
      {
        ok: true,
        json: async () => ({ response: { data: [{ period: '2026-05-24T05', value: 10271, type: 'D' }] } }),
      },
      {},
    );
    let result;
    try {
      result = await fetchEiaRegion(REGION, 'test-key', TODAY);
    } finally {
      restore();
    }
    assert.ok(result, 'expected a record');
    assert.equal(result.region, 'ISNE');
    assert.equal(result.demandMwh, 10271);
    assert.equal(result.source, 'eia-930');
    assert.equal(result.priceMwhEur, null);
  });

  it('anchors the start/end window to the today argument, not wall-clock', async () => {
    // Backfill / test-harness scenario: caller passes a historical `today`.
    // If start were derived from Date.now() it would land after end and EIA
    // would return zero rows silently. Window must be self-consistent with
    // the today argument.
    const historicalToday = new Date('2024-01-15T00:00:00Z');
    const captured = {};
    const restore = mockFetch(
      {
        ok: true,
        json: async () => ({ response: { data: [{ period: '2024-01-15T05', value: 9000, type: 'D' }] } }),
      },
      captured,
    );
    try {
      await fetchEiaRegion(REGION, 'test-key', historicalToday);
    } finally {
      restore();
    }
    const params = new URL(captured.url).searchParams;
    assert.equal(params.get('end'), '2024-01-15');
    assert.equal(params.get('start'), '2024-01-13', 'start must be today-2d, not Date.now()-2d');
  });

  it('returns null when the API returns no data rows', async () => {
    const restore = mockFetch(
      { ok: true, json: async () => ({ response: { data: [] } }) },
      {},
    );
    let result;
    try {
      result = await fetchEiaRegion(REGION, 'test-key', TODAY);
    } finally {
      restore();
    }
    assert.equal(result, null);
  });
});
