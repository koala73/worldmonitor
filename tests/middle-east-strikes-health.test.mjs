// /api/health and /api/seed-health for the Middle East strike feed
// (conflict:iran-events:v1, produced every 10 minutes by ais-relay).
// Both modules read IRAN_EVENTS_ENABLED at import, so it is set first and the
// modules are imported dynamically; node:test runs each file in its own process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.IRAN_EVENTS_ENABLED = 'true';
const { __testing__ } = await import('../api/health.js');
const { classifyKey, BOOTSTRAP_KEYS, SEED_META, ACTIVATION_MARKERS } = __testing__;

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const KEY = 'conflict:iran-events:v1';

function ctx({ present = true, metaAgeMin = 1, recordCount = 0 } = {}) {
  return {
    containmentEvidenceByName: new Map(),
    keyStrens: new Map(present ? [[KEY, 160]] : []),
    keyErrors: new Map(),
    keyMetaValues: new Map(metaAgeMin == null ? [] : [[SEED_META.iranEvents.key, JSON.stringify({
      fetchedAt: NOW - metaAgeMin * MIN, recordCount, sourceVersion: 'telegram-strikes-v1',
    })]]),
    keyMetaErrors: new Map(),
    now: NOW,
  };
}
const classify = (opts) => classifyKey('iranEvents', KEY, { allowOnDemand: false }, ctx(opts)).status;

test('the probe follows the relay cadence, not the retired 14-day manual dump', () => {
  assert.equal(BOOTSTRAP_KEYS.iranEvents, KEY);
  assert.equal(SEED_META.iranEvents.key, 'seed-meta:conflict:iran-events');
  assert.equal(SEED_META.iranEvents.maxStaleMin, 45);
});

test('a quiet 72h window with a live producer is OK; a stopped producer turns STALE_SEED', () => {
  assert.equal(classify({ metaAgeMin: 5, recordCount: 0 }), 'OK');
  assert.equal(classify({ metaAgeMin: 5, recordCount: 12 }), 'OK');
  assert.equal(classify({ metaAgeMin: 46, recordCount: 12 }), 'STALE_SEED');
});

test('a vanished payload is never excused by fresh seed-meta', () => {
  assert.notEqual(classify({ present: false, metaAgeMin: 5, recordCount: 0 }), 'OK');
});

test('the relay writes seed-meta only through the gated publish cycle', () => {
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const start = relay.indexOf('async function seedMiddleEastStrikes(');
  const body = relay.slice(start, relay.indexOf('\nfunction startMiddleEastStrikesLoop(', start));
  assert.match(body, /middleEastStrikes\.publishStrikeCycle\(\{/);
  assert.equal(relay.split('middleEastStrikes.SEED_META_KEY, meta').length - 1, 1, 'one seed-meta writer, injected into publishStrikeCycle');
  assert.match(body, /writeSeedMeta: \(meta\) => upstashSet\(middleEastStrikes\.SEED_META_KEY, meta,/);
});

test('a poison post is dropped after answered cycles, but a dead classifier never drops posts', () => {
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  assert.match(relay, /if \(result && !result\.classifierFailed\) \{\s*for \(const item of result\.pending\)/);
  assert.match(relay, /const MIDDLE_EAST_STRIKES_MAX_MISSES = 3;/);
});

test('Telegram freshness counts only polls that read at least one channel', () => {
  // A FLOOD_WAIT on the first channel, or every channel erroring, still ends a
  // poll cycle; it must not keep the strike feed's seed-meta fresh.
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  assert.match(relay, /if \(channelsPolled > 0\) telegramState\.lastSuccessfulPollAt = telegramState\.lastPollAt;/);
  assert.match(relay, /telegramPolledAt: telegramState\.lastSuccessfulPollAt,/);
  assert.doesNotMatch(relay, /telegramPolledAt: telegramState\.lastPollAt\b/);
});

test('seed-health marks the feed stale on the same budget', async () => {
  const src = readFileSync(new URL('../api/seed-health.js', import.meta.url), 'utf8');
  const interval = Number(/'conflict:iran-events':\s*\{[^}]*intervalMin:\s*(\d+)/.exec(src)?.[1]);
  assert.ok(interval * 2 <= SEED_META.iranEvents.maxStaleMin && interval * 2 >= 30, `intervalMin ${interval}`);
});

// Since CII v12: the relay also keeps a 30-day per-country strike tally
// (conflict:strike-pressure:v1), read only by the CII strike pressure.
const PRESSURE_KEY = 'conflict:strike-pressure:v1';
function pressureCtx({ present = true, metaAgeMin = 1, recordCount = 0, activated = true } = {}) {
  return {
    containmentEvidenceByName: new Map(),
    keyStrens: new Map(present ? [[PRESSURE_KEY, 120]] : []),
    keyErrors: new Map(),
    keyMetaValues: new Map(metaAgeMin == null ? [] : [[SEED_META.strikePressure.key, JSON.stringify({
      fetchedAt: NOW - metaAgeMin * MIN, recordCount, sourceVersion: 'strike-pressure-v1',
    })]]),
    keyMetaErrors: new Map(),
    activationStates: new Map([['strikePressure', activated]]),
    now: NOW,
  };
}
const classifyPressure = (opts) => classifyKey('strikePressure', PRESSURE_KEY, { allowOnDemand: true }, pressureCtx(opts)).status;

test('the strike-pressure tally is monitored on the relay cadence behind its activation marker', () => {
  assert.equal(SEED_META.strikePressure.key, 'seed-meta:conflict:strike-pressure');
  assert.equal(SEED_META.strikePressure.maxStaleMin, 45);
  assert.equal(ACTIVATION_MARKERS.strikePressure, SEED_META.strikePressure.activationKey);
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../scripts/lib/middle-east-strikes.cjs', import.meta.url), 'utf8');
  assert.match(lib, new RegExp(`PRESSURE_KEY = '${PRESSURE_KEY}'`));
  assert.match(lib, new RegExp(`PRESSURE_SEED_META_KEY = '${SEED_META.strikePressure.key}'`));
  assert.match(lib, new RegExp(`PRESSURE_ACTIVATION_KEY = '${SEED_META.strikePressure.activationKey}'`));
  assert.match(relay, /writePressureMeta: async \(meta\) => \{/);
});

test('the tally is pending before its first healthy publish and strict afterwards', () => {
  assert.equal(classifyPressure({ present: false, metaAgeMin: null, activated: false }), 'EMPTY_ON_DEMAND');
  assert.notEqual(classifyPressure({ present: false, metaAgeMin: null, activated: true }), 'OK');
  assert.equal(classifyPressure({ metaAgeMin: 5, recordCount: 0 }), 'OK', 'thirty quiet days are a valid empty tally');
  assert.equal(classifyPressure({ metaAgeMin: 46, recordCount: 40 }), 'STALE_SEED');
});

test('the tally data outlives its 30-day window and its health budget', () => {
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const ttlDays = Number(/MIDDLE_EAST_STRIKE_PRESSURE_TTL_S = (\d+) \* 24 \* 3600/.exec(relay)?.[1]);
  assert.ok(ttlDays > 30, `TTL ${ttlDays} days`);
});

test('seed-health keeps the tally pending until its first healthy publish, like /api/health', () => {
  const src = readFileSync(new URL('../api/seed-health.js', import.meta.url), 'utf8');
  const entry = /'conflict:strike-pressure':\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';
  assert.match(entry, new RegExp(`activationKey: '${SEED_META.strikePressure.activationKey}'`));
});
