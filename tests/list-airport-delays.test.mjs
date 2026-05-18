/**
 * Tests for server/worldmonitor/aviation/v1/list-airport-delays.ts
 *
 * Regression coverage for #3707: airports without telemetry must NOT be
 * published as "Normal operations / FLIGHT_DELAY_SEVERITY_NORMAL" rows.
 *
 * The handler reads two seed-backed caches:
 *   aviation:delays:faa:v1   — FAA ASWS aggregates for US airports
 *   aviation:delays:intl:v3  — AviationStack aggregates for ~51 intl airports
 *
 * Coverage for a monitored airport is determined by whether its primary
 * source's cache hit (returned a valid alerts array). Cache misses must
 * emit FLIGHT_DELAY_SEVERITY_UNKNOWN rows so consumers can render "no data"
 * rather than a misleading green "Normal" pill.
 *
 * The fourth source (NOTAM) only contributes closures/restrictions — it never
 * confirms "normal operations" for an airport — so NOTAM-only airports must
 * stay UNKNOWN when no NOTAM applies to them.
 *
 * Run with: npm run test:data -- --test-name-pattern="airport delays"
 */

import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ────────────────────────────────────────────────────────────────────────────
// 1. Static source guarantees — cheap regression net independent of runtime.
// ────────────────────────────────────────────────────────────────────────────

describe('list-airport-delays: source structure (regression net for #3707)', () => {
  const src = readFileSync(
    resolve(root, 'server/worldmonitor/aviation/v1/list-airport-delays.ts'),
    'utf-8',
  );

  it('tracks faaSourceCovered + intlSourceCovered booleans', () => {
    assert.match(src, /faaSourceCovered\s*=\s*false/);
    assert.match(src, /intlSourceCovered\s*=\s*false/);
    assert.match(src, /faaSourceCovered\s*=\s*true/);
    assert.match(src, /intlSourceCovered\s*=\s*true/);
  });

  it('emits an UNKNOWN row for airports whose source did not hit', () => {
    assert.match(src, /toProtoSeverity\(\s*['"]unknown['"]\s*\)/);
    assert.match(src, /toProtoSource\(\s*['"]unspecified['"]\s*\)/);
    assert.match(src, /Coverage unavailable/);
    // Sanity: the unknown row uses the dedicated id prefix, not the legacy
    // status-${iata} id which now means "covered + healthy".
    assert.match(src, /unknown-\$\{airport\.iata\}/);
  });

  it('does NOT publish "Normal operations" rows blindly for every monitored airport', () => {
    // The pre-fix bug: the loop unconditionally pushed a NORMAL/computed row
    // for every airport not in alertedIatas. The fix gates that branch on
    // a `covered` flag derived from the two source booleans. Verify both
    // gating ingredients are present in the source.
    assert.match(src, /FAA_AIRPORT_SET\.has\(airport\.iata\)\s*&&\s*faaSourceCovered/);
    assert.match(src, /INTL_AIRPORT_SET\.has\(airport\.iata\)\s*&&\s*intlSourceCovered/);
    assert.match(src, /if\s*\(\s*covered\s*\)/);
  });

  it('sources NORMAL rows to their actual upstream (faa | aviationstack), not "computed"', () => {
    // The pre-fix bug also obscured provenance by tagging synthetic rows
    // as FLIGHT_DELAY_SOURCE_COMPUTED. Now the source must match the cache
    // that actually returned the data — easier to debug seeder regressions.
    assert.match(src, /toProtoSource\(\s*isFaaCovered\s*\?\s*['"]faa['"]\s*:\s*['"]aviationstack['"]\s*\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Proto wiring — the new enum variant must exist in both .proto + .ts.
// ────────────────────────────────────────────────────────────────────────────

describe('FlightDelaySeverity proto enum carries an UNKNOWN variant (#3707)', () => {
  it('proto/.../airport_delay.proto declares FLIGHT_DELAY_SEVERITY_UNKNOWN', () => {
    const protoSrc = readFileSync(
      resolve(root, 'proto/worldmonitor/aviation/v1/airport_delay.proto'),
      'utf-8',
    );
    assert.match(protoSrc, /FLIGHT_DELAY_SEVERITY_UNKNOWN\s*=\s*6/);
    // Comment must call out the semantics so future hands don't drop it.
    assert.match(protoSrc, /no telemetry/i);
  });

  it('generated server type union includes FLIGHT_DELAY_SEVERITY_UNKNOWN', () => {
    const serverGen = readFileSync(
      resolve(root, 'src/generated/server/worldmonitor/aviation/v1/service_server.ts'),
      'utf-8',
    );
    assert.match(serverGen, /"FLIGHT_DELAY_SEVERITY_UNKNOWN"/);
  });

  it('generated client type union includes FLIGHT_DELAY_SEVERITY_UNKNOWN', () => {
    const clientGen = readFileSync(
      resolve(root, 'src/generated/client/worldmonitor/aviation/v1/service_client.ts'),
      'utf-8',
    );
    assert.match(clientGen, /"FLIGHT_DELAY_SEVERITY_UNKNOWN"/);
  });

  it('_shared.toProtoSeverity maps "unknown" -> FLIGHT_DELAY_SEVERITY_UNKNOWN', () => {
    const sharedSrc = readFileSync(
      resolve(root, 'server/worldmonitor/aviation/v1/_shared.ts'),
      'utf-8',
    );
    assert.match(sharedSrc, /unknown:\s*'FLIGHT_DELAY_SEVERITY_UNKNOWN'/);
    assert.match(sharedSrc, /unspecified:\s*'FLIGHT_DELAY_SOURCE_UNSPECIFIED'/);
  });

  it('client adapter (src/services/aviation) exposes the "unknown" display severity', () => {
    const svc = readFileSync(resolve(root, 'src/services/aviation/index.ts'), 'utf-8');
    assert.match(svc, /export type FlightDelaySeverity\s*=[^;]*'unknown'/);
    assert.match(svc, /FLIGHT_DELAY_SEVERITY_UNKNOWN:\s*'unknown'/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. UI guarantees — switches on severity must handle 'unknown' explicitly.
// ────────────────────────────────────────────────────────────────────────────

describe('UI consumers handle the "unknown" severity (#3707)', () => {
  it('AirlineIntelPanel SEVERITY_COLOR has an "unknown" key (neutral, not green)', () => {
    const panel = readFileSync(resolve(root, 'src/components/AirlineIntelPanel.ts'), 'utf-8');
    // The map type is Record<FlightDelaySeverity, string> — TS would reject
    // omission at compile time, but assert the presence explicitly so a
    // future relax of the type doesn't silently drop the entry.
    assert.match(panel, /unknown:\s*['"]#9ca3af['"]/);
  });

  it('DeckGLMap createFlightDelaysLayer branches on severity === "unknown"', () => {
    const deck = readFileSync(resolve(root, 'src/components/DeckGLMap.ts'), 'utf-8');
    assert.match(deck, /d\.severity === ['"]unknown['"]/);
  });

  it('GlobeMap flightDelay marker handles severity === "unknown"', () => {
    const globe = readFileSync(resolve(root, 'src/components/GlobeMap.ts'), 'utf-8');
    assert.match(globe, /d\.severity === ['"]unknown['"]/);
  });

  it('MapPopup renders "NO DATA" for unknown severity (not "UNKNOWN" / not the green NORMAL pill)', () => {
    const popup = readFileSync(resolve(root, 'src/components/MapPopup.ts'), 'utf-8');
    assert.match(popup, /delay\.severity === ['"]unknown['"]/);
    assert.match(popup, /NO DATA/);
  });

  it('main.css has a flight-delay-marker.unknown rule (neutral grey)', () => {
    const css = readFileSync(resolve(root, 'src/styles/main.css'), 'utf-8');
    assert.match(css, /\.flight-delay-marker\.unknown/);
    assert.match(css, /\.popup-header\.flight\.unknown/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Behavioural — actually invoke the handler against stubbed Redis.
//    These are the regression tests the bug report would catch.
// ────────────────────────────────────────────────────────────────────────────

// We can't replace exports on a real ESM module (TypeError: Cannot redefine
// property), so instead we stub at the HTTP boundary the redis helper uses:
// Upstash REST GET/SET via globalThis.fetch. The handler reads:
//   getCachedJson('aviation:delays:faa:v1', true)
//   getCachedJson('aviation:delays:intl:v3')
//   getCachedJson('seed-meta:aviation:notam', true)
//   getCachedJson('aviation:notam:closures:v2', true)
// and calls setCachedJson on the bootstrap key (we ignore writes).
// loadNotamClosures also touches ICAO_API_KEY env; we leave it unset so
// the "fallback to live fetch" branch is short-circuited.
//
// IMPORTANT: getCachedJson(key, true=raw) bypasses prefixKey, but
// getCachedJson(key) prepends the env-derived prefix. We force a clean
// prefix by setting VERCEL_ENV=production for the duration of these tests.

let listAirportDelays;
const cacheStore = new Map();
const originalFetch = globalThis.fetch;

before(async () => {
  // Make sure the redis helper has the env vars it needs to even attempt
  // a fetch — otherwise it short-circuits to null without hitting our stub.
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  // Force prefix to '' so getCachedJson(key) — without raw=true — looks up
  // the same key our test populated.
  process.env.VERCEL_ENV = 'production';

  mock.method(globalThis, 'fetch', async (url, _init) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    // Upstash GET: ${baseUrl}/get/${encodeURIComponent(key)}
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
    // Upstash SET: ${baseUrl}/set/...  → swallow.
    if (urlStr.includes('/set/')) {
      return new Response(JSON.stringify({ result: 'OK' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Anything else → fall through to the real fetch (NOTAM live path is
    // gated behind ICAO_API_KEY which we leave unset, so it won't hit here).
    return originalFetch(url, _init);
  });

  const mod = await import('../server/worldmonitor/aviation/v1/list-airport-delays.ts');
  listAirportDelays = mod.listAirportDelays;
});

beforeEach(() => {
  cacheStore.clear();
  // ICAO_API_KEY unset → loadNotamClosures returns null → no NOTAM merge.
  delete process.env.ICAO_API_KEY;
  delete process.env.SEED_FALLBACK_NOTAM;
});

// Picked because they're stable members of FAA_AIRPORTS / AVIATIONSTACK_AIRPORTS /
// NOTAM-only sets. If MONITORED_AIRPORTS shifts, swap to whatever's still in
// each bucket — the assertions are structural, not airport-specific.
const FAA_SAMPLE = 'JFK';            // in FAA_AIRPORTS
const INTL_SAMPLE = 'LHR';           // in AVIATIONSTACK_AIRPORTS
const NOTAM_ONLY_SAMPLE = 'IKA';     // Tehran Imam Khomeini — not in either AS or FAA

describe('listAirportDelays handler — coverage gating (#3707)', () => {
  it('both caches MISS → every monitored airport emits severity=UNKNOWN', async () => {
    // No cache set.
    const resp = await listAirportDelays({}, {});
    assert.ok(Array.isArray(resp.alerts) && resp.alerts.length > 0, 'must return some rows');

    for (const a of resp.alerts) {
      assert.equal(
        a.severity,
        'FLIGHT_DELAY_SEVERITY_UNKNOWN',
        `airport ${a.iata}: must be UNKNOWN when both source caches miss (was: ${a.severity})`,
      );
      assert.equal(
        a.source,
        'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
        `airport ${a.iata}: source must be UNSPECIFIED when uncovered (was: ${a.source})`,
      );
    }

    // And critically: no fabricated NORMAL row exists.
    const normalCount = resp.alerts.filter(a => a.severity === 'FLIGHT_DELAY_SEVERITY_NORMAL').length;
    assert.equal(normalCount, 0, 'must not fabricate NORMAL rows when no telemetry available');
  });

  it('FAA HIT (empty alerts) + INTL MISS → US airports = NORMAL/FAA, non-US = UNKNOWN', async () => {
    cacheStore.set('aviation:delays:faa:v1', { alerts: [] });
    // intl missing

    const resp = await listAirportDelays({}, {});

    const faaRow = resp.alerts.find(a => a.iata === FAA_SAMPLE);
    assert.ok(faaRow, `must include ${FAA_SAMPLE} row`);
    assert.equal(faaRow.severity, 'FLIGHT_DELAY_SEVERITY_NORMAL',
      `${FAA_SAMPLE}: FAA cache hit (no alerts) means normal operations`);
    assert.equal(faaRow.source, 'FLIGHT_DELAY_SOURCE_FAA',
      `${FAA_SAMPLE}: source should be FAA, not COMPUTED`);

    const intlRow = resp.alerts.find(a => a.iata === INTL_SAMPLE);
    assert.ok(intlRow, `must include ${INTL_SAMPLE} row`);
    assert.equal(intlRow.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
      `${INTL_SAMPLE}: intl cache missed — must NOT be marked normal`);
    assert.equal(intlRow.source, 'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
      `${INTL_SAMPLE}: source UNSPECIFIED when uncovered`);

    const notamOnlyRow = resp.alerts.find(a => a.iata === NOTAM_ONLY_SAMPLE);
    assert.ok(notamOnlyRow, `must include ${NOTAM_ONLY_SAMPLE} row`);
    assert.equal(notamOnlyRow.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
      `${NOTAM_ONLY_SAMPLE}: NOTAM-only airport with no NOTAM and neither source → UNKNOWN`);
  });

  it('both caches HIT, one airport in alerts list → alerted airport keeps alert, peers = NORMAL with right source', async () => {
    const jfkAlert = {
      id: 'faa-JFK',
      iata: 'JFK',
      icao: 'KJFK',
      name: 'John F. Kennedy International',
      city: 'New York',
      country: 'USA',
      location: { latitude: 40.6413, longitude: -73.7781 },
      region: 'AIRPORT_REGION_AMERICAS',
      delayType: 'FLIGHT_DELAY_TYPE_GROUND_DELAY',
      severity: 'FLIGHT_DELAY_SEVERITY_MAJOR',
      avgDelayMinutes: 60,
      delayedFlightsPct: 35,
      cancelledFlights: 0,
      totalFlights: 0,
      reason: 'WX',
      source: 'FLIGHT_DELAY_SOURCE_FAA',
      updatedAt: Date.now(),
    };
    cacheStore.set('aviation:delays:faa:v1', { alerts: [jfkAlert] });
    cacheStore.set('aviation:delays:intl:v3', { alerts: [] });

    const resp = await listAirportDelays({}, {});

    // JFK keeps its alert verbatim (apart from possibly enriched fields).
    const jfkOut = resp.alerts.find(a => a.iata === 'JFK');
    assert.ok(jfkOut);
    assert.equal(jfkOut.severity, 'FLIGHT_DELAY_SEVERITY_MAJOR',
      'alerted airport must retain its real severity, not be overwritten by NORMAL');
    assert.equal(jfkOut.source, 'FLIGHT_DELAY_SOURCE_FAA');

    // A peer US airport (FAA-covered, not in alerts) → NORMAL with FAA source.
    const peerFaa = resp.alerts.find(a => a.iata === 'LAX');
    assert.ok(peerFaa);
    assert.equal(peerFaa.severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');
    assert.equal(peerFaa.source, 'FLIGHT_DELAY_SOURCE_FAA',
      'FAA-covered peer must be sourced to FAA, not COMPUTED');

    // A peer intl airport → NORMAL with AVIATIONSTACK source.
    const peerIntl = resp.alerts.find(a => a.iata === INTL_SAMPLE);
    assert.ok(peerIntl);
    assert.equal(peerIntl.severity, 'FLIGHT_DELAY_SEVERITY_NORMAL');
    assert.equal(peerIntl.source, 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
      'intl-covered peer must be sourced to AVIATIONSTACK, not COMPUTED');

    // A NOTAM-only airport with no NOTAM → UNKNOWN even though both feed-caches
    // hit, because neither feed covers it.
    const notamOnly = resp.alerts.find(a => a.iata === NOTAM_ONLY_SAMPLE);
    assert.ok(notamOnly);
    assert.equal(notamOnly.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
      'NOTAM-only airport with no NOTAM and no AS/FAA coverage → UNKNOWN');
  });

  it('a malformed FAA cache payload (missing alerts array) is treated as a MISS', async () => {
    // Defensive: an unrelated object stored at the key (e.g. wrong shape after
    // a schema change without a key bump) must NOT register as "covered" —
    // otherwise we'd revert to fabricating NORMAL rows for every FAA airport.
    cacheStore.set('aviation:delays:faa:v1', { notTheRightField: true });
    cacheStore.set('aviation:delays:intl:v3', { alerts: [] });

    const resp = await listAirportDelays({}, {});
    const faa = resp.alerts.find(a => a.iata === FAA_SAMPLE);
    assert.equal(faa.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
      'malformed FAA payload must not be treated as coverage');
  });

  it('a malformed INTL cache payload (missing alerts array) is treated as a MISS', async () => {
    // Symmetric guard to the FAA test above: the INTL_CACHE_KEY branch has its
    // own `Array.isArray(cached.alerts)` gate; this test proves it also rejects
    // a wrong-shape payload and downgrades intl airports to UNKNOWN instead of
    // synthesising NORMAL rows. (Review #3784.)
    cacheStore.set('aviation:delays:faa:v1', { alerts: [] });
    cacheStore.set('aviation:delays:intl:v3', { notTheRightField: true });

    const resp = await listAirportDelays({}, {});
    const intl = resp.alerts.find(a => a.iata === INTL_SAMPLE);
    assert.equal(intl.severity, 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
      'malformed INTL payload must not be treated as coverage');
    assert.equal(intl.source, 'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
      'malformed INTL payload: source must be UNSPECIFIED when uncovered');
  });
});
