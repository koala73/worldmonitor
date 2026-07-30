import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as portwatchSeed from '../scripts/seed-portwatch-port-activity.mjs';

const { orderColdFetchQueue } = portwatchSeed;
const DAY = 86_400_000;

function cachedCountry(iso2, cacheWrittenAt = 0) {
  return {
    iso2,
    prevPayload: {
      iso2,
      ports: [{ portId: `${iso2}-port` }],
      asof: '2026-07-24',
      cacheWrittenAt,
    },
  };
}

describe('PortWatch cold-fetch recovery rotation', () => {
  it('attempts all 174 countries within six 30-country runs', () => {
    const countries = Array.from({ length: 174 }, (_, index) =>
      cachedCountry(`C${String(index).padStart(3, '0')}`),
    );
    const attempted = new Set();

    for (let run = 1; run <= 6; run += 1) {
      const selected = orderColdFetchQueue(countries).slice(0, 30);
      const attemptedAt = run * 1_000;
      for (const item of selected) {
        attempted.add(item.iso2);
        item.prevPayload.cacheWrittenAt = attemptedAt;
        item.prevPayload.refreshAttemptedAt = attemptedAt;
      }
    }

    assert.equal(
      attempted.size,
      countries.length,
      'the scheduler must finish a durable sweep instead of reselecting recent work',
    );
  });

  it('does not let partial failures monopolize the next capped run', () => {
    const countries = Array.from({ length: 40 }, (_, index) =>
      cachedCountry(`C${String(index).padStart(2, '0')}`),
    );
    const first = orderColdFetchQueue(countries).slice(0, 10);
    const firstIds = new Set(first.map((item) => item.iso2));

    for (const [index, item] of first.entries()) {
      item.prevPayload.refreshAttemptedAt = 1_000;
      if (index >= 3) item.prevPayload.cacheWrittenAt = 1_000;
    }

    const second = orderColdFetchQueue(countries).slice(0, 10);
    assert.ok(
      second.every((item) => !firstIds.has(item.iso2)),
      'failed attempts must rotate behind countries that have not received a slot',
    );
  });
});

describe('PortWatch last-good and gap reporting', () => {
  it('serves only caches strictly inside the seven-day boundary', () => {
    const classify = portwatchSeed.classifyDeferredPayload;
    assert.equal(typeof classify, 'function');
    const now = 10 * DAY;

    const usable = classify(cachedCountry('US', now - 7 * DAY + 1).prevPayload, now);
    assert.equal(usable.status, 'stale');
    assert.equal(usable.payload.staleAsof, true);

    assert.deepEqual(
      classify(cachedCountry('CY', now - 7 * DAY).prevPayload, now),
      { status: 'expired', payload: null },
    );
    assert.deepEqual(classify(null, now), { status: 'missing', payload: null });
  });

  it('records a failed attempt without refreshing the last-good data age', () => {
    const buildFailure = portwatchSeed.buildRefreshFailureState;
    assert.equal(typeof buildFailure, 'function');
    const now = 10 * DAY;
    const item = cachedCountry('CY', now - 6 * DAY);
    item.prevPayload.refreshFailure = {
      code: 'timeout',
      consecutiveFailures: 1,
      lastAttemptAt: now - DAY,
    };

    const state = buildFailure(item, new Error('per-country timeout after 90s'), now);
    assert.equal(state.cacheWrittenAt, now - 6 * DAY, 'failure must not make stale data fresh');
    assert.equal(state.refreshAttemptedAt, now);
    assert.deepEqual(state.refreshFailure, {
      code: 'timeout',
      consecutiveFailures: 2,
      lastAttemptAt: now,
    });

    const report = portwatchSeed.buildCoverageReport({
      eligibleCountries: ['US', 'CY'],
      countryData: new Map([['US', cachedCountry('US', now).prevPayload]]),
      retryState: new Map([['CY', state]]),
    });
    assert.deepEqual(report.missingCountries, ['CY']);
    assert.deepEqual(report.refreshFailures, [{ iso2: 'CY', code: 'timeout' }]);
    assert.equal(report.complete, false);
  });

  it('reports a truncated reference feed against the durable country target', () => {
    const report = portwatchSeed.buildCoverageReport({
      eligibleCountries: ['US'],
      expectedCountries: ['US', 'CY'],
      countryData: new Map([['US', cachedCountry('US', 10 * DAY).prevPayload]]),
    });

    assert.equal(report.target, 174);
    assert.equal(report.referenceCountryCount, 1);
    assert.equal(report.published, 1);
    assert.equal(report.complete, false);
    assert.deepEqual(report.missingCountries, ['CY']);
    assert.equal(report.unidentifiedMissingCount, 172);
  });

  it('classifies the root cause before transport wording in composite errors', () => {
    const invalidQueryState = portwatchSeed.buildRefreshFailureState(
      cachedCountry('US'),
      new Error('ArcGIS error (via proxy after timeout): Invalid query parameters'),
      10 * DAY,
    );
    const rateLimitedState = portwatchSeed.buildRefreshFailureState(
      cachedCountry('CY'),
      new Error('Proxy timeout after upstream HTTP 429 rate limit'),
      10 * DAY,
    );

    assert.equal(invalidQueryState.refreshFailure.code, 'invalid_query');
    assert.equal(rateLimitedState.refreshFailure.code, 'rate_limited');
  });
});

describe('PortWatch canonical reference guard', () => {
  it('refuses to publish a shrunken canonical when the reference feed is partial', () => {
    assert.equal(portwatchSeed.shouldAdvanceCanonicalForRun({
      countryCount: 153,
      previousCountryCount: 174,
      referenceCountryCount: 153,
      capTriggered: true,
      upstreamContactCount: 30,
    }), false);
  });
});

describe('PortWatch atomic publication', () => {
  function publicationInput() {
    const now = 10 * DAY;
    return {
      countryData: new Map([['US', cachedCountry('US', now).prevPayload]]),
      retryState: new Map([['CY', {
        ...cachedCountry('CY', now - 8 * DAY).prevPayload,
        refreshAttemptedAt: now,
        refreshFailure: {
          code: 'timeout',
          consecutiveFailures: 2,
          lastAttemptAt: now,
        },
      }]]),
      countries: ['US'],
      metaPayload: {
        fetchedAt: now,
        recordCount: 1,
        coverage: {
          target: 2,
          published: 1,
          complete: false,
          missingCountries: ['CY'],
          refreshFailures: [{ iso2: 'CY', code: 'timeout' }],
        },
      },
      canonicalAdvances: true,
    };
  }

  it('commits country state, canonical, and seed-meta through one transaction', async () => {
    const publish = portwatchSeed.publishPortActivitySnapshot;
    assert.equal(typeof publish, 'function');
    const calls = [];
    const fetchFn = async (url, init) => {
      const commands = JSON.parse(init.body);
      calls.push({ url: String(url), commands });
      return new Response(JSON.stringify(commands.map(() => ({ result: 'OK' }))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await publish(publicationInput(), {
      fetchFn,
      credentials: { url: 'https://redis.example.test', token: 'token' },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://redis.example.test/multi-exec');
    assert.deepEqual(
      calls[0].commands.map((command) => command[1]),
      [
        'supply_chain:portwatch-ports:v1:CY',
        'supply_chain:portwatch-ports:v1:US',
        'supply_chain:portwatch-ports:v1:_countries',
        'seed-meta:supply_chain:portwatch-ports',
      ],
    );
  });

  it('preserves the last-good canonical and seed-meta below the publish floor', async () => {
    const publish = portwatchSeed.publishPortActivitySnapshot;
    assert.equal(typeof publish, 'function');
    const calls = [];
    const fetchFn = async (_url, init) => {
      const commands = JSON.parse(init.body);
      calls.push(commands);
      return new Response(JSON.stringify(commands.map(() => ({ result: 'OK' }))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const input = publicationInput();
    input.countryData = new Map();
    input.countries = [];
    input.canonicalAdvances = false;

    await publish(input, {
      fetchFn,
      credentials: { url: 'https://redis.example.test', token: 'token' },
    });

    assert.ok(
      calls[0].every((command) =>
        command[1] !== 'supply_chain:portwatch-ports:v1:_countries'
        && command[1] !== 'seed-meta:supply_chain:portwatch-ports'),
    );
    assert.deepEqual(
      calls[0].map((command) => command[1]),
      ['supply_chain:portwatch-ports:v1:CY'],
      'scheduler-only failure state must persist even with zero publishable countries',
    );
  });

  it('fails loudly when any transaction command reports an error', async () => {
    const publish = portwatchSeed.publishPortActivitySnapshot;
    assert.equal(typeof publish, 'function');
    const fetchFn = async (_url, init) => {
      const commands = JSON.parse(init.body);
      return new Response(JSON.stringify(
        commands.map((_, index) => index === 1 ? { error: 'ERR injected' } : { result: 'OK' }),
      ), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await assert.rejects(
      publish(publicationInput(), {
        fetchFn,
        credentials: { url: 'https://redis.example.test', token: 'token' },
      }),
      /transaction: 1\/4 commands failed/,
    );
  });
});
