// The OECD LT seeder read FRED through the public fredgraph.csv export. That
// export stopped answering scripted clients: from 2026-11-02 to 2026-11-05 every
// Railway run timed out on the first series (FETCH FAILED after three retries),
// seed-meta aged past its 72h budget and health opened Sentry WORLDMONITOR-1CF.
// The keyed FRED API answered the same series in under a second throughout.
// With FRED_API_KEY set the seeder must use the API; the CSV export stays the
// keyless fallback for self-hosts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchOecdLtRates } from '../scripts/seed-oecd-lt-rates.mjs';
import { OECD_LT_MARKETS, parseFredObservations } from '../scripts/lib/yield-curves/oecd-lt.mjs';

const ecbUnavailable = async () => ({ ok: false, status: 503, text: async () => '' });

function observations() {
  return {
    observations: [
      { date: '2026-07-01', value: '2.61' },
      { date: '2026-08-01', value: '.' },
      { date: '2026-09-01', value: '2.70' },
    ],
  };
}

test('with FRED_API_KEY the seeder reads every market from the keyed FRED API, not fredgraph.csv', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    if (String(url).includes('fredgraph.csv')) throw new Error('fredgraph.csv must not be requested');
    return ecbUnavailable();
  };
  const payload = await fetchOecdLtRates({
    apiKey: 'test-key',
    proxyAuth: null,
    staggerMs: 0,
    fetchFn,
    fredJson: async (url) => { urls.push(url); return observations(); },
  });

  assert.equal(urls.length, Object.keys(OECD_LT_MARKETS).length);
  for (const [market, seriesId] of Object.entries(OECD_LT_MARKETS)) {
    const url = new URL(urls.find((u) => u.includes(`series_id=${seriesId}`)));
    assert.equal(url.origin + url.pathname, 'https://api.stlouisfed.org/fred/series/observations');
    assert.equal(url.searchParams.get('file_type'), 'json');
    assert.equal(url.searchParams.get('api_key'), 'test-key');
    assert.deepEqual(
      payload.countries[market].curves.map((c) => c.date),
      ['2026-07-01', '2026-09-01'],
      `${market} keeps dated observations and drops FRED's "." placeholder`,
    );
  }
});

test('without FRED_API_KEY the seeder keeps the keyless fredgraph.csv export', async () => {
  const requested = [];
  const fetchFn = async (url) => {
    if (!String(url).includes('fredgraph.csv')) return ecbUnavailable();
    requested.push(String(url));
    return { ok: true, status: 200, text: async () => 'DATE,VALUE\n2026-09-01,2.70\n' };
  };
  const payload = await fetchOecdLtRates({
    apiKey: '',
    staggerMs: 0,
    fetchFn,
    fredJson: async () => { throw new Error('keyed API must not be called without a key'); },
  });

  assert.equal(requested.length, Object.keys(OECD_LT_MARKETS).length);
  assert.equal(Object.keys(payload.countries).length, Object.keys(OECD_LT_MARKETS).length);
});

test('parseFredObservations drops missing values and malformed rows', () => {
  assert.deepEqual(parseFredObservations({
    observations: [
      { date: '2026-08-01', value: '.' },
      { date: '2026-09-01', value: '2.70' },
      { date: 'bad', value: '1.0' },
      null,
    ],
  }), [{ date: '2026-09-01', value: 2.7 }]);
  assert.deepEqual(parseFredObservations(null), []);
});
