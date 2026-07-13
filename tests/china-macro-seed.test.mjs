import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  OECD_MAX_REQUESTS_PER_RUN,
  buildChinaMacroSnapshot,
  fetchChinaMacroSnapshot,
  parseBisPolicy,
  parseFredUsdCny,
  parseHkmaCnyContext,
  parseOecdCsvIndicator,
} from '../scripts/china-macro/adapters.mjs';
import { chinaMacroContentMeta, validateChinaMacroSnapshot } from '../scripts/seed-china-macro.mjs';

const fixture = (name) => readFileSync(resolve(import.meta.dirname, 'fixtures/china-macro', name), 'utf8');
const now = Date.parse('2026-07-13T00:00:00Z');

describe('China macro source adapters', () => {
  it('normalizes OECD, BIS, FRED, and optional HKMA values with independent prior/date/source fields', () => {
    const cpi = parseOecdCsvIndicator(fixture('oecd-cpi.csv'), {
      id: 'cpi_yoy', label: 'CPI (YoY)', category: 'price', unit: '%', source: 'OECD Data Explorer', maxAgeDays: 120,
    }, now);
    const cli = parseOecdCsvIndicator(fixture('oecd-cli.csv'), {
      id: 'activity_cli', label: 'Composite Leading Indicator', category: 'activity', unit: 'index', source: 'OECD Data Explorer', maxAgeDays: 120,
    }, now);
    const policy = parseBisPolicy(JSON.parse(fixture('bis-policy.json')), now);
    const fx = parseFredUsdCny(JSON.parse(fixture('fred-dexchus.json')), now);
    const hkma = parseHkmaCnyContext(JSON.parse(fixture('hkma-cny.json')), now);

    assert.deepEqual(
      { value: cpi.value, priorValue: cpi.priorValue, observationDate: cpi.observationDate, source: cpi.source, stale: cpi.stale, unavailableReason: cpi.unavailableReason },
      { value: 0.6, priorValue: 0.3, observationDate: '2026-05', source: 'OECD Data Explorer', stale: false, unavailableReason: '' },
    );
    assert.equal(cli.value, 99.58);
    assert.equal(policy.value, 3);
    assert.equal(policy.priorValue, 3.1);
    assert.equal(fx.value, 7.1842);
    assert.equal(hkma.contextOnly, true);
    assert.equal(hkma.source, 'HKMA (Hong Kong/CNH context)');
  });

  it('anchors monthly content health at month end rather than the first day', () => {
    const meta = chinaMacroContentMeta({ launchReady: true, contentObservationDate: '2026-06' });
    assert.equal(meta.newestItemAt, Date.parse('2026-06-30T23:59:59.000Z'));
    assert.equal(meta.oldestItemAt, meta.newestItemAt);
  });

  it('marks an old observation stale even when the fetch itself is fresh', () => {
    const stale = parseOecdCsvIndicator(fixture('oecd-cpi.csv'), {
      id: 'cpi_yoy', label: 'CPI (YoY)', category: 'price', unit: '%', source: 'OECD Data Explorer', maxAgeDays: 30,
    }, Date.parse('2027-01-01T00:00:00Z'));
    assert.equal(stale.stale, true);
    assert.equal(stale.unavailableReason, 'STALE_OBSERVATION');
  });

  it('launches only with current price, activity, policy, and FX while retaining mixed optional states', () => {
    const snapshot = buildChinaMacroSnapshot({
      indicators: [
        parseOecdCsvIndicator(fixture('oecd-cpi.csv'), { id: 'cpi_yoy', label: 'CPI (YoY)', category: 'price', unit: '%', source: 'OECD Data Explorer', maxAgeDays: 120 }, now),
        parseOecdCsvIndicator(fixture('oecd-cli.csv'), { id: 'activity_cli', label: 'CLI', category: 'activity', unit: 'index', source: 'OECD Data Explorer', maxAgeDays: 120 }, now),
        parseBisPolicy(JSON.parse(fixture('bis-policy.json')), now),
        parseFredUsdCny(JSON.parse(fixture('fred-dexchus.json')), now),
        { id: 'cnh_context', label: 'CNH context', category: 'context', value: null, priorValue: null, unit: 'HKD/CNY', observationDate: '', source: 'HKMA (Hong Kong/CNH context)', sourceUrl: 'https://api.hkma.gov.hk/', stale: false, unavailableReason: 'HOST_BLOCKED', contextOnly: true },
      ],
      sourceDecisions: [],
      generatedAt: new Date(now).toISOString(),
    });
    assert.equal(snapshot.launchReady, true);
    assert.equal(snapshot.status, 'ready');
    assert.equal(validateChinaMacroSnapshot(snapshot), true);
    assert.equal(snapshot.indicators.at(-1).unavailableReason, 'HOST_BLOCKED');

    snapshot.indicators.find((item) => item.category === 'activity').stale = true;
    const degradedSnapshot = buildChinaMacroSnapshot({ indicators: snapshot.indicators, sourceDecisions: [], generatedAt: snapshot.generatedAt });
    assert.equal(degradedSnapshot.launchReady, false);
    assert.equal(validateChinaMacroSnapshot(degradedSnapshot), false);
  });

  it('bounds OECD to consolidated dataset requests and rejects rate limits so runSeed preserves last-good', async () => {
    assert.equal(OECD_MAX_REQUESTS_PER_RUN, 2);
    const decisions = [];
    let rejectedError;
    await assert.rejects(
      fetchChinaMacroSnapshot({
        now,
        fetchFn: async (url) => {
          if (String(url).includes('sdmx.oecd.org')) return new Response('rate limited', { status: 429 });
          throw new Error(`unexpected request ${url}`);
        },
        readCachedFn: async () => JSON.parse(fixture('bis-policy.json')),
        fredFetchFn: async () => JSON.parse(fixture('fred-dexchus.json')),
        onDecision: (decision) => decisions.push(decision),
      }),
      (error) => {
        rejectedError = error;
        return /OECD_REQUIRED_SOURCE_UNAVAILABLE/.test(error.message);
      },
    );
    assert.equal(decisions[0].status, 'blocked');
    assert.equal(decisions[0].reason, 'HTTP_429');
    assert.equal(decisions[0].requestCount, 1);
    assert.equal(rejectedError.nonRetryable, true);
  });

  it('sets the OECD language header required by the live CLI endpoint', async () => {
    const oecdHeaders = [];
    const snapshot = await fetchChinaMacroSnapshot({
      now,
      fetchFn: async (url, options) => {
        if (String(url).includes('DF_G20_PRICES')) {
          oecdHeaders.push(options.headers);
          return new Response(fixture('oecd-cpi.csv'));
        }
        if (String(url).includes('DF_CLI')) {
          oecdHeaders.push(options.headers);
          return new Response(fixture('oecd-cli.csv'));
        }
        return new Response(fixture('hkma-cny.json'), { headers: { 'Content-Type': 'application/json' } });
      },
      readCachedFn: async () => JSON.parse(fixture('bis-policy.json')),
      fredFetchFn: async () => JSON.parse(fixture('fred-dexchus.json')),
      onDecision: () => {},
    });
    assert.equal(snapshot.launchReady, true);
    assert.equal(oecdHeaders.length, OECD_MAX_REQUESTS_PER_RUN);
    assert.ok(oecdHeaders.every((headers) => headers['Accept-Language'] === 'en'));
  });

  it('routes production FRED requests through the Railway proxy helper', async () => {
    const originalKey = process.env.FRED_API_KEY;
    process.env.FRED_API_KEY = 'test-key';
    let proxyAuth = null;
    try {
      const snapshot = await fetchChinaMacroSnapshot({
        now,
        fetchFn: async (url) => {
          if (String(url).includes('DF_G20_PRICES')) return new Response(fixture('oecd-cpi.csv'));
          if (String(url).includes('DF_CLI')) return new Response(fixture('oecd-cli.csv'));
          return new Response(fixture('hkma-cny.json'), { headers: { 'Content-Type': 'application/json' } });
        },
        readCachedFn: async () => JSON.parse(fixture('bis-policy.json')),
        fredFetchJsonFn: async (_url, resolvedProxy) => {
          proxyAuth = resolvedProxy;
          return JSON.parse(fixture('fred-dexchus.json'));
        },
        fredProxyFn: () => 'proxy-auth',
        onDecision: () => {},
      });
      assert.equal(snapshot.launchReady, true);
      assert.equal(proxyAuth, 'proxy-auth');
    } finally {
      if (originalKey === undefined) delete process.env.FRED_API_KEY;
      else process.env.FRED_API_KEY = originalKey;
    }
  });
});
