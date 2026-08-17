import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing__ as healthTesting } from '../api/health.js';
import {
  CHROME_UA,
  VIA_RAIL_LIVE_ALLOWED_HOSTS,
  VIA_RAIL_LIVE_CACHE_KEY,
  VIA_RAIL_LIVE_HOST,
  VIA_RAIL_LIVE_KEY,
  VIA_RAIL_LIVE_MAX_STALE_MIN,
  VIA_RAIL_LIVE_META_KEY,
  VIA_RAIL_LIVE_URL,
  fetchViaRailLive,
  ingestViaRailLive,
  isAllowedViaRailLiveHost,
  parseViaRailLive,
  resolveViaRailLivePublish,
  validateViaRailLiveSnapshot,
} from '../scripts/viarail-live.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const fixture = JSON.parse(read('tests/fixtures/viarail-live/allData.json'));

function stubResponse(payload, {
  url = VIA_RAIL_LIVE_URL,
  status = 200,
  redirected = false,
  headers = {},
} = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const bytes = Buffer.byteLength(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    url,
    headers: new Headers({
      'Content-Type': 'application/json',
      'Content-Length': String(bytes),
      ...headers,
    }),
    text: async () => body,
    body: null,
  };
}

describe('VIA Rail live parser (#6615)', () => {
  it('parses captured allData.json with lat/lng, speed, direction, and per-station diffMin', () => {
    const snapshot = parseViaRailLive(fixture, { fetchedAt: 1_700_000_000_000 });
    assert.equal(validateViaRailLiveSnapshot(snapshot), true);
    const live = snapshot.trains.find((train) => train.id === '37');
    assert.ok(live, 'fixture includes corridor train 37');
    assert.equal(typeof live.lat, 'number');
    assert.equal(typeof live.lng, 'number');
    assert.ok(Number.isFinite(live.lat) && Number.isFinite(live.lng));
    assert.equal(typeof live.speed, 'number');
    assert.equal(typeof live.direction, 'number');
    assert.ok(live.stations.length >= 3);
    const delayed = live.stations.find((stop) => stop.diffMin > 0);
    assert.ok(delayed, 'fixture includes a delayed station');
    assert.equal(typeof delayed.scheduled, 'string');
    assert.equal(typeof delayed.estimated, 'string');
    assert.notEqual(delayed.scheduled, delayed.estimated);
    assert.equal(delayed.diffMin, 16);
  });

  it('keeps bilingual alerts when the unofficial payload includes them', () => {
    const snapshot = parseViaRailLive(fixture);
    const withAlerts = snapshot.trains.find((train) => train.alerts.length > 0);
    assert.ok(withAlerts, 'fixture includes a bilingual alert');
    assert.equal(typeof withAlerts.alerts[0].header.en, 'string');
    assert.equal(typeof withAlerts.alerts[0].header.fr, 'string');
    assert.match(withAlerts.alerts[0].header.en, /advisory|delayed|train/i);
    assert.match(withAlerts.alerts[0].header.fr, /avis|retard|train/i);
  });

  it('treats null / empty-string / array coordinates as absent, not as 0,0', () => {
    // Number(null) === 0, Number('') === 0, Number([]) === 0 — all finite. A
    // train reporting no position must NOT normalize to Null Island and must not
    // satisfy the has-position gate, or a degraded 200 overwrites last-good with
    // a fleet parked off the coast of Africa.
    // Before the fix each of these coerced to 0, satisfied the has-position gate,
    // and published a valid snapshot. Now they are absent, nothing is
    // publishable, and the parser fails closed so last-good survives.
    for (const absent of [null, '', [], undefined, {}, true]) {
      assert.throws(
        () => parseViaRailLive({
          '37': { from: 'MTRL', to: 'TRTO', lat: absent, lng: absent, times: [{ diffMin: 4 }] },
        }, { fetchedAt: 1_700_000_000_000 }),
        { reason: 'shape_break' },
        `lat/lng ${JSON.stringify(absent)} must not publish as 0,0`,
      );
    }

    // And a train whose position is absent must not report 0,0 alongside a
    // sibling that does have one.
    const mixed = parseViaRailLive({
      '37': { from: 'MTRL', to: 'TRTO', lat: 45.5, lng: -73.5, times: [{ diffMin: 4 }] },
      '38': { from: 'TRTO', to: 'MTRL', lat: null, lng: '', times: [{ diffMin: 2 }] },
    }, { fetchedAt: 1_700_000_000_000 });
    const absentTrain = mixed.trains.find((row) => row.id === '38');
    assert.equal(absentTrain.lat, null);
    assert.equal(absentTrain.lng, null);
  });

  it('still accepts a genuine zero coordinate and numeric strings', () => {
    const snapshot = parseViaRailLive({
      '37': { from: 'MTRL', to: 'TRTO', lat: 0, lng: '  -73.5  ', times: [{ diffMin: 4 }] },
    }, { fetchedAt: 1_700_000_000_000 });
    const train = snapshot.trains.find((row) => row.id === '37');
    assert.equal(train.lat, 0);
    assert.equal(train.lng, -73.5);
    assert.equal(validateViaRailLiveSnapshot(snapshot), true);
  });

  it('rejects a degraded 200 that is missing lat/lng + diffMin', () => {
    assert.throws(
      () => parseViaRailLive({ hello: 'world' }),
      { reason: 'shape_break' },
    );
    assert.throws(
      () => parseViaRailLive({ '99': { from: 'MTRL', to: 'TRTO', times: [] } }),
      { reason: 'shape_break' },
    );
    assert.equal(validateViaRailLiveSnapshot({ schemaVersion: 1, trains: [] }), false);
  });
});

describe('VIA Rail live ingest (404 / shape-break / last-good)', () => {
  it('404 → sourceState unavailable, not SEED_ERROR, and does not persist', async () => {
    const persisted = [];
    const unavailable = [];
    const decision = await ingestViaRailLive({
      fetchImpl: async () => stubResponse('not found', { status: 404 }),
      readLastGood: async () => null,
      persist: async (snapshot) => { persisted.push(snapshot); },
      writeUnavailableMeta: async (meta) => { unavailable.push(meta); },
    });
    assert.equal(decision.persist, false);
    assert.equal(decision.sourceState, 'unavailable');
    assert.equal(decision.reason, 'http_404');
    assert.equal(persisted.length, 0);
    assert.deepEqual(unavailable, [{ reason: 'http_404' }]);
    const classified = healthTesting.classifyKey(
      'viarailLive',
      VIA_RAIL_LIVE_KEY,
      { allowOnDemand: true },
      {
        keyStrens: new Map(),
        keyErrors: new Map(),
        keyMetaValues: new Map([[VIA_RAIL_LIVE_META_KEY, JSON.stringify({
          fetchedAt: Date.now(),
          recordCount: 0,
          sourceState: 'unavailable',
        })]]),
        keyMetaErrors: new Map(),
        now: Date.now(),
      },
    );
    assert.equal(classified.status, 'NOT_CONFIGURED');
    assert.equal(healthTesting.STATUS_COUNTS[classified.status], 'ok');
    assert.notEqual(classified.status, 'SEED_ERROR');
    assert.notEqual(healthTesting.STATUS_COUNTS[classified.status], 'crit');
  });

  it('shape-break 200 does not persist and keeps last-good', async () => {
    const lastGood = parseViaRailLive(fixture);
    const persisted = [];
    const unavailable = [];
    const decision = await ingestViaRailLive({
      fetchImpl: async () => stubResponse({ status: 'ok', trains: [] }),
      readLastGood: async () => lastGood,
      persist: async (snapshot) => { persisted.push(snapshot); },
      writeUnavailableMeta: async (meta) => { unavailable.push(meta); },
    });
    assert.equal(decision.persist, false);
    assert.equal(decision.keepLastGood, true);
    assert.equal(decision.sourceState, null);
    assert.equal(persisted.length, 0, 'degraded 200 must not poison last-good');
    assert.equal(unavailable.length, 0, 'last-good health stays in place');
    assert.equal(validateViaRailLiveSnapshot(lastGood), true);
  });

  it('resolveViaRailLivePublish treats failure as skip, not miss', () => {
    const lastGood = parseViaRailLive(fixture);
    const broken = resolveViaRailLivePublish(
      { ok: false, sourceState: 'unavailable', reason: 'shape_break' },
      lastGood,
    );
    assert.equal(broken.persist, false);
    assert.equal(broken.keepLastGood, true);
    const cold = resolveViaRailLivePublish(
      { ok: false, sourceState: 'unavailable', reason: 'http_404' },
      null,
    );
    assert.equal(cold.persist, false);
    assert.equal(cold.sourceState, 'unavailable');
  });
});

describe('VIA Rail live fetch contract', () => {
  it('allowlists tsimobile.viarail.ca and uses the URL as the cache key', async () => {
    assert.equal(VIA_RAIL_LIVE_CACHE_KEY, VIA_RAIL_LIVE_URL);
    assert.deepEqual(VIA_RAIL_LIVE_ALLOWED_HOSTS, [VIA_RAIL_LIVE_HOST]);
    assert.equal(isAllowedViaRailLiveHost(VIA_RAIL_LIVE_URL), true);
    assert.equal(isAllowedViaRailLiveHost('https://evil.example/data/allData.json'), false);
    assert.equal(isAllowedViaRailLiveHost('http://tsimobile.viarail.ca/data/allData.json'), false);

    const log = [];
    const blocked = await fetchViaRailLive({
      url: 'https://evil.example/data/allData.json',
      fetchImpl: async (url, init) => {
        log.push({ url, init });
        return stubResponse(fixture, { url });
      },
    });
    assert.equal(blocked.reason, 'host_not_allowlisted');
    assert.equal(log.length, 0, 'disallowed hosts must not be fetched');

    const seen = [];
    await fetchViaRailLive({
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return stubResponse(fixture, { url });
      },
    });
    assert.equal(seen[0].url, VIA_RAIL_LIVE_URL);
    assert.equal(seen[0].init.redirect, 'error');
    assert.equal(seen[0].init.headers['User-Agent'], CHROME_UA);
  });

  it('rejects redirects', async () => {
    const result = await fetchViaRailLive({
      fetchImpl: async () => stubResponse(fixture, { redirected: true }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'redirect_rejected');
  });
});

describe('VIA Rail live registration (no bootstrap / seeder import / ais-relay)', () => {
  it('registers a STANDALONE key with seed-meta, not bootstrap', () => {
    assert.equal(healthTesting.STANDALONE_KEYS.viarailLive, VIA_RAIL_LIVE_KEY);
    assert.equal(healthTesting.SEED_META.viarailLive.key, VIA_RAIL_LIVE_META_KEY);
    assert.equal(healthTesting.SEED_META.viarailLive.maxStaleMin, VIA_RAIL_LIVE_MAX_STALE_MIN);
    assert.equal(healthTesting.EMPTY_DATA_OK_KEYS.has('viarailLive'), true);
    assert.equal(Object.hasOwn(healthTesting.BOOTSTRAP_KEYS, 'viarailLive'), false);
    assert.equal(
      Object.values(healthTesting.BOOTSTRAP_KEYS).includes(VIA_RAIL_LIVE_KEY),
      false,
    );
    assert.equal(healthTesting.SEED_META.viarailLive.cutover?.mode, 'expiring-ack');
    assert.equal(healthTesting.SEED_META.viarailLive.cutover?.issue, 6615);
    assert.equal(healthTesting.SEED_META.viarailLive.cutover?.status, 'STALE_SEED');
  });

  it('does not import the seeder, bind fetch, or touch ais-relay', () => {
    const testSource = read('tests/viarail-live.test.mjs');
    assert.doesNotMatch(testSource, /from ['"].*seed-viarail-live/);
    assert.doesNotMatch(testSource, /from ['"].*ais-relay/);

    const parser = read('scripts/viarail-live.mjs');
    const seeder = read('scripts/seed-viarail-live.mjs');
    assert.doesNotMatch(parser, /fetch\.bind/);
    assert.doesNotMatch(seeder, /fetch\.bind/);
    assert.match(parser, /\(\.\.\.args\) => globalThis\.fetch\(\.\.\.args\)/);
    assert.match(seeder, /loadEnvFile/);
    assert.match(seeder, /runSeed/);
    assert.match(seeder, /sourceState: 'unavailable'/);
    assert.doesNotMatch(seeder, /SEED_ERROR/);
    assert.doesNotMatch(seeder, /ais-relay/);
    assert.doesNotMatch(parser, /ais-relay/);

    const relay = read('scripts/ais-relay.cjs');
    assert.doesNotMatch(relay, /viarail|tsimobile\.viarail\.ca/);
  });

  it('runs as a bundle member, not its own Railway service', () => {
    // An optional unofficial feed does not earn a dedicated Railway slot. This
    // seeder is a seed-bundle-canada (#6711) member gated on intervalMs 15min,
    // which is the cadence its standalone cron had. The freshness anchor must
    // therefore clear on BUNDLE provisioning, not on this branch deploying.
    const railway = JSON.parse(read('scripts/railway-services.json'));
    assert.equal(
      railway.some((entry) => entry.service === 'seed-viarail-live'),
      false,
      'a standalone row would claim a slot the bundle already covers',
    );
    // The ack was the bridge until the bundle existed. It exists now and
    // viarailLive publishes, so the ack was removed as satisfied — keeping it
    // would leave a suppression that silently absorbs a future VIA outage.
    // What still matters is that any ack still present names the right probe.
    const ack = JSON.parse(read('scripts/seed-freshness-baseline.json'))
      .acknowledged.find((row) => row.name === 'viarailLive');
    if (ack) assert.equal(ack.cutover.probeKey, 'seed-meta:transit:viarail-live');

    // The bundle must actually own it, or removing the ack leaves the probe
    // with no producer at all.
    const bundle = read('scripts/seed-bundle-canada.mjs');
    assert.match(bundle, /seedMetaKey:\s*'seed-meta:transit:viarail-live'/);
  });
});
