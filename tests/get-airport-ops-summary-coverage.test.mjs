/**
 * Tests for server/worldmonitor/aviation/v1/get-airport-ops-summary.ts
 *
 * Regression coverage for #7106: DEFAULT_WATCHED_AIRPORTS includes ESB and SAW,
 * which the AviationStack seeder never covers (they're absent from
 * AVIATIONSTACK_AIRPORTS entirely). Before this fix, an airport with no
 * matching entry in the seed's `alerts` array still got a zero-filled
 * 'FLIGHT_DELAY_SEVERITY_NORMAL' / source: 'aviationstack' row -- falsely
 * attributing "confirmed calm" to a provider that was never asked about it.
 *
 * Mirrors the mocking approach used in list-airport-delays.test.mjs (#3707):
 * stub the Upstash REST GET/SET boundary getCachedJson uses, rather than
 * trying to replace exports on a real ESM module.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let getAirportOpsSummary;
const cacheStore = new Map();
const originalFetch = globalThis.fetch;

before(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  process.env.VERCEL_ENV = 'production';

  globalThis.fetch = async (url, _init) => {
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
  };

  const mod = await import('../server/worldmonitor/aviation/v1/get-airport-ops-summary.ts');
  getAirportOpsSummary = mod.getAirportOpsSummary;
});

beforeEach(() => {
  cacheStore.clear();
  delete process.env.ICAO_API_KEY;
  delete process.env.SEED_FALLBACK_NOTAM;
});

describe('getAirportOpsSummary — coverage gating (#7106)', () => {
  it('airport outside AVIATIONSTACK_AIRPORTS (ESB, SAW) reports UNKNOWN, not fabricated NORMAL', async () => {
    // Seed hit, but only for the four hubs AviationStack actually covers.
    cacheStore.set('aviation:delays:intl:v3', {
      alerts: [],
      coverage: [
        { iata: 'IST', status: 'normal', flightCount: 40 },
        { iata: 'LHR', status: 'normal', flightCount: 55 },
        { iata: 'FRA', status: 'normal', flightCount: 50 },
        { iata: 'CDG', status: 'normal', flightCount: 48 },
      ],
    });

    const resp = await getAirportOpsSummary({}, { airports: 'IST,ESB,SAW,LHR,FRA,CDG' });

    const esb = resp.summaries.find((s) => s.iata === 'ESB');
    const saw = resp.summaries.find((s) => s.iata === 'SAW');
    assert.ok(esb, 'must include an ESB row');
    assert.ok(saw, 'must include a SAW row');

    for (const row of [esb, saw]) {
      assert.equal(row.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
        `${row.iata}: not in AVIATIONSTACK_AIRPORTS, must not report NORMAL`);
      assert.equal(row.source, 'unknown',
        `${row.iata}: must not be falsely attributed to 'aviationstack'`);
    }

    // The actually-covered peers keep reporting normal/aviationstack as before.
    const ist = resp.summaries.find((s) => s.iata === 'IST');
    assert.equal(ist.severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');
    assert.equal(ist.source, 'aviationstack');
  });

  it('a hub omitted from this tick\'s coverage report (even if in AVIATIONSTACK_AIRPORTS) stays UNKNOWN', async () => {
    cacheStore.set('aviation:delays:intl:v3', {
      alerts: [],
      coverage: [
        { iata: 'LHR', status: 'omitted', flightCount: 0 },
        { iata: 'FRA', status: 'normal', flightCount: 50 },
      ],
    });

    const resp = await getAirportOpsSummary({}, { airports: 'LHR,FRA' });

    const lhr = resp.summaries.find((s) => s.iata === 'LHR');
    assert.equal(lhr.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
      'LHR omitted this tick — must not fall back to a fabricated NORMAL');
    assert.equal(lhr.source, 'unknown');

    const fra = resp.summaries.find((s) => s.iata === 'FRA');
    assert.equal(fra.severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');
    assert.equal(fra.source, 'aviationstack');
  });

  it('legacy coverage-less seed payload (alerts only, no coverage field) treats every airport as uncovered', async () => {
    cacheStore.set('aviation:delays:intl:v3', { alerts: [] });

    const resp = await getAirportOpsSummary({}, { airports: 'LHR' });
    const lhr = resp.summaries.find((s) => s.iata === 'LHR');
    assert.equal(lhr.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
      'no coverage array at all — must fail closed instead of assuming every hub is healthy');
    assert.equal(lhr.source, 'unknown');
  });

  it('a real alert for a covered airport is still reported verbatim', async () => {
    const lhrAlert = {
      id: 'as-LHR',
      iata: 'LHR',
      icao: 'EGLL',
      delayedFlightsPct: 35,
      avgDelayMinutes: 60,
      cancelledFlights: 2,
      totalFlights: 40,
      reason: 'WX',
    };
    cacheStore.set('aviation:delays:intl:v3', {
      alerts: [lhrAlert],
      coverage: [{ iata: 'LHR', status: 'disruption', flightCount: 40 }],
    });

    const resp = await getAirportOpsSummary({}, { airports: 'LHR' });
    const lhr = resp.summaries.find((s) => s.iata === 'LHR');
    assert.equal(lhr.source, 'aviationstack');
    assert.equal(lhr.delayPct, 35);
    assert.notEqual(lhr.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
      'a real alert must produce a real (non-UNKNOWN) severity');
  });
});
