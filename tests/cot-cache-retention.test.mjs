import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { __testing__ } from '../api/health.js';
import { resolveSeedMetaTtl } from '../scripts/_seed-utils.mjs';
import { mapCotPositioning } from '../server/worldmonitor/market/v1/get-cot-positioning.ts';

const source = readFileSync(new URL('../scripts/seed-cot.mjs', import.meta.url), 'utf8');
const ttl = Number(source.match(/^const COT_TTL = (\d+);/m)?.[1]);
assert.ok(Number.isFinite(ttl));
assert.match(source, /ttlSeconds: COT_TTL/);
const { classifyKey, SEED_META, BOOTSTRAP_KEYS } = __testing__;
const config = SEED_META.cotPositioning;
const key = BOOTSTRAP_KEYS.cotPositioning;
const fetchedAt = Date.parse('2026-09-18T22:00:47Z');
const payload = { reportDate: '2026-09-15', instruments: [{ code: 'ES', reportDate: '2026-09-15' }] };

function readAt(now) {
  const ageSeconds = (now - fetchedAt) / 1000;
  const data = ageSeconds < ttl ? payload : null;
  const meta = ageSeconds < resolveSeedMetaTtl(undefined, ttl)
    ? { fetchedAt, recordCount: 1 } : null;
  const health = classifyKey('cotPositioning', key, { allowOnDemand: false }, {
    now, keyStrens: new Map([[key, data ? JSON.stringify(data).length : 0]]),
    keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([[config.key, meta ? JSON.stringify(meta) : null]]),
  });
  return { health, consumer: mapCotPositioning(data), meta };
}

test('COT survives the observed weekly start delay with original dates and seed age', () => {
  for (const time of ['2026-09-25T22:01:11.524Z', '2026-09-25T22:04:48Z']) {
    const { health, consumer, meta } = readAt(Date.parse(time));
    assert.equal(health.status, 'OK', time);
    assert.equal(consumer.unavailable, false);
    assert.equal(consumer.reportDate, '2026-09-15');
    assert.equal(consumer.instruments[0].reportDate, '2026-09-15');
    assert.equal(meta.fetchedAt, fetchedAt);
    assert.ok(health.seedAgeMin >= 10080);
  }
});

test('COT still warns after ten days while retained data remains readable, then expires', () => {
  assert.equal(config.maxStaleMin, 14400, 'retention must not widen the health budget');
  const staleAt = fetchedAt + (config.maxStaleMin + 1) * 60000;
  const stale = readAt(staleAt);
  assert.equal(stale.health.status, 'STALE_SEED');
  assert.equal(stale.health.seedAgeMin, 14401);
  assert.equal(stale.consumer.unavailable, false);
  assert.equal(stale.consumer.reportDate, '2026-09-15');
  const expired = readAt(fetchedAt + ttl * 1000);
  assert.equal(expired.consumer.unavailable, true);
  assert.equal(expired.health.status, 'STALE_SEED');
  assert.equal(expired.meta, null);
});
