// EXECUTE the MCP daily-quota reservation script, do not describe it.
//
// `MCP_QUOTA_RESERVE_SCRIPT` is the only thing standing between a paid
// allowance and an unmetered one, and until this file nothing in the repo ran
// it: tests/mcp-quota-plan-driven.test.mjs regex-matches its source text and
// byte-compares it to the pinned Docker copy — two copies agreeing proves
// nothing about either — while every handler suite stubs the pipeline with a
// JavaScript re-implementation of what the Lua is BELIEVED to do. A weight
// bug would have to be written into both the script and its stub to be caught.
//
// The weighted path is what makes that gap expensive: `ARGV[3]` was introduced
// for the shared API budget and no test ever passed it a value above 1.
//
// Same approach as tests/digest-lastgood-script.test.mjs: the real script text
// in a Lua 5.3 VM (fengari) against an in-memory Redis double. Only
// `redis.call` and the KEYS/ARGV globals are shimmed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

import { MCP_QUOTA_RESERVE_SCRIPT } from '../shared/mcp-quota-reserve-script.mjs';
import { PRO_DAILY_QUOTA_TTL_SECONDS } from '../server/_shared/pro-mcp-token.ts';

const COUNTER_KEY = 'mcp:pro-usage:user_api_starter:2026-09-01';
const FLOOR_KEY = 'mcp:pro-usage-floor:user_api_starter:2026-09-01';

/**
 * Minimal Redis double. Only the five commands the script issues are
 * implemented; anything else throws so an added command cannot pass silently.
 * Values are stored as strings, the way real Redis does, so a script that
 * forgets a `tonumber` fails here too.
 */
function makeRedis(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  const ttls = new Map();
  const commands = [];
  return {
    store,
    ttls,
    commands,
    get count() {
      const raw = store.get(COUNTER_KEY);
      return raw === undefined ? null : Number(raw);
    },
    get floor() {
      const raw = store.get(FLOOR_KEY);
      return raw === undefined ? null : Number(raw);
    },
    call(cmd, args) {
      const verb = String(cmd).toUpperCase();
      commands.push([verb, ...args]);
      if (verb === 'INCRBY' || verb === 'DECRBY') {
        const delta = Number(args[1]) * (verb === 'INCRBY' ? 1 : -1);
        const next = Number(store.get(args[0]) ?? 0) + delta;
        store.set(args[0], String(next));
        return next;
      }
      if (verb === 'GET') {
        const value = store.get(args[0]);
        // Real Redis returns `false` to Lua for a missing key, not nil.
        return value === undefined ? false : value;
      }
      if (verb === 'SET') {
        store.set(args[0], String(args[1]));
        return 'OK';
      }
      if (verb === 'EXPIRE') {
        ttls.set(args[0], Number(args[1]));
        return 1;
      }
      throw new Error(`redis double: unimplemented command ${verb}`);
    },
  };
}

/** Push a JS value onto the Lua stack (only what KEYS/ARGV and returns need). */
function pushValue(L, value) {
  if (value === null || value === undefined) { lua.lua_pushnil(L); return; }
  if (typeof value === 'number') { lua.lua_pushnumber(L, value); return; }
  if (typeof value === 'boolean') { lua.lua_pushboolean(L, value); return; }
  if (typeof value === 'string') { lua.lua_pushstring(L, to_luastring(value)); return; }
  lua.lua_createtable(L, value.length, 0);
  value.forEach((entry, index) => {
    pushValue(L, entry);
    lua.lua_seti(L, -2, index + 1);
  });
}

/** Read the `{status, count}` table the script returns. */
function readReturn(L) {
  assert.equal(lua.lua_type(L, -1), lua.LUA_TTABLE, 'the script must return a table');
  const out = [];
  for (let i = 1; i <= 2; i += 1) {
    lua.lua_geti(L, -1, i);
    out.push(lua.lua_tonumber(L, -1));
    lua.lua_pop(L, 1);
  }
  return out;
}

/**
 * Run the real script text with the given ARGV against a redis double.
 * `argv` entries are stringified the way Redis hands them to a script; an
 * `undefined` entry is a genuinely absent ARGV slot.
 */
function reserve({ argv, initial = {} }) {
  const redis = makeRedis(initial);
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const argc = lua.lua_gettop(S);
    const cmd = to_jsstring(lua.lua_tostring(S, 1));
    const args = [];
    for (let i = 2; i <= argc; i += 1) args.push(to_jsstring(lua.lua_tostring(S, i)));
    pushValue(S, redis.call(cmd, args));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));

  pushValue(L, [COUNTER_KEY, FLOOR_KEY]);
  lua.lua_setglobal(L, to_luastring('KEYS'));
  // A trailing `undefined` truncates the ARGV table, which is what Redis does
  // when the caller passes fewer arguments.
  const argvTable = argv.map((v) => (v === undefined ? undefined : String(v)));
  lua.lua_createtable(L, argvTable.length, 0);
  argvTable.forEach((entry, index) => {
    if (entry === undefined) return;
    pushValue(L, entry);
    lua.lua_seti(L, -2, index + 1);
  });
  lua.lua_setglobal(L, to_luastring('ARGV'));

  const luaError = () => {
    const raw = lua.lua_tostring(L, -1);
    return raw ? to_jsstring(raw) : '<no error message on the stack>';
  };
  if (lauxlib.luaL_loadstring(L, to_luastring(MCP_QUOTA_RESERVE_SCRIPT)) !== lua.LUA_OK) {
    assert.fail(`script failed to compile: ${luaError()}`);
  }
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
    assert.fail(`script raised: ${luaError()}`);
  }
  const [status, count] = readReturn(L);
  return { status, count, redis };
}

/**
 * Reserve `weight` units against `limit` with the counter pre-seeded to `used`.
 * `clamp` omitted means ARGV[4] is genuinely absent, which is what a caller
 * from before the flag sends.
 */
const charge = (weight, limit, used, floor, clamp) => reserve({
  argv: [limit === null ? '' : limit, PRO_DAILY_QUOTA_TTL_SECONDS, weight, clamp],
  initial: {
    ...(used ? { [COUNTER_KEY]: used } : {}),
    ...(floor === undefined ? {} : { [FLOOR_KEY]: floor }),
  },
});

describe('MCP quota reserve script — weighted reservation, executed', () => {
  it('a weight-3 call charges three units in one atomic turn', () => {
    const { status, count, redis } = charge(3, 1000, 10);
    assert.equal(status, 1);
    assert.equal(count, 13, 'the returned count is the post-INCRBY total, not the weight');
    assert.equal(redis.count, 13);
    assert.equal(redis.ttls.get(COUNTER_KEY), PRO_DAILY_QUOTA_TTL_SECONDS);
  });

  it('the INCRBY is a single command, not `weight` separate INCRs', () => {
    const { redis } = charge(3, 1000, 10);
    const increments = redis.commands.filter((c) => c[0] === 'INCRBY');
    assert.deepEqual(increments, [['INCRBY', COUNTER_KEY, '3']]);
  });

  it('a weight-2 call lands exactly on the limit and reserves', () => {
    const { status, count, redis } = charge(2, 1000, 998);
    assert.equal(status, 1, '998 + 2 = 1000 is inside a 1,000 allowance');
    assert.equal(count, 1000);
    assert.equal(redis.count, 1000);
  });

  it('ALL-OR-NOTHING: 999 used, weight 2, limit 1000 → reject and roll back in full', () => {
    // The contract published in the script header. Half-serving a weighted call
    // is not an option, and leaving the counter at 1,000 would charge for a
    // dispatch that never happened.
    const { status, count, redis } = charge(2, 1000, 999);
    assert.equal(status, 0);
    assert.equal(count, 999);
    assert.equal(redis.count, 999, 'the rejected INCRBY must be undone by the same amount');
    assert.deepEqual(
      redis.commands.filter((c) => c[0] === 'DECRBY'),
      [['DECRBY', COUNTER_KEY, '2']],
      'the rollback must DECRBY the weight, never 1',
    );
  });

  it('a weight-1 call still fits in the gap the weight-2 call could not use', () => {
    const { status, redis } = charge(1, 1000, 999);
    assert.equal(status, 1);
    assert.equal(redis.count, 1000);
  });

  it('a weight larger than the whole allowance rejects without moving the counter', () => {
    const { status, redis } = charge(3, 2, 0);
    assert.equal(status, 0);
    assert.equal(redis.count, 0);
  });

  it('unlimited (empty ARGV[1]) still meters the full weight', () => {
    const { status, count, redis } = charge(3, null, 100_000);
    assert.equal(status, 1);
    assert.equal(count, 100_003, 'unlimited is not unmetered');
    assert.equal(redis.floor, -1, 'an unlimited reserve marks the floor sentinel');
  });

  it('an unreadable limit rolls back the weight and fails closed', () => {
    const { status, count, redis } = reserve({
      argv: ['not-a-number', PRO_DAILY_QUOTA_TTL_SECONDS, 4],
      initial: { [COUNTER_KEY]: 10 },
    });
    assert.equal(status, -1);
    assert.equal(count, 0);
    assert.equal(redis.count, 10, 'the speculative INCRBY must be fully reversed');
  });

  it('F4 residue above the limit clamps to the limit, not to the limit minus the weight', () => {
    const { status, redis } = charge(3, 250, 280, 250);
    assert.equal(status, 0);
    assert.equal(redis.count, 250);
  });

  it('a lower-limit rejection cannot clamp away a higher charged allowance', () => {
    const { status, redis } = charge(2, 50, 200, 250);
    assert.equal(status, 0);
    assert.equal(redis.count, 200, 'the 250/day floor holds the shared counter up');
  });

  it('a successful weighted reserve records the charged limit as the clamp floor', () => {
    const { redis } = charge(3, 1000, 10);
    assert.equal(redis.floor, 1000);
    assert.equal(redis.ttls.get(FLOOR_KEY), PRO_DAILY_QUOTA_TTL_SECONDS);
  });
});

describe('MCP quota reserve script — the ARGV[3] weight guard', () => {
  // `if weight == nil or weight < 1 then weight = 1 end`. Every branch of it,
  // because a guard that silently resolved to 0 would make the meter stop
  // moving while every call still reserved.
  it('an ABSENT ARGV[3] charges 1', () => {
    const { status, redis } = reserve({
      argv: [1000, PRO_DAILY_QUOTA_TTL_SECONDS],
      initial: { [COUNTER_KEY]: 10 },
    });
    assert.equal(status, 1);
    assert.equal(redis.count, 11, 'a caller from before the weight argument must still meter');
  });

  for (const weight of ['', 'abc', '0', '-5', '0.5']) {
    it(`a weight of ${JSON.stringify(weight)} charges 1`, () => {
      const { status, redis } = reserve({
        argv: [1000, PRO_DAILY_QUOTA_TTL_SECONDS, weight],
        initial: { [COUNTER_KEY]: 10 },
      });
      assert.equal(status, 1);
      assert.equal(redis.count, 11);
      assert.deepEqual(
        redis.commands.filter((c) => c[0] === 'INCRBY'),
        [['INCRBY', COUNTER_KEY, '1']],
        'the guard must normalise before the INCRBY, not after',
      );
    });
  }

  it('the guard also governs the ROLLBACK amount, so a rejected bad weight nets to zero', () => {
    const { status, redis } = reserve({
      argv: [50, PRO_DAILY_QUOTA_TTL_SECONDS, '-5'],
      initial: { [COUNTER_KEY]: 50 },
    });
    assert.equal(status, 0);
    assert.equal(redis.count, 50, 'a -5 DECRBY on rollback would hand back 5 free calls');
  });
});

describe('MCP quota reserve script — the ARGV[4] residue clamp switch', () => {
  // The clamp SETs the counter to the enforced limit, which is only sound while
  // this script is the counter's ONLY writer. On the dedicated MCP counter it
  // is. On the shared REST key `reserveDailyMeter` INCRs and DECRs outside this
  // EVAL, so a REST rollback landing after a clamp would push the counter below
  // real usage. `reserveQuota` therefore passes 0 for the shared key only.
  //
  // Rejection is NOT what the flag governs: both arms must still refuse, roll
  // the weight back, and report the post-rollback count.
  const residue = (clamp) => charge(3, 250, 280, 250, clamp);

  it('DOES clamp on the dedicated counter (ARGV[4] = 1)', () => {
    const { status, count, redis } = residue(1);
    assert.equal(status, 0);
    assert.equal(count, 250);
    assert.equal(redis.count, 250, 'residue above the enforced limit is written back down');
    assert.deepEqual(
      redis.commands.filter((c) => c[0] === 'SET' && c[1] === COUNTER_KEY),
      [['SET', COUNTER_KEY, '250']],
    );
  });

  it('does NOT clamp on the shared REST key (ARGV[4] = 0)', () => {
    const { status, count, redis } = residue(0);
    assert.equal(status, 0, 'the rejection is unaffected by the clamp switch');
    assert.equal(count, 280, 'the reported count is the post-rollback total, un-clamped');
    assert.equal(redis.count, 280, 'a concurrent REST DECR must not land after a SET');
    assert.deepEqual(
      redis.commands.filter((c) => c[0] === 'SET' && c[1] === COUNTER_KEY),
      [],
      'the counter must never be SET when the clamp is disabled',
    );
  });

  it('rolls the weight back in full on both arms', () => {
    for (const clamp of [0, 1]) {
      const { redis } = charge(3, 1000, 999, 1000, clamp);
      assert.deepEqual(
        redis.commands.filter((c) => c[0] === 'DECRBY'),
        [['DECRBY', COUNTER_KEY, '3']],
        `clamp=${clamp} must still undo its own INCRBY`,
      );
    }
  });

  it('a disabled clamp does not read the floor key at all', () => {
    const { redis } = residue(0);
    assert.deepEqual(
      redis.commands.filter((c) => c[0] === 'GET'),
      [],
      'skipping the SET must also skip the read that only fed it',
    );
  });

  it('the clamp still records the floor on a SUCCESSFUL shared-key reserve', () => {
    // The switch governs the reject path only. A successful reserve must keep
    // writing the floor, or a later dedicated-counter rejection would clamp
    // against a floor this call never recorded.
    const { status, redis } = charge(3, 1000, 10, undefined, 0);
    assert.equal(status, 1);
    assert.equal(redis.floor, 1000);
  });

  for (const [label, argv4] of [
    ['ABSENT', undefined],
    ['empty', ''],
    ['unparseable', 'no'],
    ['1', 1],
    ['-1', -1],
  ]) {
    it(`an ARGV[4] of ${label} leaves the clamp ENABLED`, () => {
      // Fail-safe direction: only an explicit 0 gives up the residue
      // correction, so a caller that has not been taught the argument keeps
      // exactly today's behaviour.
      const { redis } = residue(argv4);
      assert.equal(redis.count, 250, `ARGV[4]=${JSON.stringify(argv4)} must not disable the clamp`);
    });
  }
});
