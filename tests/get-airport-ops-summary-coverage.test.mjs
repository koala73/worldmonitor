/**
 * Tests for server/worldmonitor/aviation/v1/get-airport-ops-summary.ts
 *
 * Regression coverage for #7106: DEFAULT_WATCHED_AIRPORTS includes ESB and
 * SAW, but the paid AviationStack seed feed (aviation:delays:intl:v3) never
 * covers them. The handler used a response-level "did the cache read
 * succeed" flag to stamp every row's `source`, so an airport with no entry
 * in the seed's `alerts` array was still reported as
 * `source: 'aviationstack', severity: NORMAL` — indistinguishable from a
 * genuinely calm, actually-covered airport. Same #3707 class of bug as
 * list-airport-delays.ts (see list-airport-delays.test.mjs): absence of
 * telemetry must not render as verified health.
 *
 * Run with: npm run test:data -- --test-name-pattern='airport ops summary'
 */

import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let getAirportOpsSummary;
const cacheStore = new Map();
const originalFetch = globalThis.fetch;

before(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';

  mock.method(globalThis, 'fetch', async (url, _init) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const getMatch = urlStr.match(/\/get\/([^/?#]+)$/);
    if (getMatch) {
      const key = decodeURIComponent(getMatch[1]);
      if (cacheStore.has(key)) {
        const stored = cacheStore.get(key);
        return new Response(JSON.stringify({ result: JSON.stringify(stored) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (urlStr.includes('/set/')) {
      return new Response(JSON.stringify({ result: 'OK' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(url, _init);
  });

  const mod = await import('../server/worldmonitor/aviation/v1/get-airport-ops-summary.ts');
  getAirportOpsSummary = mod.getAirportOpsSummary;
});

beforeEach(() => {
  cacheStore.clear();
  // ICAO_API_KEY unset → loadNotamClosures returns null → no NOTAM merge.
  delete process.env.ICAO_API_KEY;
  delete process.env.SEED_FALLBACK_NOTAM;
});

// LHR is a stable member of the paid AviationStack seed feed; ESB/SAW are
// watched by default but not seeded (the #7106 gap). If the seeder's
// coverage ever changes, swap samples — the assertions are structural.
const COVERED_SAMPLE = 'LHR';
const UNCOVERED_SAMPLES = ['ESB', 'SAW'];

describe('getAirportOpsSummary handler — coverage gating (#7106)', () => {
  it('seed cache MISS entirely → every default airport is degraded, not fabricated NORMAL', async () => {
    // No cache set.
    const resp = await getAirportOpsSummary({}, {});
    assert.ok(Array.isArray(resp.summaries) && resp.summaries.length > 0, 'must return some rows');

    for (const s of resp.summaries) {
      assert.equal(s.source, 'degraded',
        `airport ${s.iata}: source must be 'degraded' when the seed cache read fails entirely (was: ${s.source})`);
    }
  });

  it('seed cache HIT with alerts for some airports → covered airport gets aviationstack/NORMAL, uncovered gets unknown/UNKNOWN', async () => {
    cacheStore.set('aviation:delays:intl:v3', {
      alerts: [
        {
          iata: COVERED_SAMPLE,
          delayedFlightsPct: 0,
          avgDelayMinutes: 0,
          cancelledFlights: 0,
          totalFlights: 40,
        },
      ],
    });

    const resp = await getAirportOpsSummary({}, {});

    const covered = resp.summaries.find(s => s.iata === COVERED_SAMPLE);
    assert.ok(covered, `must include ${COVERED_SAMPLE} row`);
    assert.equal(covered.source, 'aviationstack',
      `${COVERED_SAMPLE}: has a real alert row — source must be aviationstack`);
    assert.equal(covered.severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');

    for (const iata of UNCOVERED_SAMPLES) {
      const row = resp.summaries.find(s => s.iata === iata);
      assert.ok(row, `must include ${iata} row (in DEFAULT_WATCHED_AIRPORTS)`);
      assert.equal(row.source, 'unknown',
        `${iata}: seed cache hit but has no alert entry — source must be 'unknown', not 'aviationstack' (#7106)`);
      assert.equal(row.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
        `${iata}: no delay telemetry at all — must not be reported as NORMAL (#7106)`);
    }

    // Critically: no uncovered airport claims the aviationstack source.
    const falselyAttributed = resp.summaries.filter(
      s => UNCOVERED_SAMPLES.includes(s.iata) && s.source === 'aviationstack',
    );
    assert.equal(falselyAttributed.length, 0,
      'no uncovered airport may be attributed to aviationstack');
  });

  it('an empty-but-present alerts array still distinguishes covered-and-calm from uncovered', async () => {
    // A cache hit whose alerts array is empty (no active delays anywhere)
    // still must not blanket-stamp every airport as verified 'aviationstack'
    // -- only the covered ones may be, and here none has a row at all, so
    // every default airport is uncovered-but-cache-reachable.
    cacheStore.set('aviation:delays:intl:v3', { alerts: [] });

    const resp = await getAirportOpsSummary({}, {});
    for (const iata of UNCOVERED_SAMPLES) {
      const row = resp.summaries.find(s => s.iata === iata);
      assert.equal(row.source, 'unknown');
      assert.equal(row.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN');
    }
  });
});
