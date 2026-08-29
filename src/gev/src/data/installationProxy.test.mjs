// Mapped-installation proxy persistence (field test 2026-08-18: "search
// nearby sites" was slow because every look around paid a live Overpass round
// trip, and the 5-minute memory tier died with the dev server).
//
// The bbox/TTL cases below are pure; the cache-tier cases drive the REAL
// read/write code against a REAL temp directory — miss, write, restart, disk
// hit, expiry, serve-stale, and a torn write — so the persistence claims are
// exercised rather than asserted.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  militaryInstallationCacheKey,
  militaryInstallationDiskFresh,
  militaryInstallationDiskPath,
  migrateMilitaryInstallationEntry,
  quantizeMilitaryInstallationBox,
  readMilitaryInstallationDisk,
  resolveMilitaryInstallationTier,
  validMilitaryInstallationBox,
  writeMilitaryInstallationDisk,
} from '../../vite.config.js';

const DAY_MS = 86_400_000;
const TTL_MS = 30 * DAY_MS;

/** An entry shaped exactly like what the proxy writes. */
function entry(cachedAt, elements = [{ type: 'node', id: 1 }]) {
  return {
    payload: { elements, saturated: false, retrievedAt: new Date(cachedAt).toISOString(), status: 'ready' },
    cachedAt,
  };
}

function tempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gev-installations-'));
}

test('the cache bbox snaps OUTWARD so a cached answer always covers the request', () => {
  const requested = { south: 30.2612, west: -97.7431, north: 30.2884, east: -97.7099 };
  const snapped = quantizeMilitaryInstallationBox(requested);
  assert.deepEqual(snapped, { south: 30.25, west: -97.75, north: 30.3, east: -97.7 });
  assert.ok(snapped.south <= requested.south, 'south only ever grows outward');
  assert.ok(snapped.west <= requested.west, 'west only ever grows outward');
  assert.ok(snapped.north >= requested.north, 'north only ever grows outward');
  assert.ok(snapped.east >= requested.east, 'east only ever grows outward');
});

test('a bbox already on the grid is left alone rather than pushed a whole cell', () => {
  const onGrid = { south: 30.25, west: -97.75, north: 30.3, east: -97.7 };
  assert.deepEqual(quantizeMilitaryInstallationBox(onGrid), onGrid);
  // 29.9999/0.05 lands a hair under an exact grid line in binary floating point.
  assert.deepEqual(
    quantizeMilitaryInstallationBox({ south: 29.9999, west: 0, north: 30.05, east: 0.1 }),
    { south: 29.95, west: 0, north: 30.05, east: 0.1 },
  );
});

test('nearby viewports share one cache key while a distant one does not', () => {
  const key = (box) => militaryInstallationCacheKey(quantizeMilitaryInstallationBox(box));
  const base = key({ south: 30.2612, west: -97.7431, north: 30.2884, east: -97.7099 });
  const nudged = key({ south: 30.2634, west: -97.7402, north: 30.2871, east: -97.7104 });
  const panned = key({ south: 31.2612, west: -96.7431, north: 31.2884, east: -96.7099 });
  assert.equal(base, nudged, 'a sub-cell pan reuses the persisted answer');
  assert.notEqual(base, panned, 'a real move still fetches its own area');
  assert.equal(base, '30.250,-97.750,30.300,-97.700');
});

test('snapping never pushes a bbox off the globe', () => {
  const polar = quantizeMilitaryInstallationBox({ south: -89.99, west: -179.99, north: 89.99, east: 179.99 });
  assert.ok(polar.south >= -90 && polar.north <= 90);
  assert.ok(polar.west >= -180 && polar.east <= 180);
});

test('the snapped bbox stays acceptable to the request validator', () => {
  const params = new URLSearchParams({ south: '30.26120', west: '-97.74310', north: '30.28840', east: '-97.70990' });
  const requested = validMilitaryInstallationBox(params);
  const snapped = quantizeMilitaryInstallationBox(requested);
  assert.ok(snapped.south < snapped.north && snapped.west < snapped.east);
});

test('exact-viewport answers are keyed apart from snapped ones', () => {
  const box = { south: 30.26, west: -97.74, north: 30.28, east: -97.71 };
  const snapped = militaryInstallationCacheKey(quantizeMilitaryInstallationBox(box));
  const exact = `exact:${militaryInstallationCacheKey(box, 5)}`;
  assert.notEqual(snapped, exact, 'a saturated retry must never overwrite the shared tile');
  assert.notEqual(militaryInstallationDiskPath(snapped), militaryInstallationDiskPath(exact));
});

test('exact-viewport keys carry the same precision as the query bounds', () => {
  // The exact path queries the RAW viewport at 5 decimals. Keying at 3 would
  // collide two different queries, and the second view would be served an
  // answer missing the edge strip it just exposed.
  const a = { south: 30.26120, west: -97.74310, north: 30.28840, east: -97.70990 };
  const b = { south: 30.26140, west: -97.74290, north: 30.28860, east: -97.70970 };
  assert.notEqual(
    militaryInstallationCacheKey(a, 5),
    militaryInstallationCacheKey(b, 5),
    'two nearby exact viewports must not share an entry',
  );
  assert.equal(militaryInstallationCacheKey(a, 5), '30.26120,-97.74310,30.28840,-97.70990');
  // The snapped path lives on a 0.05 deg grid, where 3 decimals is exact.
  assert.equal(
    militaryInstallationCacheKey(quantizeMilitaryInstallationBox(a)),
    militaryInstallationCacheKey(quantizeMilitaryInstallationBox(b)),
    'the shared snapped tile still collapses neighbours on purpose',
  );
});

test('a pre-fix cache entry derives its missing saturation flag instead of lying', async () => {
  const now = 1_700_000_000_000;
  const atCap = { payload: { elements: new Array(700).fill({ type: 'node' }), retrievedAt: '', status: 'ready' }, cachedAt: now };
  const underCap = { payload: { elements: new Array(699).fill({ type: 'node' }), retrievedAt: '', status: 'ready' }, cachedAt: now };
  assert.equal(migrateMilitaryInstallationEntry(atCap).payload.saturated, true);
  assert.equal(migrateMilitaryInstallationEntry(underCap).payload.saturated, false);
  // An entry that already states it is authoritative.
  const explicit = { payload: { elements: new Array(700).fill({}), saturated: false }, cachedAt: now };
  assert.equal(migrateMilitaryInstallationEntry(explicit).payload.saturated, false);
  assert.equal(migrateMilitaryInstallationEntry(null), null);

  // End to end through a real file written in the OLD shape: the 30-day TTL
  // means these entries would otherwise skip the exact retry for a month.
  const dir = tempCacheDir();
  try {
    await fsp.mkdir(dir, { recursive: true });
    // Written recently, in the OLD shape — the case the 30-day TTL keeps alive.
    const legacyOnDisk = { ...atCap, cachedAt: Date.now() };
    await fsp.writeFile(militaryInstallationDiskPath('legacy', dir), JSON.stringify(legacyOnDisk));
    const read = await readMilitaryInstallationDisk('legacy', TTL_MS, dir);
    assert.equal(read.payload.saturated, true, 'the client must be told to re-ask for its exact viewport');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('persisted installations stay fresh for 30 days and no longer', () => {
  const now = 1_700_000_000_000;
  assert.equal(militaryInstallationDiskFresh(entry(now - DAY_MS), undefined, now), true);
  assert.equal(militaryInstallationDiskFresh(entry(now - 29 * DAY_MS), undefined, now), true);
  assert.equal(militaryInstallationDiskFresh(entry(now - 31 * DAY_MS), undefined, now), false);
  // The serve-stale path accepts any age when Overpass is down.
  assert.equal(militaryInstallationDiskFresh(entry(now - 400 * DAY_MS), Infinity, now), true);
});

test('a malformed or truncated disk entry is never served', () => {
  const now = 1_700_000_000_000;
  assert.equal(militaryInstallationDiskFresh(null, undefined, now), false);
  assert.equal(militaryInstallationDiskFresh({ payload: { elements: [] } }, undefined, now), false);
  assert.equal(militaryInstallationDiskFresh({ cachedAt: now }, undefined, now), false);
  assert.equal(militaryInstallationDiskFresh({ payload: {}, cachedAt: now }, undefined, now), false);
  assert.equal(militaryInstallationDiskFresh({ payload: { elements: 'nope' }, cachedAt: now }, undefined, now), false);
});

test('a real miss, write, and restart round trip serves from disk', async () => {
  const dir = tempCacheDir();
  const key = '30.250,-97.750,30.300,-97.700';
  const inFlight = new Map();
  let memory = new Map();
  const readDisk = (maxAgeMs = TTL_MS) => readMilitaryInstallationDisk(key, maxAgeMs, dir);

  try {
    // Cold everything: nothing on disk, nothing in memory.
    const miss = await resolveMilitaryInstallationTier({ cacheKey: key, memoryCache: memory, inFlight, readDisk });
    assert.equal(miss.source, 'UPSTREAM');

    // The proxy answers and persists.
    const fresh = entry(Date.now());
    memory.set(key, fresh);
    assert.equal(await writeMilitaryInstallationDisk(key, fresh, dir), true);
    assert.equal(fs.existsSync(militaryInstallationDiskPath(key, dir)), true);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
      'no temp file is left behind',
    );

    const hit = await resolveMilitaryInstallationTier({ cacheKey: key, memoryCache: memory, inFlight, readDisk });
    assert.equal(hit.source, 'HIT');

    // Dev-server restart: memory is gone, disk is not.
    memory = new Map();
    const afterRestart = await resolveMilitaryInstallationTier({ cacheKey: key, memoryCache: memory, inFlight, readDisk });
    assert.equal(afterRestart.source, 'DISK');
    assert.deepEqual(afterRestart.entry.payload.elements, fresh.payload.elements);

    // A memory entry past the 5-minute window falls through to disk too.
    memory.set(key, entry(Date.now() - 6 * 60_000));
    const staleMemory = await resolveMilitaryInstallationTier({ cacheKey: key, memoryCache: memory, inFlight, readDisk });
    assert.equal(staleMemory.source, 'DISK');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an in-flight request is joined instead of paying for a disk read', async () => {
  const dir = tempCacheDir();
  const key = 'inflight-key';
  let diskReads = 0;
  try {
    await writeMilitaryInstallationDisk(key, entry(Date.now()), dir);
    const result = await resolveMilitaryInstallationTier({
      cacheKey: key,
      memoryCache: new Map(),
      inFlight: new Map([[key, Promise.resolve({})]]),
      readDisk: () => { diskReads += 1; return readMilitaryInstallationDisk(key, TTL_MS, dir); },
    });
    assert.equal(result.source, 'UPSTREAM', 'the caller coalesces onto the live request');
    assert.equal(diskReads, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an expired disk entry stops answering, but still serves stale when upstream is down', async () => {
  const dir = tempCacheDir();
  const key = 'expiry-key';
  try {
    await writeMilitaryInstallationDisk(key, entry(Date.now() - 31 * DAY_MS), dir);
    assert.equal(await readMilitaryInstallationDisk(key, TTL_MS, dir), null, 'past its TTL for a normal read');
    const stale = await readMilitaryInstallationDisk(key, Infinity, dir);
    assert.ok(stale, 'last-good context at ANY age beats an empty layer');
    assert.equal(stale.payload.status, 'ready');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a torn write leaves the previous entry readable', async () => {
  const dir = tempCacheDir();
  const key = 'atomic-key';
  const target = militaryInstallationDiskPath(key, dir);
  try {
    const good = entry(Date.now(), [{ type: 'node', id: 'original' }]);
    await writeMilitaryInstallationDisk(key, good, dir);

    // Simulate a crash partway through a REPLACEMENT write: the temp sibling is
    // half-written and never renamed. An in-place overwrite would have shredded
    // the target here.
    await fsp.writeFile(`${target}.crashed.tmp`, '{"payload":{"elements":[{"type":"nod');

    const survivor = await readMilitaryInstallationDisk(key, TTL_MS, dir);
    assert.ok(survivor, 'the previous entry is still readable after a torn write');
    assert.deepEqual(survivor.payload.elements, [{ type: 'node', id: 'original' }]);

    // And a genuinely corrupt TARGET is rejected rather than served.
    await fsp.writeFile(target, '{"payload":{"elements":[');
    assert.equal(await readMilitaryInstallationDisk(key, TTL_MS, dir), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an unwritable cache directory degrades to a miss instead of throwing', async () => {
  const dir = tempCacheDir();
  const blocked = path.join(dir, 'blocked');
  try {
    // A FILE where the cache directory should be: mkdir must fail.
    await fsp.writeFile(blocked, 'not a directory');
    assert.equal(await writeMilitaryInstallationDisk('key', entry(Date.now()), blocked), false);
    assert.equal(await readMilitaryInstallationDisk('key', TTL_MS, blocked), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
