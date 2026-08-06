// Regression guards for #6224 — the military-flight seeder spends zero
// OpenSky credits in every upstream outcome.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.WINGBITS_API_KEY = 'test-wingbits';
delete process.env.WM_ENABLE_NONCOMMERCIAL_ADSB_GAP_FILL;

const { fetchAllStates } = await import('../scripts/seed-military-flights.mjs');

const ADSBLOL_HOST = 'api.adsb.lol';
const OPENSKY_HOSTS = new Set(['opensky-network.org', 'auth.opensky-network.org']);
const WINGBITS_HOST = 'customer-api.wingbits.com';

const originalFetch = globalThis.fetch;
let calls;

const ADSBLOL_ONLY = { hex: 'ae0001', flight: 'RCH101', lat: 40, lon: -100, alt_baro: 30_000 };
const WINGBITS_ONLY = { h: 'ae1111', f: 'RCH999', la: 30, lo: 130, ab: 30_000, gs: 450, th: 180, og: false };

function install({ adsbLolAircraft = [ADSBLOL_ONLY], wingbitsAircraft = [] } = {}) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const raw = typeof url === 'string' ? url : url.url;
    calls.push({ url: raw, method: opts.method || 'GET' });
    const host = new URL(raw).host;

    if (host === ADSBLOL_HOST) {
      return Response.json({ now: 1_785_000_000_000, ac: adsbLolAircraft });
    }
    if (host === WINGBITS_HOST) {
      return Response.json([{ alias: 'PACIFIC', data: wingbitsAircraft }]);
    }
    if (OPENSKY_HOSTS.has(host)) {
      throw new Error(`OpenSky must be fully disabled, but requested ${raw}`);
    }
    return Response.json({});
  };
}

const openSkyCalls = () => calls.filter((call) => OPENSKY_HOSTS.has(new URL(call.url).host));

beforeEach(() => install());
afterEach(() => { globalThis.fetch = originalFetch; });

test('a successful adsb.lol primary response spends zero OpenSky requests', async () => {
  const { allStates, fetchSources } = await fetchAllStates();
  assert.deepEqual(allStates.map((row) => row[0]), [ADSBLOL_ONLY.hex]);
  assert.equal(fetchSources.adsbLolUsed, true);
  assert.equal(fetchSources.openSkyDisabled, true);
  assert.equal(openSkyCalls().length, 0);
});

test('a Wingbits-only response spends zero OpenSky requests', async () => {
  install({ adsbLolAircraft: [], wingbitsAircraft: [WINGBITS_ONLY] });
  const { allStates, fetchSources } = await fetchAllStates();
  assert.deepEqual(allStates.map((row) => row[0]), [WINGBITS_ONLY.h]);
  assert.equal(fetchSources.openSkyDisabled, true);
  assert.equal(openSkyCalls().length, 0);
});

test('even a fully empty keyless/keyed cycle spends zero OpenSky requests', async () => {
  install({ adsbLolAircraft: [], wingbitsAircraft: [] });
  const { allStates, fetchSources } = await fetchAllStates();
  assert.deepEqual(allStates, []);
  assert.equal(fetchSources.openSkyDisabled, true);
  assert.equal(openSkyCalls().length, 0);
});
