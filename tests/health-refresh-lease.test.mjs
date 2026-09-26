import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
const { default: handler, handleHealth, __testing__: keys } = await import('../api/health.js');
const realFetch = globalThis.fetch;
const realNow = Date.now;
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });
const request = () => handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));
// An owner paused past its 30 s lease has necessarily outlived the request
// deadline too, and would bail to the stale verdict before writing. These
// suites prove the Redis-boundary fencing for writes that land after expiry
// anyway, so they lift the deadline (tests/health-request-deadline.test.mjs
// covers the deadline itself).
const requestWithoutDeadline = () => handleHealth(
  new Request('https://api.worldmonitor.app/api/health?compact=1'),
  undefined,
  { workBudgetMs: Number.POSITIVE_INFINITY },
);
const deferred = () => Promise.withResolvers();

// Stateful Redis transport double: real handler, election, polling, classifier,
// persistence and release execute; only external Redis commands are simulated.
function redisFixture({
  holdFirstSweep = false, failFirstSweep = false, failRelease = false,
  holdSweepNumber = holdFirstSweep ? 1 : 0, holdHistory = false,
} = {}) {
  let now = realNow();
  Date.now = () => now;
  const store = new Map();
  let lock = null;
  let sweeps = 0;
  const started = deferred();
  const release = deferred();
  const publications = [];
  const rejectedMutations = [];
  const mutations = [];
  const acquire = [];
  const history = deferred();
  if (!holdHistory) history.resolve();
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    const sweep = commands.some(([op]) => op === 'STRLEN' || op === 'LLEN');
    if (sweep) {
      sweeps++;
      assert.ok(lock && lock.until > now, 'every sweep must start under a live lease');
      if (sweeps === 1 && failFirstSweep) {
        started.resolve();
        if (holdSweepNumber === 1) await release.promise;
        return new Response(null, { status: 503 });
      }
      if (sweeps === Math.max(1, holdSweepNumber)) {
        started.resolve();
        if (holdSweepNumber) await release.promise;
      }
    }
    if (commands.some(([op, script, ...args]) => op === 'EVAL' && script === keys.HEALTH_VERDICT_MUTATION_SCRIPT && args[4] === 'LPUSH')) {
      await history.promise;
    }
    const results = commands.map(([op, key, ...args]) => {
      if (op === 'SET' && key === keys.HEALTH_VERDICT_REFRESH_LOCK_KEY) {
        if (lock && lock.until > now) return { result: null };
        lock = { token: args[0], until: now + Number(args[2]) * 1_000 };
        acquire.push(lock.token);
        return { result: 'OK' };
      }
      if (op === 'EVAL' && key === keys.HEALTH_VERDICT_WRITE_SNAPSHOT_SCRIPT) {
        const count = Number(args[0]);
        const [lockKey, ...targets] = args.slice(1, 1 + count);
        const [token, full, compact] = args.slice(1 + count);
        assert.equal(lockKey, keys.HEALTH_VERDICT_REFRESH_LOCK_KEY);
        if (!lock || lock.until <= now || lock.token !== token) return { result: null };
        // Targets alternate full/compact: the live pair, then any retained copies.
        targets.forEach((target, index) => store.set(target, index % 2 === 0 ? full : compact));
        publications.push(token);
        return { result: 'OK' };
      }
      if (op === 'EVAL' && key === keys.HEALTH_VERDICT_MUTATION_SCRIPT) {
        if (!lock || lock.until <= now || lock.token !== args[3]) {
          rejectedMutations.push(args[4]);
          return { result: null };
        }
        mutations.push(args[4]);
        return { result: 'OK' };
      }
      if (op === 'EVAL' && key === keys.HEALTH_VERDICT_RELEASE_LOCK_SCRIPT) {
        if (failRelease) return { error: 'release unavailable' };
        if (lock?.token === args[2]) lock = null;
        return { result: 1 };
      }
      assert.ok(!['SET', 'DEL', 'HSETNX', 'HDEL', 'PEXPIRE', 'LPUSH', 'LTRIM', 'EXPIRE'].includes(op),
        'refresh mutations must be fenced at the Redis boundary');
      if (op === 'GET' && (store.has(key) || String(key).startsWith(keys.HEALTH_VERDICT_SNAPSHOT_KEY)
        || String(key).startsWith(keys.HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY))) {
        return { result: store.get(key) ?? null };
      }
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: now, recordCount: 1 }) };
      if (op === 'EXISTS') return { result: 0 };
      return { result: 'OK' };
    });
    return Response.json(results);
  };
  return {
    started: started.promise, release: () => release.resolve(), releaseHistory: () => history.resolve(),
    advance: (ms) => { now += ms; },
    get sweeps() { return sweeps; }, get lock() { return lock; },
    allowRelease: () => { failRelease = false; },
    store, publications, acquire, rejectedMutations, mutations,
  };
}

test('slow owner keeps concurrent misses pending without unowned sweeps', async () => {
  const f = redisFixture({ holdFirstSweep: true });
  const owner = request();
  await f.started;
  const followers = Promise.all(Array.from({ length: 4 }, request));
  // Move the real contention clock past its budget while the owner is held.
  await new Promise((resolve) => setTimeout(resolve, 150));
  f.advance(3_100);
  const responses = await followers;
  assert.equal(f.sweeps, 1);
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '3');
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    const body = await response.json();
    assert.equal(body.status, 'REFRESH_PENDING');
    assert.equal(body.checkedAt, undefined);
    assert.equal(body.summary, undefined);
  }
  f.release();
  const result = await owner;
  assert.equal(result.status, 200);
  assert.equal((await request()).status, 200);
  assert.equal(f.sweeps, 1, 'subsequent retry uses the owner snapshot');
});

test('waiters serve the last-known verdict as stale 200 while the owner refreshes', async () => {
  const f = redisFixture({ holdSweepNumber: 2 });
  const first = await request();
  assert.equal(first.status, 200);
  const published = await first.json();
  // The live snapshot ages out; the retained copy does not.
  f.advance(61_000);
  const owner = request();
  await f.started;
  const followers = Promise.all(Array.from({ length: 3 }, request));
  await new Promise((resolve) => setTimeout(resolve, 150));
  f.advance(3_100);
  for (const response of await followers) {
    assert.equal(response.status, 200, 'UptimeRobot and the capture scripts read non-2xx as down');
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    const body = await response.json();
    assert.equal(body.stale, true);
    assert.equal(body.staleReason, 'REFRESH_PENDING');
    assert.equal(body.status, published.status, 'status stays the verdict for keyword monitors');
    assert.equal(body.checkedAt, published.checkedAt, 'checkedAt is the published verdict, not now');
  }
  assert.equal(f.sweeps, 2, 'waiters never sweep');
  f.release();
  const refreshed = await owner;
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).stale, undefined, 'the owner serves its own fresh verdict');
});

test('a last-known verdict older than its retention is not served', async () => {
  const f = redisFixture({ holdSweepNumber: 2 });
  assert.equal((await request()).status, 200);
  f.advance(601_000);
  const owner = request();
  await f.started;
  const follower = request();
  await new Promise((resolve) => setTimeout(resolve, 150));
  f.advance(3_100);
  const response = await follower;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, 'REFRESH_PENDING');
  f.release();
  assert.equal((await owner).status, 200);
});

test('failed owner releases its lease and the next request can refresh', async () => {
  const f = redisFixture({ failFirstSweep: true });
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, 'REDIS_DOWN');
  assert.equal(f.lock, null);
  assert.equal((await request()).status, 200);
  assert.equal(f.sweeps, 2);
  assert.equal(f.acquire.length, 2);
});

test('failed release leaves a bounded lease that a later owner can acquire', async () => {
  const f = redisFixture({ failFirstSweep: true, failRelease: true });
  assert.equal((await request()).status, 503);
  assert.ok(f.lock);
  f.advance(30_001);
  assert.equal((await request()).status, 200);
  assert.equal(f.acquire.length, 2);
});

test('expired owner cannot overwrite snapshots or delete a successor lease', async () => {
  const f = redisFixture({ holdFirstSweep: true, failRelease: true });
  const owner = requestWithoutDeadline();
  await f.started;
  f.advance(30_001);
  assert.equal((await request()).status, 200);
  const successor = f.lock.token;
  const snapshot = f.store.get(keys.HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY);
  f.allowRelease();
  f.release();
  assert.equal((await owner).status, 200, 'computed live verdict remains usable');
  assert.equal(f.lock.token, successor);
  assert.equal(f.store.get(keys.HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY), snapshot);
  assert.deepEqual(f.publications, [successor], 'both snapshots publish in one fenced operation');
  assert.ok(f.rejectedMutations.includes('LPUSH'), 'obsolete owner cannot append incident history');
  assert.ok(f.mutations.includes('LPUSH'), 'current owner still records incident history');
});

test('malformed lease reply is unavailable, not pending and never sweeps', async () => {
  let calls = 0;
  globalThis.fetch = async () => Response.json(++calls === 1 ? [{ result: null }] : []);
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, 'REDIS_DOWN');
  assert.equal(calls, 2);
});

test('snapshot read exhausting wait budget does not start another lock request', async () => {
  let now = realNow();
  Date.now = () => now;
  let reads = 0;
  let claims = 0;
  globalThis.fetch = async (_url, init) => {
    const [[op]] = JSON.parse(init.body);
    if (op === 'GET') {
      if (++reads > 1) now += 3_001;
      return Response.json([{ result: null }]);
    }
    assert.equal(op, 'SET');
    claims++;
    return Response.json([{ result: null }]);
  };
  const response = await request();
  assert.equal((await response.json()).status, 'REFRESH_PENDING');
  assert.equal(claims, 1);
});

test('an active waiter can acquire the lease after its owner fails', async () => {
  const f = redisFixture({ holdFirstSweep: true, failFirstSweep: true });
  const owner = request();
  await f.started;
  const follower = request();
  f.release();
  assert.equal((await owner).status, 503);
  assert.equal((await follower).status, 200);
  assert.equal(f.sweeps, 2);
  assert.equal(f.acquire.length, 2);
});

test('a lock acknowledgement arriving after lease expiry cannot start a sweep', async () => {
  let now = realNow();
  Date.now = () => now;
  const operations = [];
  globalThis.fetch = async (_url, init) => {
    const [[op]] = JSON.parse(init.body);
    operations.push(op);
    if (op === 'SET') now += 30_000;
    return Response.json([{ result: op === 'GET' ? null : 'OK' }]);
  };
  const response = await requestWithoutDeadline();
  assert.equal((await response.json()).status, 'REFRESH_PENDING');
  // Snapshot read, lease claim, release, then the last-known lookup (none here).
  assert.deepEqual(operations, ['GET', 'SET', 'EVAL', 'GET']);
});


// Execute the exact Lua with a Redis command boundary, as other cache suites do.
function runLua(command, call) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  function push(value) {
    if (Array.isArray(value)) {
      lua.lua_createtable(state, value.length, 0);
      value.forEach((entry, index) => { push(entry); lua.lua_seti(state, -2, index + 1); });
    } else if (value == null) lua.lua_pushboolean(state, false);
    else if (typeof value === 'number') lua.lua_pushnumber(state, value);
    else lua.lua_pushstring(state, to_luastring(String(value)));
  }
  try {
    const keyCount = Number(command[2]);
    push(command.slice(3, 3 + keyCount));
    lua.lua_setglobal(state, to_luastring('KEYS'));
    push(command.slice(3 + keyCount).map(String));
    lua.lua_setglobal(state, to_luastring('ARGV'));
    lua.lua_createtable(state, 0, 1);
    lua.lua_pushjsfunction(state, () => {
      const args = Array.from({ length: lua.lua_gettop(state) }, (_, i) => to_jsstring(lua.lua_tostring(state, i + 1)));
      push(call(args));
      return 1;
    });
    lua.lua_setfield(state, -2, to_luastring('call'));
    lua.lua_setglobal(state, to_luastring('redis'));
    // Redis uses Lua 5.1's global unpack; Fengari uses the Lua 5.3 table name.
    const code = 'unpack = table.unpack\n' + command[1];
    const loaded = lauxlib.luaL_loadstring(state, to_luastring(code));
    const result = loaded === lua.LUA_OK ? lua.lua_pcall(state, 0, 1, 0) : loaded;
    assert.equal(result, lua.LUA_OK, lua.lua_isstring(state, -1) ? to_jsstring(lua.lua_tostring(state, -1)) : 'Lua failure');
    if (lua.lua_isnil(state, -1) || lua.lua_isboolean(state, -1)) return null;
    return lua.lua_isnumber(state, -1) ? lua.lua_tonumber(state, -1) : to_jsstring(lua.lua_tostring(state, -1));
  } finally { lua.lua_close(state); }
}

test('one Lua publication checks ownership once and writes both variants with the same TTL', () => {
  const command = ['EVAL', keys.HEALTH_VERDICT_WRITE_SNAPSHOT_SCRIPT, '5', 'lease', 'full', 'compact', 'full-lk', 'compact-lk', 'owner', 'full-json', 'compact-json', '30', '600'];
  const calls = [];
  assert.equal(runLua(command, (args) => {
    calls.push(args);
    return args[0] === 'get' ? 'owner' : 'OK';
  }), 'OK');
  assert.deepEqual(calls, [
    ['get', 'lease'],
    ['set', 'full', 'full-json', 'EX', '30'],
    ['set', 'compact', 'compact-json', 'EX', '30'],
    ['set', 'full-lk', 'full-json', 'EX', '600'],
    ['set', 'compact-lk', 'compact-json', 'EX', '600'],
  ]);
  for (const token of [null, 'successor']) {
    const rejected = [];
    assert.equal(runLua(command, (args) => { rejected.push(args); return token; }), null);
    assert.deepEqual(rejected, [['get', 'lease']], 'lost owner cannot write either variant');
  }
});

test('Lua fences every grace/history/rollout mutation against expired and successor leases', () => {
  const operations = [
    ['HSETNX', 'grace', 'source', 'deadline'], ['PEXPIRE', 'grace', '60000'], ['HDEL', 'grace', 'source'],
    ['SET', 'history', 'entry', 'EX', '86400'], ['DEL', 'signature'], ['LPUSH', 'history', 'entry'],
    ['LTRIM', 'history', 0, 49], ['EXPIRE', 'history', 604800], ['SET', 'rollout', 'deadline', 'NX'],
  ];
  const commands = keys.fenceHealthMutations(operations, 'owner');
  for (const [index, command] of commands.entries()) {
    for (const token of ['owner', 'successor', null]) {
      const calls = [];
      runLua(command, (args) => {
        calls.push(args);
        return args[0] === 'get' ? token : 1;
      });
      assert.deepEqual(calls, [
        ['get', keys.HEALTH_VERDICT_REFRESH_LOCK_KEY],
        ...(token === 'owner' ? [operations[index].map(String)] : []),
      ]);
    }
  }
});

test('owned cleanup and history run in waitUntil and the lease outlives them', async () => {
  const f = redisFixture({ holdHistory: true });
  const tasks = [];
  const pending = handler(new Request('https://api.worldmonitor.app/api/health?compact=1'), {
    waitUntil: (task) => tasks.push(task),
  });
  const response = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('response waited for history persistence')), 1_000)),
  ]);
  assert.equal(response.status, 200);
  assert.equal(tasks.length, 1);
  assert.ok(f.lock, 'the lease is held until the fenced background writes settle');
  assert.ok(!f.mutations.includes('LPUSH'));
  f.releaseHistory();
  await Promise.all(tasks);
  assert.ok(f.mutations.includes('LPUSH'), 'history lands under the owner lease');
  assert.deepEqual(f.rejectedMutations, []);
  assert.equal(f.lock, null);
});

test('without waitUntil the owner still finishes its fenced writes before returning', async () => {
  const f = redisFixture();
  assert.equal((await request()).status, 200);
  assert.ok(f.mutations.includes('LPUSH'));
  assert.equal(f.lock, null);
});
