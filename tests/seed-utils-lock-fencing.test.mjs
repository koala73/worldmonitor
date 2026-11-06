// SM-122: runSeed's lock must fence the publish.
//
// runSeed takes `seed-lock:<domain>:<resource>` with SET NX PX lockTtlMs, but
// the fetch phase may run until lockTtlMs + 120s. Before the fence, a run whose
// lock expired mid-fetch still published: a newer run could take the lock,
// publish fresher data, and then the old run overwrote the canonical key with
// its older snapshot and stamped seed-meta fetchedAt=now.
//
// The Redis double below executes the real Lua text runSeed sends (fengari, the
// same VM tests/digest-lastgood-script.test.mjs uses), so the fence is tested
// as it runs in Redis, not as a stubbed `{ result: 1 }`.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { runSeed } = await import('../scripts/_seed-utils.mjs');

const DOMAIN = 'test';
const RESOURCE = 'fence';
const LOCK_KEY = `seed-lock:${DOMAIN}:${RESOURCE}`;
const CANONICAL_KEY = 'test:fence:v1';
const META_KEY = `seed-meta:${DOMAIN}:${RESOURCE}`;
const EXTRA_KEY = 'test:fence:bootstrap:v1';
const B_META = JSON.stringify({ fetchedAt: 1_700_000_000_000, recordCount: 1, sourceVersion: 'run-B' });

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const ORIGINAL_SIGTERM_LISTENERS = new Set(process.rawListeners('SIGTERM'));

let redis;
let logs;

// ── In-memory Redis with millisecond expiry ─────────────────────────────────
function makeRedis() {
  const store = new Map(); // key -> { value, expiresAt|null }
  const live = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };
  const call = (verb, args) => {
    switch (String(verb).toUpperCase()) {
      case 'GET': return live(args[0])?.value ?? null;
      case 'SET': {
        const [key, value, ...rest] = args.map(String);
        const flags = rest.map((r) => r.toUpperCase());
        if (flags.includes('NX') && live(key)) return null;
        let expiresAt = null;
        const ex = flags.indexOf('EX');
        const px = flags.indexOf('PX');
        if (ex >= 0) expiresAt = Date.now() + Number(rest[ex + 1]) * 1000;
        if (px >= 0) expiresAt = Date.now() + Number(rest[px + 1]);
        store.set(key, { value, expiresAt });
        return 'OK';
      }
      case 'DEL': return store.delete(String(args[0])) ? 1 : 0;
      case 'PEXPIRE': {
        const entry = live(String(args[0]));
        if (!entry) return 0;
        entry.expiresAt = Date.now() + Number(args[1]);
        return 1;
      }
      case 'EXPIRE': {
        const entry = live(String(args[0]));
        if (!entry) return 0;
        entry.expiresAt = Date.now() + Number(args[1]) * 1000;
        return 1;
      }
      default: throw new Error(`redis double: unimplemented command ${verb}`);
    }
  };
  return {
    store,
    call,
    get: (key) => live(key)?.value ?? null,
    set: (key, value, ttlMs = null) => store.set(key, { value, expiresAt: ttlMs == null ? null : Date.now() + ttlMs }),
    eval: (script, keys, argv) => runLua(script, keys, argv, call),
  };
}

function pushValue(L, value) {
  if (value === null || value === undefined) { lua.lua_pushboolean(L, false); return; } // Redis nil -> Lua false
  if (typeof value === 'number') { lua.lua_pushinteger(L, value); return; }
  if (typeof value === 'string') { lua.lua_pushstring(L, to_luastring(value)); return; }
  if (Array.isArray(value)) {
    lua.lua_createtable(L, value.length, 0);
    value.forEach((entry, index) => { pushValue(L, entry); lua.lua_seti(L, -2, index + 1); });
    return;
  }
  throw new Error(`pushValue: unsupported ${typeof value}`);
}

// Lua -> Redis reply conversion: numbers truncate to integers, tables become
// arrays up to the first nil, false becomes nil.
function readReply(L, index) {
  const type = lua.lua_type(L, index);
  if (type === lua.LUA_TNUMBER) return Math.trunc(lua.lua_tonumber(L, index));
  if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index));
  if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index) ? 1 : null;
  if (type !== lua.LUA_TTABLE) return null;
  const abs = lua.lua_absindex(L, index);
  const out = [];
  for (let i = 1; ; i += 1) {
    lua.lua_geti(L, abs, i);
    if (lua.lua_isnil(L, -1)) { lua.lua_pop(L, 1); break; }
    out.push(readReply(L, -1));
    lua.lua_pop(L, 1);
  }
  return out;
}

function runLua(script, keys, argv, call) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const argc = lua.lua_gettop(S);
    const cmd = to_jsstring(lua.lua_tostring(S, 1));
    const args = [];
    for (let i = 2; i <= argc; i += 1) args.push(to_jsstring(lua.lua_tostring(S, i)));
    pushValue(S, call(cmd, args));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));
  pushValue(L, keys.map(String));
  lua.lua_setglobal(L, to_luastring('KEYS'));
  pushValue(L, argv.map(String));
  lua.lua_setglobal(L, to_luastring('ARGV'));
  const luaError = () => to_jsstring(lua.lua_tostring(L, -1) ?? to_luastring('<no message>'));
  if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK) throw new Error(`lua compile: ${luaError()}`);
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) throw new Error(`lua runtime: ${luaError()}`);
  return readReply(L, -1);
}

// ── Upstash REST surface over the double ────────────────────────────────────
function upstash(r) {
  const run = (command) => {
    const [verb, ...args] = command;
    if (String(verb).toUpperCase() === 'EVAL') {
      const [script, numKeys, ...rest] = args;
      const n = Number(numKeys);
      return r.eval(String(script), rest.slice(0, n), rest.slice(n));
    }
    return r.call(verb, args);
  };
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/get/')) {
      const key = decodeURIComponent(u.split('/get/')[1]);
      return Response.json({ result: r.get(key) });
    }
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.endsWith('/pipeline') || u.endsWith('/multi-exec')) {
      return Response.json(body.map((command) => ({ result: run(command) })));
    }
    return Response.json({ result: run(body) });
  };
}

beforeEach(() => {
  redis = makeRedis();
  logs = [];
  const capture = (...args) => { logs.push(args.join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  globalThis.fetch = upstash(redis);
  process.exit = (code) => {
    const e = new Error(`__test_exit__:${code}`);
    e.exitCode = code;
    throw e;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  for (const listener of process.rawListeners('SIGTERM')) {
    if (!ORIGINAL_SIGTERM_LISTENERS.has(listener)) process.removeListener('SIGTERM', listener);
  }
});

async function exitCodeOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    if (String(err?.message).startsWith('__test_exit__:')) return err.exitCode;
    throw err;
  }
}

const seedOpts = (overrides = {}) => ({
  validateFn: (d) => d.items.length > 0,
  ttlSeconds: 3600,
  recordCount: (d) => d.items.length,
  extraKeys: [{ key: EXTRA_KEY, ttl: 3600, transform: (d) => ({ items: d.items }) }],
  ...overrides,
});

// Run B takes the expired lock and publishes newer data before run A's fetch
// returns: exactly the interleaving the fetch deadline (lockTtlMs + 120s) allows.
function newerRunTakesOver() {
  redis.store.delete(LOCK_KEY);
  redis.set(LOCK_KEY, 'run-B', 120_000);
  redis.set(CANONICAL_KEY, JSON.stringify({ items: ['B-newer'] }), 3_600_000);
  redis.set(EXTRA_KEY, JSON.stringify({ items: ['B-newer'] }), 3_600_000);
  redis.set(META_KEY, B_META, 3_600_000);
}

test('a run whose lock was taken over must not overwrite the newer run publish', async () => {
  const code = await exitCodeOf(runSeed(DOMAIN, RESOURCE, CANONICAL_KEY, async () => {
    newerRunTakesOver();
    return { items: ['A-older'] };
  }, seedOpts()));

  assert.deepEqual(JSON.parse(redis.get(CANONICAL_KEY)).items, ['B-newer'], 'stale holder overwrote the canonical key');
  assert.deepEqual(JSON.parse(redis.get(EXTRA_KEY)).items, ['B-newer'], 'stale holder overwrote an extra key');
  assert.equal(redis.get(META_KEY), B_META, 'stale holder rewrote seed-meta');
  assert.equal(redis.get(LOCK_KEY), 'run-B', 'the newer run keeps its lock');
  assert.equal(code, 0, 'the lock owner publishes this tick, so the loser exits like a lock-contention skip');
  assert.ok(logs.some((l) => /SKIPPED: seed lock .*run-B/.test(l)), `expected a lock-lost log, got:\n${logs.join('\n')}`);
});

test('a run whose lock expired with no successor publishes nothing and exits 75', async () => {
  redis.set(CANONICAL_KEY, JSON.stringify({ items: ['last-good'] }), 3_600_000);
  redis.set(META_KEY, B_META, 3_600_000);
  const code = await exitCodeOf(runSeed(DOMAIN, RESOURCE, CANONICAL_KEY, async () => {
    redis.store.delete(LOCK_KEY); // TTL elapsed; nobody has taken it yet
    return { items: ['A-unfenced'] };
  }, seedOpts()));

  assert.deepEqual(JSON.parse(redis.get(CANONICAL_KEY)).items, ['last-good']);
  assert.equal(redis.get(EXTRA_KEY), null);
  assert.equal(redis.get(META_KEY), B_META);
  assert.equal(code, 75, 'nothing was published and no other run owns the tick: graceful non-OK');
});

test('a run that loses its lock after the canonical write does not stamp seed-meta', async () => {
  redis.set(META_KEY, B_META, 3_600_000);
  const code = await exitCodeOf(runSeed(DOMAIN, RESOURCE, CANONICAL_KEY, async () => ({ items: ['A'] }), seedOpts({
    extraKeys: undefined,
    afterPublish: async () => {
      // Lock stolen between the canonical publish and seed-meta.
      redis.store.delete(LOCK_KEY);
      redis.set(LOCK_KEY, 'run-C', 120_000);
    },
  })));

  assert.equal(redis.get(META_KEY), B_META, 'seed-meta must stay with the run that owns the lock');
  assert.equal(redis.get(LOCK_KEY), 'run-C');
  assert.equal(code, 0);
});

test('a run that holds its lock publishes canonical, extra keys and seed-meta, then releases', async () => {
  const before = Date.now();
  const code = await exitCodeOf(runSeed(DOMAIN, RESOURCE, CANONICAL_KEY, async () => ({ items: ['A1', 'A2'] }), seedOpts()));

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(redis.get(CANONICAL_KEY)).items, ['A1', 'A2']);
  assert.deepEqual(JSON.parse(redis.get(EXTRA_KEY)).items, ['A1', 'A2']);
  const meta = JSON.parse(redis.get(META_KEY));
  assert.equal(meta.recordCount, 2);
  assert.ok(meta.fetchedAt >= before);
  const canonicalEntry = redis.store.get(CANONICAL_KEY);
  assert.ok(canonicalEntry.expiresAt > Date.now() + 3_500_000, 'canonical keeps its data TTL');
  assert.equal(redis.get(LOCK_KEY), null, 'lock released on success');
});

test('a contract-mode run that holds its lock publishes its envelope', async () => {
  const code = await exitCodeOf(runSeed(DOMAIN, RESOURCE, CANONICAL_KEY, async () => ({ items: ['A1'] }), seedOpts({
    extraKeys: undefined,
    declareRecords: (d) => d.items.length,
    sourceVersion: 'v1',
    schemaVersion: 1,
    maxStaleMin: 60,
  })));
  assert.equal(code, 0);
  const envelope = JSON.parse(redis.get(CANONICAL_KEY));
  assert.deepEqual(envelope.data.items, ['A1']);
  assert.equal(envelope._seed.recordCount, 1);
});

test('a fetch that outlives lockTtlMs keeps its lock alive and still publishes', async () => {
  let heldAfterThreeTtls = null;
  const code = await exitCodeOf(runSeed(DOMAIN, RESOURCE, CANONICAL_KEY, async () => {
    // Three lock TTLs: without renewal the lock would be gone at publish time.
    await new Promise((resolve) => setTimeout(resolve, 900));
    heldAfterThreeTtls = redis.get(LOCK_KEY);
    return { items: ['slow'] };
  }, seedOpts({ extraKeys: undefined, lockTtlMs: 300, fetchPhaseTimeoutMs: 10_000 })));

  assert.ok(heldAfterThreeTtls, 'lock must still be held while the fetch runs');
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(redis.get(CANONICAL_KEY)).items, ['slow']);
  assert.equal(JSON.parse(redis.get(META_KEY)).recordCount, 1);
});

test('a lock lost between extra keys stops the remaining extra-key writes', async () => {
  const SECOND_EXTRA = 'test:fence:second:v1';
  redis.set(SECOND_EXTRA, JSON.stringify({ items: ['B-newer'] }), 3_600_000);
  redis.set(META_KEY, B_META, 3_600_000);
  const code = await exitCodeOf(runSeed(DOMAIN, RESOURCE, CANONICAL_KEY, async () => ({ items: ['A'] }), seedOpts({
    extraKeys: [
      { key: EXTRA_KEY, ttl: 3600, transform: (d) => ({ items: d.items }) },
      {
        key: SECOND_EXTRA,
        ttl: 3600,
        transform: (d) => {
          // Another run takes the lock after the first extra key landed.
          redis.store.delete(LOCK_KEY);
          redis.set(LOCK_KEY, 'run-D', 120_000);
          return { items: d.items };
        },
      },
    ],
  })));

  assert.deepEqual(JSON.parse(redis.get(EXTRA_KEY)).items, ['A'], 'written while the lock was held');
  assert.deepEqual(JSON.parse(redis.get(SECOND_EXTRA)).items, ['B-newer'], 'written after the lock was lost');
  assert.equal(redis.get(META_KEY), B_META);
  assert.equal(code, 0);
});

test('a custom atomic publisher is not called once the lock is lost', async () => {
  let publisherCalls = 0;
  const code = await exitCodeOf(runSeed(DOMAIN, RESOURCE, CANONICAL_KEY, async () => {
    newerRunTakesOver();
    return { items: ['A-older'] };
  }, seedOpts({
    extraKeys: undefined,
    publishAtomically: async () => { publisherCalls += 1; },
  })));

  assert.equal(publisherCalls, 0);
  assert.deepEqual(JSON.parse(redis.get(CANONICAL_KEY)).items, ['B-newer']);
  assert.equal(redis.get(META_KEY), B_META);
  assert.equal(code, 0);
});
