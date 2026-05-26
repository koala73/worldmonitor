import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const relaySrc = readFileSync(resolve('scripts/ais-relay.cjs'), 'utf8');

describe('positive-events GDELT seed failure semantics', () => {
  it('does not count failed GDELT calls as successful empty responses', () => {
    const fetchStart = relaySrc.indexOf('function fetchGdeltGeoPositive(query, seenUrlLocs)');
    const seedStart = relaySrc.indexOf('async function seedPositiveEvents()');
    assert.notEqual(fetchStart, -1, 'fetchGdeltGeoPositive must exist');
    assert.notEqual(seedStart, -1, 'seedPositiveEvents must exist');

    const fetchBlock = relaySrc.slice(fetchStart, seedStart);
    assert.match(fetchBlock, /statusCode !== 200[\s\S]*resolve\(\{ ok: false, events: \[\] \}\)/);
    assert.match(fetchBlock, /catch \{ resolve\(\{ ok: false, events: \[\] \}\); \}/);
    assert.match(fetchBlock, /req\.on\('error', \(\) => resolve\(\{ ok: false, events: \[\] \}\)\)/);
    assert.match(fetchBlock, /req\.on\('timeout', \(\) => \{ req\.destroy\(\); resolve\(\{ ok: false, events: \[\] \}\); \}\)/);
    assert.match(fetchBlock, /resolve\(\{ ok: true, events \}\)/);
  });

  it('preserves stale cache when every positive-events query failed', () => {
    const seedStart = relaySrc.indexOf('async function seedPositiveEvents()');
    const loopStart = relaySrc.indexOf('async function startPositiveEventsSeedLoop()');
    assert.notEqual(seedStart, -1, 'seedPositiveEvents must exist');
    assert.notEqual(loopStart, -1, 'startPositiveEventsSeedLoop must exist');

    const seedBlock = relaySrc.slice(seedStart, loopStart);
    assert.match(seedBlock, /const result = await fetchGdeltGeoPositive\(POSITIVE_QUERIES\[i\], seenUrlLocs\);/);
    assert.match(seedBlock, /if \(!result\?\.ok\) continue;/);
    assert.match(seedBlock, /anyQuerySucceeded = true;/);
    assert.match(seedBlock, /if \(!anyQuerySucceeded\)[\s\S]*upstashExpire\(POSITIVE_EVENTS_RPC_KEY, POSITIVE_EVENTS_TTL\)[\s\S]*upstashExpire\(POSITIVE_EVENTS_BOOTSTRAP_KEY, POSITIVE_EVENTS_TTL\)/);
  });
});
