import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getIpGeo } from '../server/worldmonitor/infrastructure/v1/get-ip-geo.ts';

function ctxWithProof(proof) {
  if (proof) process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
  else delete process.env.CF_EDGE_PROOF_SECRET;
  const secret = proof ? 'edge-secret-xyz' : 'wrong';
  return {
    request: new Request('https://worldmonitor.app/api/infrastructure/v1/get-ip-geo', {
      headers: { 'x-wm-edge-proof': secret },
    }),
    pathParams: {},
    headers: {},
  };
}

function ctxWithHeaders(headers, proof) {
  const base = ctxWithProof(proof);
  base.headers = headers;
  return base;
}

test('IP geolocation reads the documented Vercel region header', async () => {
  assert.deepEqual(await getIpGeo(ctxWithHeaders({
    'x-vercel-ip-country': 'US',
    'x-vercel-ip-country-region': 'CA',
    'x-vercel-ip-region': 'invalid',
    'x-vercel-ip-city': 'Oakland',
  }, false), {}), { country: 'US', region: 'CA', city: 'Oakland' });
});

test('IP geolocation ignores the unknown region header and retains country fallbacks', async () => {
  assert.deepEqual(await getIpGeo(ctxWithHeaders({ 'x-vercel-ip-region': 'invalid' }, false), {}),
    { country: 'XX', region: '', city: '' });
  // Unsigned cf-ipcountry is caller-controlled: without transit proof the
  // Vercel connection header wins even when cf-ipcountry disagrees.
  assert.equal((await getIpGeo(ctxWithHeaders({ 'cf-ipcountry': 'FR', 'x-vercel-ip-country': 'US' }, false), {})).country, 'US');
  assert.equal((await getIpGeo(ctxWithHeaders({ 'cf-ipcountry': 'T1', 'x-vercel-ip-country': 'US' }, false), {})).country, 'US');
});

test('IP geolocation honors cf-ipcountry only with Cloudflare transit proof', async () => {
  assert.equal((await getIpGeo(ctxWithHeaders({ 'cf-ipcountry': 'FR', 'x-vercel-ip-country': 'US' }, true), {})).country, 'FR');
  assert.equal((await getIpGeo(ctxWithHeaders({ 'cf-ipcountry': 'T1', 'x-vercel-ip-country': 'US' }, true), {})).country, 'US');
});

test('IP geolocation validates country shape and decodes the city', async () => {
  // Tor pseudo-country and non-ISO values map to the unknown sentinel.
  assert.equal((await getIpGeo(ctxWithHeaders({ 'x-vercel-ip-country': 'T1' }, false), {})).country, 'XX');
  assert.equal((await getIpGeo(ctxWithHeaders({ 'x-vercel-ip-country': 'USA' }, false), {})).country, 'XX');
  assert.equal((await getIpGeo(ctxWithHeaders({ 'x-vercel-ip-country': 'us' }, false), {})).country, 'XX');
  assert.equal((await getIpGeo(ctxWithHeaders({ 'cf-ipcountry': 'FRA', 'x-vercel-ip-country': 'US' }, true), {})).country, 'US');
  // Vercel URL-encodes city names with spaces.
  assert.equal((await getIpGeo(ctxWithHeaders({ 'x-vercel-ip-country': 'US', 'x-vercel-ip-city': 'New%20York' }, false), {})).city, 'New York');
});
