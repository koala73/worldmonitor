import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOrbitalWatchEnabled, orbitalWatchDarkResponse } from '../server/worldmonitor/orbital/v1/dark-launch.ts';

test('the orbital RPCs stay dark unless ORBITAL_WATCH_ENABLED is true', () => {
  assert.equal(isOrbitalWatchEnabled({}), false);
  assert.equal(isOrbitalWatchEnabled({ ORBITAL_WATCH_ENABLED: 'false' }), false);
  assert.equal(isOrbitalWatchEnabled({ ORBITAL_WATCH_ENABLED: '1' }), false);
  assert.equal(isOrbitalWatchEnabled({ ORBITAL_WATCH_ENABLED: ' TRUE ' }), true);
});

test('a dark orbital RPC answers an uncached 404', async () => {
  const res = orbitalWatchDarkResponse();
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('the orbital edge entry checks the switch before routing', () => {
  const entry = readFileSync(new URL('../api/orbital/v1/[rpc].ts', import.meta.url), 'utf8');
  assert.match(entry, /isOrbitalWatchEnabled\(\) \? gateway\(\.\.\.args\) : Promise\.resolve\(orbitalWatchDarkResponse\(\)\)/);
});
