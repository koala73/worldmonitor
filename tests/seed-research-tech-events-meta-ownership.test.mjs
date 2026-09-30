// tech-events seed-meta ownership — collision reproduction + wiring regression.
//
// Incident 2026-09-23: /api/health reported techEvents EMPTY (records=0, crit) while
// seedAgeMin stayed fresh. Two producers shared one freshness key:
//
//   - scripts/ais-relay.cjs seedTechEvents() writes research:tech-events:v1 +
//     research:tech-events-bootstrap:v1 + seed-meta:research:tech-events (6h loop).
//   - scripts/seed-research.mjs fetchAll() writes research:tech-events:v1 via
//     writeExtraKeyWithMeta, whose default meta derivation strips ':v1' — so it
//     refreshed seed-meta:research:tech-events every 4h while NEVER writing the
//     bootstrap payload that /api/health counts and bootstrap hydration serves.
//
// The relay defers its boot seed (bootSeedDelayMs) while that meta is younger than
// its 6h interval, so a relay restart inside the seeder's 4h refresh window
// postponed the first seed again. The bootstrap key then expired silently
// (24h TTL) while the shared meta stayed perpetually fresh: EMPTY next to a
// fresh seedAge, and no STALE_SEED alarm. The fix gives the seeder a distinct
// meta key so the relay-owned meta tracks the relay's own publications.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { TECH_EVENTS_SEED_META_KEY, writeTechEventsMirror } from '../scripts/seed-research.mjs';
import { resolveSeedMetaKey } from '../scripts/_seed-utils.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const seederSource = readFileSync(resolve(here, '../scripts/seed-research.mjs'), 'utf8');

const RELAY_META_KEY = 'seed-meta:research:tech-events';

const SAMPLE_PAYLOAD = {
  success: true,
  count: 2,
  events: [
    { id: 'a', title: 'Event A', startDate: '2026-10-01', source: 'techmeme' },
    { id: 'b', title: 'Event B', startDate: '2026-10-02', source: 'curated' },
  ],
};

// -- Reproduction: the default derivation is the collision ---------------------

test('reproduces the collision: the default meta derivation strips :v1 onto the relay-owned key', () => {
  const derived = resolveSeedMetaKey('research:tech-events:v1');
  assert.equal(derived, RELAY_META_KEY, 'default derivation must land on the relay key to prove the collision');
  assert.notEqual(TECH_EVENTS_SEED_META_KEY, derived, 'the seeder must no longer use the derived key');
});

test('the seeder meta key stays inside the seed-meta namespace and is distinct from the relay key', () => {
  assert.ok(TECH_EVENTS_SEED_META_KEY.startsWith('seed-meta:'), 'must be a seed-meta key');
  assert.notEqual(TECH_EVENTS_SEED_META_KEY, RELAY_META_KEY);
});

// -- Wiring: the 5th writeExtraKeyWithMeta argument pins the override ----------

test('behavioral: the mirror write targets the seeder meta key, not the relay-owned key', async () => {
  const writes = [];
  await writeTechEventsMirror(SAMPLE_PAYLOAD, {
    writeExtraKeyWithMeta: async (key, data, ttl, recordCount, metaKeyOverride) => {
      writes.push({ key, data, ttl, recordCount, metaKeyOverride });
    },
  });
  assert.equal(writes.length, 1);
  const w = writes[0];
  assert.equal(w.key, 'research:tech-events:v1', 'the mirror data key is unchanged');
  assert.equal(w.metaKeyOverride, TECH_EVENTS_SEED_META_KEY, 'the meta override must be the seeder-owned key');
  assert.notEqual(w.metaKeyOverride, RELAY_META_KEY, 'must never write the relay-owned freshness key');
  assert.equal(w.recordCount, 2, 'recordCount must match the payload');
  assert.equal(w.ttl, 28800, 'the 8h mirror TTL is unchanged');
  assert.equal(w.data, SAMPLE_PAYLOAD, 'the payload is passed through untouched');
});

test('the extracted mirror write is what fetchAll calls (source wiring, format-tolerant)', () => {
  assert.ok(
    /if \(allData\.techEvents\?\.events\?\.length > 0\) await writeTechEventsMirror\(allData\.techEvents\);/.test(seederSource),
    'fetchAll must route the tech-events write through writeTechEventsMirror',
  );
});

test('curated-only and empty payloads preserve the previous mirror and heartbeat', async () => {
  for (const events of [[{ ...SAMPLE_PAYLOAD.events[0], source: 'curated' }], []]) {
    const writes = [];
    await writeTechEventsMirror({ ...SAMPLE_PAYLOAD, events }, {
      writeExtraKeyWithMeta: async (...args) => writes.push(args),
    });
    assert.equal(writes.length, 0);
  }
});

test('the relay preserves data during an outage and publishes after recovery', async () => {
  const source = readFileSync(resolve(here, '../scripts/ais-relay.cjs'), 'utf8');
  const start = source.indexOf('const TECH_EVENTS_SEED_INTERVAL_MS');
  const end = source.indexOf('async function startTechEventsSeedLoop()', start);
  assert.ok(start >= 0 && end > start);
  const writes = [];
  let feed = null;
  const warnings = [];
  const seed = runInNewContext(`${source.slice(start, end)}
    techEventsFetchUrl = fetchFeed;
    seedTechEvents;
  `, {
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : ['2026-10-01T00:00:00Z'])); }
      static now() { return Date.parse('2026-10-01T00:00:00Z'); }
    },
    fetchFeed: async (url) => url.includes('techmeme') ? feed : null,
    console: { log() {}, warn: (...args) => warnings.push(args.join(' ')) },
    envelopeWrite: async (...args) => writes.push(args),
    upstashSet: async (...args) => writes.push(args),
  });
  await seed();
  assert.equal(writes.length, 0);
  assert.ok(warnings.some(message => message.includes('preserving last good data')));
  feed = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:recovery\nSUMMARY:Recovery conference\nDTSTART;VALUE=DATE:20261002\nEND:VEVENT\nEND:VCALENDAR';
  await seed();
  assert.deepEqual(writes.map(([key]) => key), [
    'research:tech-events:v1',
    'research:tech-events-bootstrap:v1',
    RELAY_META_KEY,
  ]);
  assert.equal(writes[0][1].events.length, 1);
  assert.equal(writes[0][1].events[0].source, 'techmeme');
});
