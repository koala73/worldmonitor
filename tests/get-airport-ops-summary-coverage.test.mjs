/**
 * Tests for server/worldmonitor/aviation/v1/get-airport-ops-summary.ts
 *
 * Regression coverage for #7106: DEFAULT_WATCHED_AIRPORTS includes airports
 * that the AviationStack seeder never covers (their AIRPORTS registry entries
 * do not declare the aviationstack source). Before this fix, an airport with no
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
let defaultWatchedAirports;
let aviationStackSeederIatas;
const cacheStore = new Map();
const originalFetch = globalThis.fetch;

const DELAYS_KEY = 'aviation:delays:intl:v3';
const NOTAM_KEY = 'aviation:notam:closures:v2';
const NOTAM_META_KEY = 'seed-meta:aviation:notam';

function summaryFor(response, iata) {
  const summary = response.summaries.find((row) => row.iata === iata);
  assert.ok(summary, `must include a ${iata} row`);
  return summary;
}

function coverage(iata, status, flightCount = 0) {
  return { iata, status, flightCount, updatedAt: Date.now() };
}

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

  const [handler, shared, seeder] = await Promise.all([
    import('../server/worldmonitor/aviation/v1/get-airport-ops-summary.ts'),
    import('../server/worldmonitor/aviation/v1/_shared.ts'),
    import('../scripts/seed-aviation.mjs'),
  ]);
  getAirportOpsSummary = handler.getAirportOpsSummary;
  defaultWatchedAirports = shared.DEFAULT_WATCHED_AIRPORTS;
  aviationStackSeederIatas = new Set(
    seeder.AIRPORTS
      .filter((airport) => airport.sources.includes('aviationstack'))
      .map((airport) => airport.iata),
  );
});

beforeEach(() => {
  cacheStore.clear();
  delete process.env.ICAO_API_KEY;
  delete process.env.SEED_FALLBACK_NOTAM;
});

describe('getAirportOpsSummary — coverage gating (#7106)', () => {
  it('derives default covered and uncovered airports from the executable seeder registry', async () => {
    const coveredDefaults = defaultWatchedAirports.filter((iata) => aviationStackSeederIatas.has(iata));
    const uncoveredDefaults = defaultWatchedAirports.filter((iata) => !aviationStackSeederIatas.has(iata));

    assert.ok(coveredDefaults.length > 0, 'fixture must include at least one provider-covered default');
    assert.ok(uncoveredDefaults.length > 0, 'fixture must include at least one uncovered default');

    cacheStore.set(DELAYS_KEY, {
      alerts: [],
      coverage: coveredDefaults.map((iata) => coverage(iata, 'normal', 10)),
    });

    // Empty request exercises DEFAULT_WATCHED_AIRPORTS inside the handler.
    const response = await getAirportOpsSummary({}, {});
    assert.deepEqual(
      response.summaries.map((row) => row.iata).sort(),
      [...defaultWatchedAirports].sort(),
      'the default request must return exactly the executable default set',
    );

    for (const iata of coveredDefaults) {
      const row = summaryFor(response, iata);
      assert.equal(row.severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');
      assert.equal(row.source, 'aviationstack');
    }
    for (const iata of uncoveredDefaults) {
      const row = summaryFor(response, iata);
      assert.equal(row.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
        `${iata}: absent from the seeder AviationStack registry, must not report NORMAL`);
      assert.equal(row.source, 'unknown',
        `${iata}: must not be falsely attributed to AviationStack`);
    }
  });

  it('preserves a disruption alert for a covered airport', async () => {
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
    cacheStore.set(DELAYS_KEY, {
      alerts: [lhrAlert],
      coverage: [coverage('LHR', 'disruption', 40)],
    });

    const response = await getAirportOpsSummary({}, { airports: 'LHR' });
    const lhr = summaryFor(response, 'LHR');
    assert.equal(response.cacheHit, false,
      'the response is composed from independent seed reads, not served from a response cache');
    assert.equal(lhr.source, 'aviationstack');
    assert.equal(lhr.delayPct, 35);
    assert.equal(lhr.avgDelayMinutes, 60);
    assert.equal(lhr.totalFlights, 40);
    assert.equal(lhr.severity, 'FLIGHT_DELAY_SEVERITY_SEVERE');
    assert.deepEqual(lhr.topDelayReasons, ['WX']);
  });

  for (const status of ['omitted', 'failed']) {
    it(`treats producer coverage status ${status} as UNKNOWN`, async () => {
      cacheStore.set(DELAYS_KEY, {
        alerts: [],
        coverage: [coverage('LHR', status)],
      });

      const response = await getAirportOpsSummary({}, { airports: 'LHR' });
      const lhr = summaryFor(response, 'LHR');
      assert.equal(lhr.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN');
      assert.equal(lhr.source, 'unknown');
      assert.equal(lhr.totalFlights, 0);
    });
  }

  it('treats a provider airport missing from this tick\'s coverage rows as UNKNOWN', async () => {
    cacheStore.set(DELAYS_KEY, {
      alerts: [],
      coverage: [coverage('FRA', 'normal', 50)],
    });

    const response = await getAirportOpsSummary({}, { airports: 'LHR' });
    const lhr = summaryFor(response, 'LHR');
    assert.equal(lhr.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN');
    assert.equal(lhr.source, 'unknown');
  });

  it('legacy coverage-less seed payload (alerts only, no coverage field) treats every airport as uncovered', async () => {
    cacheStore.set(DELAYS_KEY, { alerts: [] });

    const response = await getAirportOpsSummary({}, { airports: 'LHR' });
    const lhr = summaryFor(response, 'LHR');
    assert.equal(lhr.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
      'no coverage array at all — must fail closed instead of assuming every hub is healthy');
    assert.equal(lhr.source, 'unknown');
  });

  it('total delay-cache miss reports degraded UNKNOWN', async () => {
    const response = await getAirportOpsSummary({}, { airports: 'LHR' });
    const lhr = summaryFor(response, 'LHR');
    assert.equal(lhr.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN');
    assert.equal(lhr.source, 'degraded');
  });

  it('an ordinary UI-reachable unmonitored IATA reports UNKNOWN', async () => {
    cacheStore.set(DELAYS_KEY, { alerts: [], coverage: [] });

    const response = await getAirportOpsSummary({}, { airports: 'NCL' });
    const ncl = summaryFor(response, 'NCL');
    assert.equal(ncl.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN');
    assert.equal(ncl.source, 'unknown');
    assert.equal(ncl.totalFlights, 0);
  });

  it('preserves independent NOTAM closure and restriction signals for uncovered airports', async () => {
    cacheStore.set(DELAYS_KEY, { alerts: [], coverage: [] });
    cacheStore.set(NOTAM_META_KEY, { fetchedAt: Date.now() });
    cacheStore.set(NOTAM_KEY, {
      closedIcaos: ['LTAC'],
      restrictedIcaos: ['LTFJ'],
      reasons: {
        LTAC: 'Aerodrome closed by active NOTAM',
        LTFJ: 'Runway access restricted by active NOTAM',
      },
    });

    const response = await getAirportOpsSummary({}, { airports: 'ESB,SAW' });
    const esb = summaryFor(response, 'ESB');
    assert.equal(esb.severity, 'FLIGHT_DELAY_SEVERITY_SEVERE');
    assert.equal(esb.closureStatus, true);
    assert.deepEqual(esb.notamFlags, ['CLOSED', 'NOTAM']);
    assert.deepEqual(esb.topDelayReasons, ['Aerodrome closed by active NOTAM']);
    assert.equal(esb.source, 'unknown');

    const saw = summaryFor(response, 'SAW');
    assert.equal(saw.severity, 'FLIGHT_DELAY_SEVERITY_MINOR');
    assert.equal(saw.closureStatus, false);
    assert.deepEqual(saw.notamFlags, ['RESTRICTED', 'NOTAM']);
    assert.deepEqual(saw.topDelayReasons, ['Runway access restricted by active NOTAM']);
    assert.equal(saw.source, 'unknown');
  });
});
