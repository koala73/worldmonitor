// Overpass answers 406 Not Acceptable to Node's default `User-Agent: node`,
// so the OSM military-bases fetch failed for anyone running it (reported by
// the FreeBSD port maintainer). It must identify itself.
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchOverpassData } from '../scripts/fetch-osm-bases.mjs';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

it('sends a descriptive User-Agent to Overpass', async () => {
  let sentHeaders;
  globalThis.fetch = async (_url, init) => {
    sentHeaders = new Headers(init.headers);
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  };

  await fetchOverpassData();

  const ua = sentHeaders.get('user-agent');
  assert.ok(ua, 'Overpass request must carry a User-Agent');
  assert.match(ua, /worldmonitor/i);
});
