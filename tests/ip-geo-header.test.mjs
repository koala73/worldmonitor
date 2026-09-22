import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getIpGeo } from '../server/worldmonitor/infrastructure/v1/get-ip-geo.ts';

test('IP geolocation reads the documented Vercel region header', async () => {
  assert.deepEqual(await getIpGeo({ headers: {
    'x-vercel-ip-country': 'US',
    'x-vercel-ip-country-region': 'CA',
    'x-vercel-ip-region': 'invalid',
    'x-vercel-ip-city': 'Oakland',
  } }, {}), { country: 'US', region: 'CA', city: 'Oakland' });
});

test('IP geolocation ignores the unknown region header and retains country fallbacks', async () => {
  assert.deepEqual(await getIpGeo({ headers: { 'x-vercel-ip-region': 'invalid' } }, {}),
    { country: 'XX', region: '', city: '' });
  assert.equal((await getIpGeo({ headers: { 'cf-ipcountry': 'FR', 'x-vercel-ip-country': 'US' } }, {})).country, 'FR');
  assert.equal((await getIpGeo({ headers: { 'cf-ipcountry': 'T1', 'x-vercel-ip-country': 'US' } }, {})).country, 'US');
});
