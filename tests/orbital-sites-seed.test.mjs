// The site seeder keeps one canonical record per watched site and a per-country projection
// of those records. A failed or refused archive never erases evidence, an absent scene is
// "no observation" rather than a reset, and a run that runs out of time resumes later.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { buildCatalog } from '../scripts/_orbital-catalog.mjs';
import {
  ArchiveRefusal,
  acquisitionsFromStac,
  buildCountryRollup,
  buildSiteRecord,
  countryKey,
  isRollupCurrent,
  ORBITAL_SITES_ACTIVATION_KEY,
  ORBITAL_SITES_KEY,
  ROLLUP_MAX_AGE_MS,
  ROLLUP_MAX_BYTES,
  siteKey,
} from '../scripts/_orbital-sites.mjs';
import { buildSeedOptions, makeFetchSites, publicationCommands } from '../scripts/seed-orbital-sites.mjs';
import { PUBLISH_BLOCKED_EXIT_CODE } from '../scripts/_seed-utils.mjs';
import { WATCHED_SITES } from '../scripts/shared/orbital-watched-sites.generated.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const celestrakFixture = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8'));
const stacFixtureText = readFileSync(new URL('./fixtures/orbital/stac-search-abu-dhabi-2026-11-13.json', import.meta.url), 'utf8');
const stacFixture = JSON.parse(stacFixtureText);
const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY_MS = 86_400_000;
const catalog = buildCatalog({ records: celestrakFixture.records, previous: null, nowMs: NOW });
const fixtureAcquisitions = acquisitionsFromStac(stacFixture.features);

const site = (id, countryCode, lat, lon) => ({ id, name: id, lat, lon, countryCode, surface: 'land', origins: [{ list: 'hotspot', id }] });
const SITES = [
  site('hotspot:a', 'AE', 24.4, 54.6),
  site('hotspot:b', 'AE', 24.2, 54.4),
  site('hotspot:c', 'OM', 23.6, 58.4),
  site('hotspot:d', 'OM', 22.9, 57.5),
];

function memoryStore() {
  const kv = new Map();
  const store = {
    kv,
    expired: [],
    readCatalog: async () => catalog,
    readIndex: async () => kv.get(ORBITAL_SITES_KEY) ?? null,
    readRecords: async (ids) => new Map(ids.filter((id) => kv.has(siteKey(id))).map((id) => [id, kv.get(siteKey(id))])),
    write: async (commands) => {
      for (const [verb, key, value] of commands) {
        if (verb === 'DEL') kv.delete(key);
        else if (verb === 'EXPIRE') store.expired.push(key);
        else kv.set(key, key === ORBITAL_SITES_ACTIVATION_KEY ? value : JSON.parse(value));
      }
    },
  };
  return store;
}

async function run(store, { sites = SITES, searchArchive = async () => fixtureAcquisitions, nowMs = NOW, budgetMs = 60_000, clock } = {}) {
  const { fetchSites, publishAtomically } = makeFetchSites({ store, searchArchive, sites, registryVersion: 'test', budgetMs, clock: clock ?? (() => nowMs) });
  const index = await fetchSites();
  if (index.publishBlocked) return index;
  await publishAtomically(index, { canonicalKey: ORBITAL_SITES_KEY, payload: JSON.stringify(index), ttlSeconds: 60 });
  return index;
}

describe('orbital site records', () => {
  it('lists and counts only passes whose footprint covers the site', () => {
    const record = buildSiteRecord({ site: SITES[0], catalog, acquisitions: [], previous: null, nowMs: NOW });
    const overhead = record.coverage.reduce((sum, entry) => sum + entry.passes, 0);
    assert.ok(record.nextWindows.length > 0);
    assert.ok(overhead >= record.recentPasses.length + record.nextWindows.length, 'coverage counts imaging passes');
    for (const window of record.nextWindows) assert.equal('inFootprint' in window, false);
  });

  it('confirms an image only for the spacecraft that took it', () => {
    const scene = fixtureAcquisitions.find((a) => a.itemId.startsWith('S1D_IW_GRDH_1SDV_20261111T1423'));
    const base = buildSiteRecord({ site: SITES[0], catalog, acquisitions: [scene], previous: null, nowMs: NOW });
    assert.deepEqual(base.recentPasses.filter((pass) => pass.itemId === scene.itemId).map((pass) => pass.name), ['SENTINEL-1D']);
    const relabelled = buildSiteRecord({ site: SITES[0], catalog, acquisitions: [{ ...scene, platform: 'sentinel-1c' }], previous: null, nowMs: NOW });
    assert.equal(relabelled.recentPasses.some((pass) => pass.itemId === scene.itemId), false);
  });

  it('keeps last week of passes when the stored elements are older than the age limit today', () => {
    const later = NOW + 7.5 * DAY_MS;
    const record = buildSiteRecord({ site: SITES[0], catalog, acquisitions: [], previous: null, nowMs: later });
    assert.ok(record.recentPasses.length > 0, 'historical days within the element age limit still yield passes');
    assert.ok(record.recentPasses.every((pass) => Date.parse(pass.time) <= NOW + 7 * DAY_MS));
  });

  it('writes one record per site with its newest confirmed image, next windows and coverage', async () => {
    const store = memoryStore();
    const index = await run(store);
    assert.deepEqual(Object.keys(index.sites), SITES.map((s) => s.id));
    const record = store.kv.get(siteKey('hotspot:a'));
    assert.equal(record.lastObservation.itemId, fixtureAcquisitions[0].itemId);
    assert.ok(record.nextWindows.length > 0 && record.nextWindows.every((w) => Date.parse(w.time) > NOW));
    assert.ok(record.recentPasses.some((p) => p.tier === 'confirmed-image' && p.itemId), 'an archive scene confirms a computed pass');
    assert.ok(record.coverage.some((c) => c.category === 'military'), 'reconnaissance coverage by operator');
    assert.equal(store.kv.get(ORBITAL_SITES_ACTIVATION_KEY), '1');
  });

  it('keeps the last observation date and flag state when no new scene exists', async () => {
    const store = memoryStore();
    await run(store);
    const before = store.kv.get(siteKey('hotspot:a'));
    store.kv.set(siteKey('hotspot:a'), { ...before, flag: { state: 'monitoring' } });
    await run(store, { searchArchive: async () => [], nowMs: NOW + DAY_MS });
    const after = store.kv.get(siteKey('hotspot:a'));
    assert.deepEqual(after.lastObservation, before.lastObservation);
    assert.deepEqual(after.flag, { state: 'monitoring' });
    assert.equal(after.evaluatedAt, NOW + DAY_MS);
  });

  it('leaves records unchanged for sites whose archive search failed and updates the rest', async () => {
    const store = memoryStore();
    await run(store);
    const before = new Map(SITES.map((s) => [s.id, store.kv.get(siteKey(s.id))]));
    const failing = new Set(['hotspot:a', 'hotspot:c']);
    const index = await run(store, {
      nowMs: NOW + DAY_MS,
      searchArchive: async (s) => { if (failing.has(s.id)) throw new Error('HTTP 503'); return fixtureAcquisitions; },
    });
    for (const s of SITES) {
      const after = store.kv.get(siteKey(s.id));
      if (failing.has(s.id)) assert.deepEqual(after, before.get(s.id), s.id);
      else assert.equal(after.evaluatedAt, NOW + DAY_MS, s.id);
    }
    assert.deepEqual(index.failed.map((f) => f.siteId), ['hotspot:a', 'hotspot:c']);
    assert.deepEqual(store.expired, [siteKey('hotspot:a'), siteKey('hotspot:c')], 'kept records do not expire');
  });

  it('reports to health only the sites evaluated within the rollup freshness limit', async () => {
    const store = memoryStore();
    await run(store);
    const later = await run(store, { nowMs: NOW + ROLLUP_MAX_AGE_MS + DAY_MS, searchArchive: async (s) => { if (s.id !== 'hotspot:a') throw new Error('HTTP 503'); return fixtureAcquisitions; } });
    assert.equal(Object.keys(later.sites).length, 4);
    assert.equal(buildSeedOptions().declareRecords(later), 1);
  });

  it('deletes the record and the country rollup of a site removed from the registry', async () => {
    const store = memoryStore();
    await run(store);
    const index = await run(store, { sites: SITES.filter((s) => s.countryCode !== 'OM').concat(SITES[2]).filter((s) => s.id !== 'hotspot:d') });
    assert.equal(store.kv.has(siteKey('hotspot:d')), false);
    assert.equal(index.sites['hotspot:d'], undefined);
    await run(store, { sites: SITES.slice(0, 2) });
    assert.equal(store.kv.has(siteKey('hotspot:c')), false);
    assert.equal(store.kv.has(countryKey('OM')), false);
    assert.ok(store.kv.has(countryKey('AE')));
  });

  it('exits publish-blocked on an archive refusal and preserves every record', async () => {
    const store = memoryStore();
    await run(store);
    const snapshot = structuredClone([...store.kv.entries()]);
    const result = await run(store, { nowMs: NOW + DAY_MS, searchArchive: async () => { throw new ArchiveRefusal('HTTP 403'); } });
    assert.match(result.publishBlocked, /403/);
    assert.deepEqual([...store.kv.entries()], snapshot);
  });

  it('stops at its time budget and the next run resumes at the first unevaluated site', async () => {
    const store = memoryStore();
    let ticks = 0;
    const first = await run(store, { budgetMs: 3, clock: () => NOW + ticks++ });
    assert.equal(first.evaluated, 2);
    assert.equal(first.nextSiteId, 'hotspot:c');
    assert.deepEqual(Object.keys(first.sites), ['hotspot:a', 'hotspot:b']);
    const seen = [];
    const second = await run(store, { nowMs: NOW + DAY_MS, searchArchive: async (s) => { seen.push(s.id); return fixtureAcquisitions; } });
    assert.deepEqual(seen, ['hotspot:c', 'hotspot:d', 'hotspot:a', 'hotspot:b']);
    assert.equal(second.nextSiteId, null);
  });
});

describe('orbital country rollups', () => {
  it('holds only its own sites and stays under the per-key size limit', async () => {
    const store = memoryStore();
    await run(store);
    const om = store.kv.get(countryKey('OM'));
    assert.deepEqual(om.sites.map((s) => s.siteId), ['hotspot:c', 'hotspot:d']);
    const records = WATCHED_SITES.filter((s) => s.countryCode === 'US').map((s) => ({ ...store.kv.get(siteKey('hotspot:a')), siteId: s.id, countryCode: 'US', name: s.name }));
    const us = buildCountryRollup('US', records);
    assert.ok(Buffer.byteLength(JSON.stringify(us)) < ROLLUP_MAX_BYTES, `${records.length} US sites fit`);
  });

  it('carries the revision of its site records, and a reader rejects a stale or superseded rollup', async () => {
    const store = memoryStore();
    await run(store);
    const index = store.kv.get(ORBITAL_SITES_KEY);
    const ae = store.kv.get(countryKey('AE'));
    assert.deepEqual(ae.sites.map((s) => s.revision), ['hotspot:a', 'hotspot:b'].map((id) => index.sites[id].revision));
    assert.equal(isRollupCurrent(ae, index, NOW + DAY_MS), true);
    assert.equal(isRollupCurrent(ae, index, NOW + ROLLUP_MAX_AGE_MS + 1), false, 'too old');
    assert.equal(isRollupCurrent({ ...ae, revision: 'other' }, index, NOW), false, 'not the revision the index names');
  });

  it('rebuilds byte-identically from unchanged site records', async () => {
    const store = memoryStore();
    await run(store);
    const records = SITES.map((s) => store.kv.get(siteKey(s.id)));
    assert.equal(JSON.stringify(buildCountryRollup('AE', records)), JSON.stringify(store.kv.get(countryKey('AE'))));
    assert.equal(JSON.stringify(buildCountryRollup('AE', [...records].reverse())), JSON.stringify(buildCountryRollup('AE', records)));
  });

  it('publishes site records and rollups before the index that names them', () => {
    const commands = publicationCommands(
      { siteWrites: [{ siteId: 'hotspot:a' }], retainedSiteIds: ['hotspot:b'], rollupWrites: [{ countryCode: 'AE' }], deletes: ['orbital:site:v1:gone'] },
      { canonicalKey: ORBITAL_SITES_KEY, payload: '{}', ttlSeconds: 60 },
    );
    assert.deepEqual(commands.map(([verb, key]) => `${verb} ${key}`), [
      `SET ${siteKey('hotspot:a')}`, `EXPIRE ${siteKey('hotspot:b')}`, `SET ${countryKey('AE')}`, 'DEL orbital:site:v1:gone', `SET ${ORBITAL_SITES_KEY}`, `SET ${ORBITAL_SITES_ACTIVATION_KEY}`,
    ]);
  });
});

const preload = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const values = new Map(Object.entries(JSON.parse(process.env.TEST_INITIAL || '{}')));
const initial = Object.fromEntries(values);
const writes = [];
const command = ([verb, key, ...args]) => {
  if (verb === 'EVAL') {
    const [numKeys, ...rest] = args;
    const keys = [key, ...rest].slice(1, 1 + Number(numKeys));
    const argv = rest.slice(Number(numKeys)).map(String);
    const current = values.get(keys[0]);
    if (!key.includes('PEXPIRE')) { if (current === argv[0]) { values.delete(keys[0]); return 1; } return 0; }
    if (current !== argv[0]) return [0, current ?? ''];
    if (keys.length === 2) { writes.push(keys[1]); values.set(keys[1], argv[2]); }
    return [1, ''];
  }
  if (verb === 'GET') return values.get(key) ?? null;
  if (verb === 'MGET') return [key, ...args].map((k) => values.get(k) ?? null);
  if (verb === 'EXISTS') return values.has(key) ? 1 : 0;
  if (verb === 'SET') {
    if (args.includes('NX') && values.has(key)) return null;
    writes.push(key);
    values.set(key, args[0]);
    return 'OK';
  }
  if (verb === 'EXPIRE' || verb === 'PEXPIRE') return values.has(key) ? 1 : 0;
  if (verb === 'DEL') { writes.push(key); values.delete(key); return 1; }
  if (verb === 'TTL' || verb === 'PTTL') return values.has(key) ? 86400 : -2;
  throw new Error('Unexpected Redis command ' + verb);
};
let archiveCalls = 0;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'seed-test.invalid') {
    if (url.pathname.startsWith('/get/')) return Response.json({ result: values.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
    const body = JSON.parse(options.body);
    if (url.pathname === '/pipeline' || url.pathname === '/multi-exec') return Response.json(body.map((item) => ({ result: command(item) })));
    return Response.json({ result: command(body) });
  }
  if (url.hostname === 'planetarycomputer.microsoft.com') {
    archiveCalls++;
    if (process.env.TEST_MODE === 'forbidden') return new Response('forbidden', { status: 403 });
    return new Response(readFileSync(process.env.TEST_STAC_FILE), { headers: { 'content-type': 'application/geo+json' } });
  }
  throw new Error('fixture source unavailable: ' + url.hostname);
};
process.on('exit', () => {
  writeFileSync(process.env.TEST_STATE_FILE, JSON.stringify({ writes, archiveCalls, initial, values: Object.fromEntries(values) }));
});
`;

function runSeeder({ mode = 'ok', initial = {}, budgetMs = 4_000, enabled = 'true' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-sites-seed-'));
  const preloadPath = join(dir, 'preload.mjs');
  writeFileSync(preloadPath, preload);
  const envFile = join(dir, 'empty.env');
  writeFileSync(envFile, '');
  const stacFile = join(dir, 'stac.json');
  writeFileSync(stacFile, stacFixtureText);
  const stateFile = join(dir, 'state.json');
  try {
    const result = spawnSync(process.execPath, ['--import', preloadPath, 'seed-orbital-sites.mjs'], {
      cwd: join(root, 'scripts'),
      env: {
        PATH: process.env.PATH,
        UPSTASH_REDIS_REST_URL: 'https://seed-test.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
        WM_SEED_RETRY_DELAY_MS: '0',
        WM_SEED_ENV_FILE: envFile,
        ORBITAL_SITES_RUN_BUDGET_MS: String(budgetMs),
        TEST_MODE: mode,
        TEST_STAC_FILE: stacFile,
        TEST_STATE_FILE: stateFile,
        TEST_INITIAL: JSON.stringify(initial),
        ORBITAL_WATCH_ENABLED: enabled,
      },
      encoding: 'utf8',
      timeout: 90_000,
    });
    assert.ifError(result.error);
    assert.ok(existsSync(stateFile), result.stdout + result.stderr);
    return { ...result, state: JSON.parse(readFileSync(stateFile, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const catalogEnvelope = () => JSON.stringify(buildCatalog({ records: celestrakFixture.records, previous: null, nowMs: Date.now() }));

describe('seed-orbital-sites run', () => {
  it('publishes the evaluated sites, a healthy seed-meta row and the activation marker within its budget', () => {
    const r = runSeeder({ initial: { 'orbital:catalog:v1': catalogEnvelope() } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { values } = r.state;
    const index = JSON.parse(values[ORBITAL_SITES_KEY]).data;
    const ids = Object.keys(index.sites);
    assert.ok(ids.length > 0 && ids.length < WATCHED_SITES.length, `${ids.length} sites inside a short budget`);
    assert.equal(index.nextSiteId, [...WATCHED_SITES].map((s) => s.id).sort()[ids.length]);
    for (const id of ids) assert.equal(JSON.parse(values[siteKey(id)]).siteId, id);
    const meta = JSON.parse(values['seed-meta:orbital:sites']);
    assert.equal(meta.recordCount, ids.length);
    assert.ok(meta.fetchedAt > Date.now() - 120_000);
    assert.equal(values[ORBITAL_SITES_ACTIVATION_KEY], '1');
  });

  it('stays dark without ORBITAL_WATCH_ENABLED: no archive search and no writes (#10710)', () => {
    const r = runSeeder({ initial: { 'orbital:catalog:v1': catalogEnvelope() }, enabled: '' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.state.archiveCalls, 0);
    assert.deepEqual(r.state.writes, []);
    assert.match(r.stdout, /ships dark/);
  });

  it('exits 76 on an archive refusal and writes nothing', () => {
    const record = JSON.stringify({ siteId: WATCHED_SITES[0].id, kept: true });
    const initial = { 'orbital:catalog:v1': catalogEnvelope(), [siteKey(WATCHED_SITES[0].id)]: record };
    const r = runSeeder({ mode: 'forbidden', initial });
    assert.equal(r.status, PUBLISH_BLOCKED_EXIT_CODE, r.stdout + r.stderr);
    assert.equal(r.state.archiveCalls, 1, 'a refusal stops the run');
    assert.equal(r.state.values[siteKey(WATCHED_SITES[0].id)], record);
    assert.ok(!r.state.writes.some((key) => key.startsWith('orbital:') || key === 'seed-meta:orbital:sites'), `writes ${r.state.writes}`);
  });
});
