// Regression guard for #6222 — the OpenSky credit budget of the military-flights seeder.
//
// OpenSky bills /states/all by bounding-box AREA with a FLAT top tier: any bbox
// above 400 sq° costs 4 credits, exactly what a global (no-bbox) query costs.
// The seeder used to issue TWO regional queries (1,296 and 4,824 sq°) = 8 credits
// per run x 288 runs/day = 2,304 of the 4,000/day quota, for coverage that
// excluded the Americas. One global query costs 4 and covers the planet.
//
// None of that is observable from the published payload — a run that spends 8
// credits and a run that spends 4 publish the same shape — so these assertions
// inspect the actual outbound requests. Source-text greps would pass with the
// bug restored (the constants can stay while the call path changes), which is
// why this drives fetchAllStates() and records real fetch calls.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENSKY_CLIENT_ID = 'test-client';
process.env.OPENSKY_CLIENT_SECRET = 'test-secret';
process.env.WINGBITS_API_KEY = 'test-wingbits';
delete process.env.OPENSKY_PROXY_AUTH;
delete process.env.PROXY_URL;

const { fetchAllStates } = await import('../scripts/seed-military-flights.mjs');

const OPENSKY_HOST = 'opensky-network.org';
const TOKEN_HOST = 'auth.opensky-network.org';
const WINGBITS_HOST = 'customer-api.wingbits.com';

const originalFetch = globalThis.fetch;
let calls;

// A state vector is a positional array; index 0 is icao24, 5 lon, 6 lat, 8 onGround.
function state(icao24, callsign, lat, lon) {
  const s = new Array(17).fill(null);
  s[0] = icao24;
  s[1] = callsign;
  s[5] = lon;
  s[6] = lat;
  s[7] = 10000;
  s[8] = false;
  s[9] = 400;
  s[10] = 90;
  return s;
}

// ADF7C8-AFFFFF is the USAF hex range the seeder already recognises, so these
// are admitted on hex alone and the assertions do not depend on callsign rules.
const WINGBITS_ONLY = 'ae1111';
const OPENSKY_ONLY = 'ae2222';

function install({ openSkyStates = [state(OPENSKY_ONLY, 'RCH123', 40, -100)], openSkyStatus = 200 } = {}) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const raw = typeof url === 'string' ? url : url.url;
    calls.push({ url: raw, method: opts.method || 'GET', headers: opts.headers || {} });
    const u = new URL(raw);

    if (u.host === TOKEN_HOST) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 1800 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.host === WINGBITS_HOST) {
      // Wingbits answers an ARRAY of per-area results, each carrying `data`;
      // an object here is rejected by the parser's Array.isArray guard.
      return new Response(JSON.stringify([
        { alias: 'PACIFIC', data: [
          { h: WINGBITS_ONLY, f: 'RCH999', la: 30, lo: 130, ab: 30000, gs: 450, th: 180, og: false },
        ] },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.host === OPENSKY_HOST) {
      if (openSkyStatus !== 200) {
        return new Response('Too many requests', { status: openSkyStatus });
      }
      return new Response(JSON.stringify({ time: 0, states: openSkyStates }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const openSkyDataCalls = () => calls.filter(c => new URL(c.url).host === OPENSKY_HOST);

beforeEach(() => install());
afterEach(() => { globalThis.fetch = originalFetch; });

test('issues exactly ONE OpenSky /states/all request per run', async () => {
  await fetchAllStates();
  const os = openSkyDataCalls();
  assert.equal(
    os.length, 1,
    `Expected 1 OpenSky states request per run, got ${os.length}: ${os.map(c => c.url).join(' , ')}. ` +
    'Each >400 sq° bbox costs 4 credits — the same as one global query — so N regional ' +
    'queries cost Nx4/run against a 4,000/day quota (#6222).',
  );
});

test('the OpenSky request carries NO bounding box (global = 4 credits, widest coverage)', async () => {
  await fetchAllStates();
  const [os] = openSkyDataCalls();
  assert.ok(os, 'expected an OpenSky states request');
  const params = new URL(os.url).searchParams;
  for (const bboxParam of ['lamin', 'lamax', 'lomin', 'lomax']) {
    assert.equal(
      params.get(bboxParam), null,
      `OpenSky request still carries ${bboxParam}=${params.get(bboxParam)}. A bounded query above ` +
      '400 sq° costs the same 4 credits as a global one but sees less; drop the bbox (#6222).',
    );
  }
});

test('OpenSky-only aircraft still reach the merged set when Wingbits already succeeded', async () => {
  const { allStates } = await fetchAllStates();
  const ids = allStates.map(s => s[0]);
  assert.ok(
    ids.includes(WINGBITS_ONLY),
    'Wingbits aircraft missing from the merged set',
  );
  assert.ok(
    ids.includes(OPENSKY_ONLY),
    'OpenSky-only aircraft missing from the merged set. OpenSky merges ADDITIVELY by icao24 and ' +
    'contributes aircraft Wingbits never saw, so it must NOT be gated behind Wingbits failure — ' +
    'a degraded-but-non-empty Wingbits response would silently delete this coverage (#6222).',
  );
});

test('spends exactly one OpenSky request even when the authenticated call fails', async () => {
  // The other request-count assertion runs against a SUCCEEDING fixture, so it never
  // executes the failure branch — and the anonymity assertion below only counts
  // requests without an Authorization header. Between them, a second *authenticated*
  // request added on the failure path (a retry, say) would pass every other test here.
  // Since the whole point is a credit budget, that is the most likely careless
  // re-addition, so pin total spend on the failure path too.
  install({ openSkyStatus: 429 });
  await fetchAllStates();
  const os = openSkyDataCalls();
  assert.equal(
    os.length, 1,
    `A failing OpenSky call spent ${os.length} requests; expected 1. Retrying a 429 spends ` +
    'another credit against an already-exhausted budget (#6222).',
  );
});

test('does not retry a 429 through the residential proxy', async () => {
  // The quota is per ACCOUNT and both paths send the same bearer token, so a
  // different egress IP cannot change a 429 — the retry is guaranteed futile
  // while still costing a request, proxy bandwidth, and latency on every cycle
  // of a multi-hour exhaustion window.
  //
  // Counting globalThis.fetch calls CANNOT see this: proxyFetchJson goes through
  // _proxy-utils.cjs, which opens raw sockets and never touches globalThis.fetch.
  // A request-count assertion here would pass with the guard removed. The
  // observable signal is the recorded status — the proxy path stringifies BOTH
  // errors as `direct=... | proxy=...`, so its absence proves the proxy was
  // never attempted.
  process.env.OPENSKY_PROXY_AUTH = 'http://user:pass@proxy.test:8080';
  const mod = await import(`../scripts/seed-military-flights.mjs?proxy=${Date.now()}`);
  install({ openSkyStatus: 429 });
  try {
    const { fetchSources } = await mod.fetchAllStates();
    const status = fetchSources.regions[0]?.authStatus || '';
    assert.match(status, /429/, `expected a recorded 429, got: ${status}`);
    assert.ok(
      !status.includes('proxy='),
      `A 429 was retried through the residential proxy (status: ${status}). The quota is ` +
      'per-account and both paths send the same bearer token, so a different egress IP ' +
      'cannot change the verdict (#6222).',
    );
  } finally {
    delete process.env.OPENSKY_PROXY_AUTH;
  }
});

test('never falls back to an unauthenticated OpenSky request', async () => {
  // Anonymous OpenSky is 400 credits/day PER IP on shared Railway/Vercel egress,
  // so it can essentially never succeed — it only adds a timeout to the failure path.
  install({ openSkyStatus: 429 });
  await fetchAllStates();
  const anon = openSkyDataCalls().filter(c => {
    const auth = c.headers.Authorization || c.headers.authorization;
    return !auth;
  });
  assert.equal(
    anon.length, 0,
    `Found ${anon.length} unauthenticated OpenSky request(s) after an authenticated failure. ` +
    'The anonymous tier is per-IP and shared across all tenants of the egress pool; it cannot ' +
    'succeed and costs a full timeout on every failure path (#6222).',
  );
});
