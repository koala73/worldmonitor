import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

import type { GetCableHealthResponse } from '../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { getCachedJson, __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { getCableHealth } from '../server/worldmonitor/infrastructure/v1/get-cable-health';
import { __testing__ as health } from '../api/health.js';
import { cableHealthToDigestInput } from '../shared/analysis-composite-adapters';
import { sidecarCacheGet, sidecarCacheSet } from '../server/_shared/sidecar-cache';

const CACHE_KEY = 'cable-health-v1';
const NGA_CACHE_KEY = 'cable-health-nga-warnings-v2';
const META_KEY = 'seed-meta:cable-health';
const NEG_SENTINEL = '__WM_NEG__';
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalEnv = new Map<string, string | undefined>();

// Execute the emitted Lua, with only Redis commands replaced by the fixture store.
function runRepairCommand(command: string[], call: (args: string[]) => unknown) {
  assert.equal(command[0], 'EVAL');
  assert.equal(command[2], '2');
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const push = (value: unknown) => {
    if (Array.isArray(value)) {
      lua.lua_createtable(state, value.length, 0);
      value.forEach((item, index) => { push(item); lua.lua_seti(state, -2, index + 1); });
    } else if (value == null) lua.lua_pushboolean(state, false);
    else if (typeof value === 'number') lua.lua_pushnumber(state, value);
    else lua.lua_pushstring(state, to_luastring(String(value)));
  };
  try {
    push(command.slice(3, 5));
    lua.lua_setglobal(state, to_luastring('KEYS'));
    push(command.slice(5));
    lua.lua_setglobal(state, to_luastring('ARGV'));
    lua.lua_createtable(state, 0, 1);
    lua.lua_pushjsfunction(state, () => {
      const args = Array.from({ length: lua.lua_gettop(state) }, (_, i) => to_jsstring(lua.lua_tostring(state, i + 1)));
      try { push(call(args)); } catch (error) { return lauxlib.luaL_error(state, to_luastring(String(error))); }
      return 1;
    });
    lua.lua_setfield(state, -2, to_luastring('call'));
    lua.lua_setglobal(state, to_luastring('redis'));
    const loaded = lauxlib.luaL_loadstring(state, to_luastring(command[1]!));
    const status = loaded === lua.LUA_OK ? lua.lua_pcall(state, 0, 1, 0) : loaded;
    return status === lua.LUA_OK
      ? { result: lua.lua_tonumber(state, -1) }
      : { error: to_jsstring(lua.lua_tostring(state, -1)) };
  } finally {
    lua.lua_close(state);
  }
}

function simpleRepairResponse(body: unknown, store: Map<string, unknown>) {
  const commands = JSON.parse(String(body)) as string[][];
  return Response.json(commands.map((command) => runRepairCommand(command, ([verb, key, value]) => {
    if (verb === 'GET') return store.has(key!) ? JSON.stringify(store.get(key!)) : null;
    if (verb === 'TIME') return [String(Math.floor(Date.now() / 1000)), String((Date.now() % 1000) * 1000)];
    if (verb === 'PEXPIREAT') return 1;
    assert.equal(verb, 'SET');
    store.set(key!, JSON.parse(value!));
    return 'OK';
  })));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function currentNgaDate() {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  const day = String(now.getUTCDate()).padStart(2, '0');
  const time = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return `${day}${time}Z ${month} ${now.getUTCFullYear()}`;
}

describe('getCableHealth cache publication', { concurrency: 1 }, () => {
  beforeEach(() => {
    for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA', 'LOCAL_API_MODE']) {
      originalEnv.set(key, process.env[key]);
    }
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.cable-health.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    __resetKeyPrefixCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
    __resetKeyPrefixCacheForTests();
  });

  it('awaits fallback publication before health can read the served snapshot', async () => {
    const store = new Map<string, unknown>();
    const delayedKeys = new Map<string, ReturnType<typeof deferred<void>>>();
    const writesStarted = deferred<void>();
    let delayedWriteCount = 0;
    let upstreamAvailable = true;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === 'https://redis.cable-health.test/pipeline') return simpleRepairResponse(init?.body, store);
      if (url.startsWith('https://redis.cable-health.test/get/')) {
        const key = decodeURIComponent(url.slice('https://redis.cable-health.test/get/'.length));
        const value = store.get(key);
        return Response.json({ result: value === undefined ? null : JSON.stringify(value) });
      }
      if (url === 'https://redis.cable-health.test/') {
        const command = JSON.parse(String(init?.body)) as [string, string, string, string, string];
        assert.equal(command[0], 'SET');
        const key = command[1];
        const value = JSON.parse(command[2]);
        const gate = delayedKeys.get(key);
        if (gate && value !== NEG_SENTINEL) {
          delayedWriteCount += 1;
          if (delayedWriteCount === delayedKeys.size) writesStarted.resolve();
          await gate.promise;
        }
        store.set(key, value);
        return Response.json({ result: 'OK' });
      }
      if (url.startsWith('https://msi.nga.mil/')) {
        return upstreamAvailable
          ? Response.json([{ text: 'FAULT REPORTED ON SUBMARINE CABLE MAREA', issueDate: currentNgaDate() }])
          : new Response('upstream unavailable', { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const first = await getCableHealth({} as never, {} as never);
    assert.ok(Object.keys(first.cables).length > 0);
    assert.deepEqual(Object.keys(first).sort(), ['cables', 'generatedAt']);
    assert.deepEqual(cableHealthToDigestInput(first), [{ name: 'marea', status: first.cables.marea!.status }]);

    store.delete(CACHE_KEY);
    store.delete(NGA_CACHE_KEY);
    upstreamAvailable = false;
    delayedKeys.set(CACHE_KEY, deferred<void>());

    let responseSettled = false;
    const secondPromise = getCableHealth({} as never, {} as never).then((response) => {
      responseSettled = true;
      return response;
    });

    await writesStarted.promise;
    assert.equal(store.get(NGA_CACHE_KEY), NEG_SENTINEL);
    const healthDuringFormerWindow = await getCachedJson(CACHE_KEY);
    assert.equal(healthDuringFormerWindow, null);
    await Promise.resolve();
    assert.equal(responseSettled, false);

    for (const gate of delayedKeys.values()) gate.resolve();
    const fallback = await secondPromise;
    const published = await getCachedJson(CACHE_KEY) as GetCableHealthResponse;
    const metadata = await getCachedJson(META_KEY) as { recordCount: number };

    assert.deepEqual(fallback, first);
    assert.deepEqual(published, fallback);
    assert.equal(metadata.recordCount, Object.keys(fallback.cables).length);
    assert.notEqual(published, NEG_SENTINEL);
  });

  it('keeps a legitimate empty computation as positive data', async () => {
    const store = new Map<string, unknown>();
    let upstreamCalls = 0;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === 'https://redis.cable-health.test/pipeline') return simpleRepairResponse(init?.body, store);
      if (url.startsWith('https://redis.cable-health.test/get/')) {
        const key = decodeURIComponent(url.slice('https://redis.cable-health.test/get/'.length));
        const value = store.get(key);
        return Response.json({ result: value === undefined ? null : JSON.stringify(value) });
      }
      if (url === 'https://redis.cable-health.test/') {
        const command = JSON.parse(String(init?.body)) as [string, string, string];
        store.set(command[1], JSON.parse(command[2]));
        return Response.json({ result: 'OK' });
      }
      if (url.startsWith('https://msi.nga.mil/')) {
        upstreamCalls += 1;
        return Response.json([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const response = await getCableHealth({} as never, {} as never);

    assert.deepEqual(response.cables, {});
    assert.deepEqual(store.get(CACHE_KEY), response);
    assert.equal(upstreamCalls, 1);
    assert.equal(store.get(META_KEY).recordCount, 0);
  });

  let clockSequence = 0;
  function clockFixture() {
    let now = originalNow() + (++clockSequence) * 86_400_000;
    const start = now;
    const store = new Map<string, { value: string; expiresAt: number }>();
    let upstreamAvailable = true;
    let upstreamGate: Promise<void> | undefined;
    let upstreamStarted = deferred<void>();
    let rejectPublication = false;
    let rejectMetadata = false;
    const writes = new Map<string, number>();
    let beforeRepair: (() => void) | undefined;
    const read = (key: string) => {
      const entry = store.get(key);
      return entry && entry.expiresAt > now ? JSON.parse(entry.value) : null;
    };
    const callRedis = ([command, key, value, expiryKind, seconds, condition]: string[]) => {
      if (command === 'GET') return read(key!) === null ? null : store.get(key!)!.value;
      if (command === 'TIME') return [String(Math.floor(now / 1000)), String((now % 1000) * 1000)];
      if (command === 'PEXPIREAT') {
        const entry = store.get(key!);
        if (!entry || read(key!) === null) return 0;
        entry.expiresAt = Number(value);
        return 1;
      }
      assert.equal(command, 'SET');
      assert.equal(expiryKind, 'EX');
      writes.set(key!, (writes.get(key!) ?? 0) + 1);
      if (key === CACHE_KEY && rejectPublication) throw new Error('fixture write failed');
      if (key === META_KEY && rejectMetadata) throw new Error('fixture metadata write failed');
      if (condition === 'NX' && read(key) !== null) return null;
      store.set(key!, { value: value!, expiresAt: now + Number(seconds) * 1000 });
      return 'OK';
    };
    Date.now = () => now;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === 'https://redis.cable-health.test/pipeline') {
        beforeRepair?.();
        return Response.json((JSON.parse(String(init?.body)) as string[][]).map((command) => runRepairCommand(command, callRedis)));
      }
      if (url.startsWith('https://redis.cable-health.test/get/')) {
        const value = read(decodeURIComponent(url.split('/get/')[1]!));
        return Response.json({ result: value === null ? null : JSON.stringify(value) });
      }
      if (url === 'https://redis.cable-health.test/') {
        try { return Response.json({ result: callRedis(JSON.parse(String(init?.body))) }); }
        catch (error) { return Response.json({ error: String(error) }); }
      }
      if (url.startsWith('https://msi.nga.mil/')) {
        upstreamStarted.resolve();
        await upstreamGate;
        return upstreamAvailable ? Response.json([]) : new Response('unavailable', { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    return {
      start, store, read, writes,
      advance(minutes: number) { now = start + minutes * 60_000; },
      failUpstream() { upstreamAvailable = false; store.delete(NGA_CACHE_KEY); },
      gateUpstream(gate: Promise<void>) {
        upstreamGate = gate;
        upstreamStarted = deferred<void>();
        store.delete(NGA_CACHE_KEY);
        return upstreamStarted.promise;
      },
      failPublication() { rejectPublication = true; },
      failMetadata(fail: boolean) { rejectMetadata = fail; },
      beforeRepair(callback: () => void) { beforeRepair = callback; },
      verdict() {
        const payload = read(CACHE_KEY);
        return health.classifyKey('cableHealth', CACHE_KEY, { allowOnDemand: false }, {
          keyStrens: new Map([[CACHE_KEY, payload === null ? 0 : JSON.stringify(payload).length]]),
          keyErrors: new Map(),
          keyMetaValues: new Map([[META_KEY, JSON.stringify(read(META_KEY))]]),
          keyMetaErrors: new Map(), now,
        });
      },
    };
  }

  it('keeps health OK across the refresh deadline without renewing metadata on cache hits', async () => {
    const f = clockFixture();
    const first = await getCableHealth({} as never, {} as never);
    assert.equal(f.verdict().status, 'OK');
    f.advance(29);
    assert.deepEqual(await getCableHealth({} as never, {} as never), first);
    assert.equal(f.read(META_KEY).fetchedAt, f.start);

    f.advance(30 + 1 / 60);
    assert.equal(f.verdict().status, 'OK', 'payload survives until a late warm-ping can refresh it');
    const second = await getCableHealth({} as never, {} as never);
    assert.ok(second.generatedAt > first.generatedAt, 'recompute at 30 minutes despite retained data');
    assert.equal(f.read(META_KEY).fetchedAt, second.generatedAt);
  });

  it('migrates a legacy cache hit to its original 90-minute deadline', async () => {
    const f = clockFixture();
    const first = await getCableHealth({} as never, {} as never);
    f.store.get(CACHE_KEY)!.expiresAt = f.start + 30 * 60_000;
    f.advance(29);
    assert.deepEqual(await getCableHealth({} as never, {} as never), first);
    assert.equal(f.store.get(CACHE_KEY)!.expiresAt, f.start + 90 * 60_000);
    assert.equal(f.read(META_KEY).fetchedAt, first.generatedAt);
    f.advance(31);
    assert.equal(f.verdict().status, 'OK');
  });

  it('repairs an unconfirmed metadata write on the next cache hit without renewing its clock', async () => {
    const f = clockFixture();
    f.failMetadata(true);
    const first = await getCableHealth({} as never, {} as never);
    assert.deepEqual(f.read(CACHE_KEY), first);
    assert.equal(f.read(META_KEY), null);
    assert.equal(f.verdict().status, 'STALE_SEED');
    f.failMetadata(false);
    f.advance(1);
    assert.deepEqual(await getCableHealth({} as never, {} as never), first);
    assert.equal(f.read(META_KEY)?.fetchedAt, first.generatedAt);
    assert.equal(f.verdict().status, 'OK');
  });

  it('coalesces concurrent refreshes even when the NGA cache is already populated', async () => {
    const f = clockFixture();
    await getCableHealth({} as never, {} as never);
    assert.ok(f.read(NGA_CACHE_KEY));
    f.writes.clear();
    f.advance(31);
    const responses = await Promise.all(Array.from({ length: 8 }, () => getCableHealth({} as never, {} as never)));
    assert.equal(f.writes.get(CACHE_KEY), 1, 'one canonical publication for the whole refresh');
    assert.equal(f.writes.get(META_KEY), 1, 'one metadata publication for the whole refresh');
    assert.ok(responses.every((response) => response === responses[0]), 'callers share the same refresh result');
    assert.equal(f.verdict().status, 'OK');
  });

  it('cannot repair an old cache hit over a newer snapshot and its metadata', async () => {
    const f = clockFixture();
    await getCableHealth({} as never, {} as never);
    f.advance(1);
    const winner = { generatedAt: Date.now(), cables: {} };
    const deadline = Date.now() + 90 * 60_000;
    f.beforeRepair(() => {
      f.store.set(CACHE_KEY, { value: JSON.stringify(winner), expiresAt: deadline });
      f.store.set(META_KEY, { value: JSON.stringify({ fetchedAt: winner.generatedAt, recordCount: 0 }), expiresAt: Infinity });
    });
    await getCableHealth({} as never, {} as never);
    assert.deepEqual(f.read(CACHE_KEY), winner);
    assert.equal(f.store.get(CACHE_KEY)!.expiresAt, deadline);
    assert.equal(f.read(META_KEY).fetchedAt, winner.generatedAt);
  });

  it('rejects a delayed repair after the original retention deadline', async () => {
    const f = clockFixture();
    const first = await getCableHealth({} as never, {} as never);
    f.store.delete(META_KEY);
    f.store.get(CACHE_KEY)!.expiresAt = Infinity;
    f.advance(1);
    f.beforeRepair(() => f.advance(90));
    await getCableHealth({} as never, {} as never);
    assert.deepEqual(f.read(CACHE_KEY), first, 'late repair makes no cache mutation');
    assert.equal(f.read(META_KEY), null, 'late repair cannot claim a successful observation');
  });

  it('repairs legacy sidecar cache hits without requiring remote Redis', async () => {
    const f = clockFixture();
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    const first = { generatedAt: f.start, cables: {} };
    sidecarCacheSet(CACHE_KEY, first, 1800);
    sidecarCacheSet(META_KEY, { fetchedAt: f.start - 90 * 60_000, recordCount: 0 }, 604800);
    globalThis.fetch = (async () => { throw new Error('sidecar cache hit must not use the network'); }) as typeof fetch;
    f.advance(29);
    assert.deepEqual(await getCableHealth({} as never, {} as never), first);
    assert.deepEqual(sidecarCacheGet(META_KEY), { fetchedAt: first.generatedAt, recordCount: 0 });
    f.advance(31);
    assert.deepEqual(sidecarCacheGet(CACHE_KEY), first);
    f.advance(90);
    assert.equal(sidecarCacheGet(CACHE_KEY), null);
  });

  it('serves the old canonical snapshot to health while refresh is in flight', async () => {
    const f = clockFixture();
    const first = await getCableHealth({} as never, {} as never);
    f.advance(31);
    const gate = deferred<void>();
    const started = f.gateUpstream(gate.promise);
    const refreshing = getCableHealth({} as never, {} as never);
    await started;
    const duringRefresh = { status: f.verdict().status, payload: f.read(CACHE_KEY) };
    gate.resolve();
    await refreshing;
    assert.equal(duringRefresh.status, 'OK');
    assert.deepEqual(duringRefresh.payload, first);
    assert.equal(f.verdict().status, 'OK');
  });

  it('failed refreshes keep the last-good deadline and cannot create immortal fallback data', async () => {
    const f = clockFixture();
    const first = await getCableHealth({} as never, {} as never);
    const expiry = f.store.get(CACHE_KEY)!.expiresAt;
    f.advance(31);
    f.failUpstream();
    assert.deepEqual(await getCableHealth({} as never, {} as never), first);
    assert.equal(f.verdict().status, 'OK');
    f.advance(61);
    assert.deepEqual(await getCableHealth({} as never, {} as never), first);
    assert.equal(f.read(META_KEY).fetchedAt, f.start);
    assert.equal(f.store.get(CACHE_KEY)!.expiresAt, expiry);

    f.advance(90);
    await getCableHealth({} as never, {} as never);
    assert.equal(f.read(CACHE_KEY), null);
    assert.notEqual(f.verdict().status, 'OK');
    assert.equal(f.read(META_KEY).fetchedAt, f.start);
  });

  it('does not claim a successful empty observation when the first upstream fetch fails', async () => {
    const f = clockFixture();
    f.failUpstream();
    const response = await getCableHealth({} as never, {} as never);
    assert.deepEqual(response, { generatedAt: 0, cables: {} });
    assert.equal(f.read(CACHE_KEY), null);
    assert.equal(f.read(META_KEY), null);
    assert.notEqual(f.verdict().status, 'OK');
  });

  it('does not advance success metadata if the canonical write fails', async () => {
    const f = clockFixture();
    f.failPublication();
    await getCableHealth({} as never, {} as never);
    assert.equal(f.read(CACHE_KEY), null);
    assert.equal(f.read(META_KEY), null);
  });

  it('cannot overwrite a concurrent fresh publication while repairing an evicted fallback', async () => {
    const f = clockFixture();
    await getCableHealth({} as never, {} as never);
    f.advance(31);
    f.store.delete(CACHE_KEY);
    f.failUpstream();
    const gate = deferred<void>();
    const started = f.gateUpstream(gate.promise);
    const repairing = getCableHealth({} as never, {} as never);
    await started;
    const winner = { generatedAt: Date.now(), cables: {} };
    f.store.set(CACHE_KEY, { value: JSON.stringify(winner), expiresAt: Date.now() + 90 * 60_000 });
    f.store.set(META_KEY, { value: JSON.stringify({ fetchedAt: winner.generatedAt, recordCount: 0 }), expiresAt: Infinity });
    gate.resolve();
    await repairing;
    assert.deepEqual(f.read(CACHE_KEY), winner);
    assert.equal(f.read(META_KEY).fetchedAt, winner.generatedAt);
  });
});
