import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';
import {
  RESERVE_LUA,
  SETTLE_LUA,
  ACK_RECEIPTS_LUA,
  STATUS_LUA,
  createXPostBudget,
} from '../scripts/lib/x-post-budget.cjs';

const DAY_KEY = 'intelligence:x-post-budget:v1:day:2026-09-02';
const MONTH_KEY = 'intelligence:x-post-budget:v1:month:2026-09';
const RESERVATION_KEY = 'intelligence:x-post-budget:v1:reservation:test';
const ONCE_KEY = 'intelligence:x-post-budget:v1:once:2026-09-02:curated-feed:deletion-audit';
const COVERAGE_HOLD_KEY = 'intelligence:x-post-budget:v1:coverage-held:2026-09-02';
const COVERAGE_MARKER_KEY = 'intelligence:x-post-budget:v1:coverage-accounted:2026-09-02:timeline-a';
const RECEIPT_KEY = 'intelligence:x-post-budget:v1:receipt:timeline-a';
const INFLIGHT_KEY = 'intelligence:x-post-budget:v1:receipt-inflight:timeline-a';
const DAY_EXPIRES_AT = 1_788_566_400;
const MONTH_EXPIRES_AT = 1_791_158_400;

function makeRedis(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  const expirations = new Map();
  const commands = [];
  return {
    store,
    expirations,
    commands,
    call(command, args) {
      const verb = String(command).toUpperCase();
      commands.push([verb, ...args]);
      if (verb === 'GET') return store.has(args[0]) ? store.get(args[0]) : false;
      if (verb === 'EXISTS') return store.has(args[0]) ? 1 : 0;
      if (verb === 'INCRBY') {
        const next = Number(store.get(args[0]) ?? 0) + Number(args[1]);
        store.set(args[0], String(next));
        return next;
      }
      if (verb === 'EXPIREAT') {
        expirations.set(args[0], Number(args[1]));
        return 1;
      }
      if (verb === 'DEL') return store.delete(args[0]) ? 1 : 0;
      if (verb === 'SET') {
        store.set(args[0], String(args[1]));
        if (args[2]) expirations.set(args[0], { mode: args[2], value: Number(args[3]) });
        return 'OK';
      }
      throw new Error(`Redis double does not implement ${verb}`);
    },
  };
}

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

function runScript(script, keys, args, redis, returnLength) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (state) => {
    const command = to_jsstring(lua.lua_tostring(state, 1));
    const commandArgs = [];
    for (let index = 2; index <= lua.lua_gettop(state); index += 1) {
      commandArgs.push(to_jsstring(lua.lua_tostring(state, index)));
    }
    pushValue(state, redis.call(command, commandArgs));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));
  pushValue(L, keys);
  lua.lua_setglobal(L, to_luastring('KEYS'));
  pushValue(L, args.map(String));
  lua.lua_setglobal(L, to_luastring('ARGV'));

  const luaError = () => {
    const raw = lua.lua_tostring(L, -1);
    return raw ? to_jsstring(raw) : '<no Lua error text>';
  };
  if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK) {
    assert.fail(`script failed to compile: ${luaError()}`);
  }
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
    assert.fail(`script failed: ${luaError()}`);
  }
  if (returnLength == null) return lua.lua_tonumber(L, -1);
  assert.equal(lua.lua_type(L, -1), lua.LUA_TTABLE);
  const returned = [];
  for (let index = 1; index <= returnLength; index += 1) {
    lua.lua_geti(L, -1, index);
    const type = lua.lua_type(L, -1);
    returned.push(type === lua.LUA_TNIL
      ? ''
      : type === lua.LUA_TNUMBER
        ? lua.lua_tonumber(L, -1)
        : to_jsstring(lua.lua_tostring(L, -1)));
    lua.lua_pop(L, 1);
  }
  return returned;
}

const reserveArgs = (requested, coverageTotal = 0, coverageUnit = 0, oncePerDay = false, hasReceipt = false) => [
  requested,
  coverageTotal,
  600,
  20_000,
  DAY_EXPIRES_AT,
  MONTH_EXPIRES_AT,
  3600,
  oncePerDay ? 1 : 0,
  coverageUnit,
  coverageUnit > 0 ? 1 : 0,
  hasReceipt ? 1 : 0,
];

const budgetKeys = (
  reservationKey = RESERVATION_KEY,
  coverageMarkerKey = COVERAGE_MARKER_KEY,
  receiptKey = RECEIPT_KEY,
  inflightKey = INFLIGHT_KEY,
) => [
  DAY_KEY,
  MONTH_KEY,
  reservationKey,
  ONCE_KEY,
  COVERAGE_HOLD_KEY,
  coverageMarkerKey,
  receiptKey,
  inflightKey,
];

const settleKeys = (
  reservationKey = RESERVATION_KEY,
  onceKey = ONCE_KEY,
  coverageMarkerKey = COVERAGE_MARKER_KEY,
) => [
  DAY_KEY,
  MONTH_KEY,
  reservationKey,
  COVERAGE_HOLD_KEY,
  RECEIPT_KEY,
  INFLIGHT_KEY,
  onceKey,
  coverageMarkerKey,
];
const settleArgs = (actual, receiptJson = '', receiptHash = '-', options = {}) => {
  const normalized = typeof options === 'boolean'
    ? { hasReceiptScope: options, storeReceipt: options }
    : options;
  return [
    actual,
    DAY_EXPIRES_AT,
    normalized.hasReceiptScope ? 1 : 0,
    receiptJson,
    receiptHash,
    normalized.storeReceipt ? 1 : 0,
    normalized.hasOnce ? 1 : 0,
    normalized.completeOnce ? 1 : 0,
    normalized.hasCoverageUnit ? 1 : 0,
    normalized.completeCoverage ? 1 : 0,
    normalized.coverageUnit ?? 0,
  ];
};

describe('X Post budget Lua, executed', () => {
  it('admits a reservation that lands exactly on both limits', () => {
    const redis = makeRedis({ [DAY_KEY]: 590, [MONTH_KEY]: 19_990 });
    const returned = runScript(RESERVE_LUA, budgetKeys(), reserveArgs(10), redis, 6);
    assert.deepEqual(returned, [1, 600, 20_000, 0, 0, '']);
    assert.equal(redis.store.get(DAY_KEY), '600');
    assert.equal(redis.store.get(MONTH_KEY), '20000');
    assert.equal(redis.store.get(RESERVATION_KEY), '10');
  });

  it('rejects an over-limit reservation without moving either counter', () => {
    const redis = makeRedis({ [DAY_KEY]: 591, [MONTH_KEY]: 10_000 });
    const returned = runScript(RESERVE_LUA, budgetKeys(), reserveArgs(10), redis, 6);
    assert.deepEqual(returned, [0, 591, 10_000, 1, 0, '']);
    assert.equal(redis.store.get(DAY_KEY), '591');
    assert.equal(redis.store.get(MONTH_KEY), '10000');
    assert.equal(redis.store.has(RESERVATION_KEY), false);
    assert.equal(redis.commands.some(([verb]) => verb === 'INCRBY'), false);
  });

  it('rejects a reservation when only the monthly limit binds', () => {
    const redis = makeRedis({ [DAY_KEY]: 100, [MONTH_KEY]: 19_991 });
    const returned = runScript(RESERVE_LUA, budgetKeys(), reserveArgs(10), redis, 6);
    assert.deepEqual(returned, [0, 100, 19_991, 2, 0, '']);
    assert.equal(redis.store.get(DAY_KEY), '100');
    assert.equal(redis.store.get(MONTH_KEY), '19991');
    assert.equal(redis.store.has(RESERVATION_KEY), false);
    assert.equal(redis.commands.some(([verb]) => verb === 'INCRBY'), false);
  });

  it('refunds unused capacity once and makes identical settlement retries idempotent', () => {
    const redis = makeRedis({
      [DAY_KEY]: 10,
      [MONTH_KEY]: 110,
      [RESERVATION_KEY]: 10,
    });
    const first = runScript(SETTLE_LUA, settleKeys(), settleArgs(3), redis, 6);
    assert.deepEqual(first, [1, 3, 103, 10, 3, 0]);
    const incrementsAfterFirst = redis.commands.filter(([verb]) => verb === 'INCRBY').length;
    const retry = runScript(SETTLE_LUA, settleKeys(), settleArgs(3), redis, 6);
    assert.deepEqual(retry, [2, 3, 103, 0, 3, 0]);
    assert.equal(redis.commands.filter(([verb]) => verb === 'INCRBY').length, incrementsAfterFirst);
    assert.equal(redis.store.get(RESERVATION_KEY), 'settled:3:-');
  });

  it('never refunds a conflicting retry or an impossible returned count', () => {
    const settledRedis = makeRedis({
      [DAY_KEY]: 3,
      [MONTH_KEY]: 103,
      [RESERVATION_KEY]: 'settled:3:-',
    });
    assert.deepEqual(
      runScript(SETTLE_LUA, settleKeys(), settleArgs(4), settledRedis, 6),
      [-2, 3, 103, 0, 3, 0],
    );
    assert.equal(settledRedis.commands.some(([verb]) => verb === 'INCRBY'), false);

    const overMaxRedis = makeRedis({
      [DAY_KEY]: 10,
      [MONTH_KEY]: 110,
      [RESERVATION_KEY]: 10,
    });
    assert.deepEqual(
      runScript(SETTLE_LUA, settleKeys(), settleArgs(11), overMaxRedis, 6),
      [-1, 10, 110, 10, 11, 0],
    );
    assert.equal(overMaxRedis.store.get(DAY_KEY), '10');
    assert.equal(overMaxRedis.store.get(MONTH_KEY), '110');
  });

  it('claims the deletion audit once per UTC day without charging a second replica', () => {
    const redis = makeRedis();
    const first = runScript(RESERVE_LUA, budgetKeys('reservation:a', 'coverage:audit'), reserveArgs(25, 25, 25, true), redis, 6);
    const settled = runScript(
      SETTLE_LUA,
      settleKeys('reservation:a', ONCE_KEY, 'coverage:audit'),
      settleArgs(25, '', '-', {
        hasOnce: true,
        completeOnce: true,
        hasCoverageUnit: true,
        completeCoverage: true,
        coverageUnit: 25,
      }),
      redis,
      6,
    );
    const second = runScript(RESERVE_LUA, budgetKeys('reservation:b', 'coverage:audit'), reserveArgs(25, 25, 25, true), redis, 6);
    assert.deepEqual(first, [1, 25, 25, 0, 25, '']);
    assert.deepEqual(settled, [1, 25, 25, 25, 25, 0]);
    assert.deepEqual(second, [0, 25, 25, 3, 0, '']);
    assert.equal(redis.store.get(DAY_KEY), '25');
    assert.equal(redis.store.get(MONTH_KEY), '25');
    assert.equal(redis.store.has('reservation:b'), false);
  });

  it('releases failed once-per-day work for retry but keeps its coverage protected', () => {
    const redis = makeRedis();
    runScript(RESERVE_LUA, budgetKeys('reservation:a', 'coverage:audit'), reserveArgs(25, 25, 25, true), redis, 6);
    const settled = runScript(
      SETTLE_LUA,
      settleKeys('reservation:a', ONCE_KEY, 'coverage:audit'),
      settleArgs(0, '', '-', {
        hasOnce: true,
        completeOnce: false,
        hasCoverageUnit: true,
        completeCoverage: false,
        coverageUnit: 25,
      }),
      redis,
      6,
    );
    assert.deepEqual(settled, [1, 0, 0, 25, 0, 25]);
    assert.equal(redis.store.has(ONCE_KEY), false);
    assert.equal(redis.store.get(COVERAGE_HOLD_KEY), '25');
    assert.deepEqual(
      runScript(RESERVE_LUA, budgetKeys('reservation:b', 'coverage:audit'), reserveArgs(25, 25, 25, true), redis, 6),
      [1, 25, 25, 0, 25, ''],
    );
  });

  it('reads day and month counters without changing them', () => {
    const redis = makeRedis({ [DAY_KEY]: 25, [MONTH_KEY]: 425 });
    assert.deepEqual(runScript(STATUS_LUA, [DAY_KEY, MONTH_KEY, COVERAGE_HOLD_KEY], [], redis, 3), [25, 425, 0]);
    assert.deepEqual(redis.commands, [['GET', DAY_KEY], ['GET', MONTH_KEY], ['GET', COVERAGE_HOLD_KEY]]);
  });

  it('keeps unpolled coverage durable across replicas and other consumers', () => {
    const redis = makeRedis({ [DAY_KEY]: 580, [MONTH_KEY]: 580 });
    const first = runScript(
      RESERVE_LUA,
      budgetKeys('reservation:first', 'coverage:timeline-a'),
      reserveArgs(10, 20, 10),
      redis,
      6,
    );
    assert.deepEqual(first, [1, 590, 590, 0, 20, '']);
    assert.equal(redis.store.get(COVERAGE_HOLD_KEY), '20');

    const settled = runScript(
      SETTLE_LUA,
      settleKeys('reservation:first', ONCE_KEY, 'coverage:timeline-a'),
      settleArgs(10, '', '-', {
        hasCoverageUnit: true,
        completeCoverage: true,
        coverageUnit: 10,
      }),
      redis,
      6,
    );
    assert.deepEqual(settled, [1, 590, 590, 10, 10, 10]);

    const company = runScript(
      RESERVE_LUA,
      budgetKeys('reservation:company', 'coverage:none'),
      reserveArgs(1),
      redis,
      6,
    );
    assert.deepEqual(company, [0, 590, 590, 1, 10, ''], 'another consumer cannot spend held coverage');

    const second = runScript(
      RESERVE_LUA,
      budgetKeys('reservation:second', 'coverage:timeline-b'),
      reserveArgs(10, 20, 10),
      redis,
      6,
    );
    assert.deepEqual(second, [1, 600, 600, 0, 10, ''], 'a new replica can consume the remaining protected unit');
  });

  it('installs the curated hold before another consumer can spend after midnight', () => {
    const redis = makeRedis();
    const company = runScript(
      RESERVE_LUA,
      budgetKeys('reservation:company', 'coverage:none'),
      reserveArgs(10, 597),
      redis,
      6,
    );
    assert.deepEqual(company, [0, 0, 0, 1, 597, '']);
    assert.equal(redis.store.get(COVERAGE_HOLD_KEY), '597');
    assert.equal(redis.store.has('reservation:company'), false);

    const curated = runScript(
      RESERVE_LUA,
      budgetKeys('reservation:curated', 'coverage:timeline-a'),
      reserveArgs(10, 597, 10),
      redis,
      6,
    );
    assert.deepEqual(curated, [1, 10, 10, 0, 597, '']);
    assert.deepEqual(
      runScript(
        SETTLE_LUA,
        settleKeys('reservation:curated', ONCE_KEY, 'coverage:timeline-a'),
        settleArgs(10, '', '-', {
          hasCoverageUnit: true,
          completeCoverage: true,
          coverageUnit: 10,
        }),
        redis,
        6,
      ),
      [1, 10, 10, 10, 10, 587],
    );
  });

  it('stores a paid page with settlement, replays it without charging, and acknowledges once', () => {
    const receiptJson = JSON.stringify({
      version: 1,
      accountId: '1652541',
      sinceId: '100',
      body: { data: [{ id: '1999999999999999999' }] },
    });
    const redis = makeRedis();
    const first = runScript(RESERVE_LUA, budgetKeys(), reserveArgs(10, 0, 0, false, true), redis, 6);
    assert.deepEqual(first, [1, 10, 10, 0, 0, '']);
    assert.equal(redis.store.get(INFLIGHT_KEY), RESERVATION_KEY);

    const competing = runScript(
      RESERVE_LUA,
      budgetKeys('reservation:competitor'),
      reserveArgs(10, 0, 0, false, true),
      redis,
      6,
    );
    assert.deepEqual(competing, [0, 10, 10, 5, 0, '']);
    assert.equal(redis.store.get(DAY_KEY), '10');

    const settled = runScript(
      SETTLE_LUA,
      settleKeys(),
      settleArgs(1, receiptJson, 'abc123', true),
      redis,
      6,
    );
    assert.deepEqual(settled, [1, 1, 1, 10, 1, 0]);
    assert.equal(redis.store.get(RECEIPT_KEY), receiptJson);
    assert.equal(redis.expirations.has(RECEIPT_KEY), false, 'an unpublished paid receipt cannot expire into a duplicate X read');
    assert.equal(redis.store.has(INFLIGHT_KEY), false);

    const replay = runScript(
      RESERVE_LUA,
      budgetKeys('reservation:replay'),
      reserveArgs(10, 0, 0, false, true),
      redis,
      6,
    );
    assert.deepEqual(replay, [0, 1, 1, 4, 0, receiptJson]);
    assert.equal(redis.store.get(DAY_KEY), '1', 'receipt replay does not buy the page again');

    assert.equal(runScript(ACK_RECEIPTS_LUA, [RECEIPT_KEY], [receiptJson], redis, null), 1);
    assert.equal(redis.store.has(RECEIPT_KEY), false);
    assert.equal(runScript(ACK_RECEIPTS_LUA, [RECEIPT_KEY], [receiptJson], redis, null), 1,
      'acknowledgement is idempotent when a retry sees a missing receipt');
  });

  it('settles a failed response at zero and releases its receipt in-flight lock', () => {
    const redis = makeRedis();
    runScript(RESERVE_LUA, budgetKeys(), reserveArgs(10, 0, 0, false, true), redis, 6);
    const settled = runScript(
      SETTLE_LUA,
      settleKeys(),
      settleArgs(0, '', '-', { hasReceiptScope: true, storeReceipt: false }),
      redis,
      6,
    );
    assert.deepEqual(settled, [1, 0, 0, 10, 0, 0]);
    assert.equal(redis.store.has(INFLIGHT_KEY), false);
    assert.equal(redis.store.has(RECEIPT_KEY), false);
  });

  it('does not let a stale acknowledgement delete a newer receipt', () => {
    const currentReceipt = '{"version":1,"accountId":"new"}';
    const redis = makeRedis({ [RECEIPT_KEY]: currentReceipt });
    const acknowledged = runScript(
      ACK_RECEIPTS_LUA,
      [RECEIPT_KEY],
      ['{"version":1,"accountId":"old"}'],
      redis,
      null,
    );
    assert.equal(acknowledged, 0);
    assert.equal(redis.store.get(RECEIPT_KEY), currentReceipt);
  });
});

describe('X Post budget key scope', () => {
  it('makes every consumer share the same UTC day and month counters', async () => {
    let now = Date.parse('2026-09-30T23:59:59.000Z');
    let id = 0;
    const calls = [];
    const budget = createXPostBudget({
      now: () => now,
      idFactory: () => `id-${++id}`,
      evalCommand: async (script, keys) => {
        calls.push({ script, keys });
        return [1, 1, 1, 0, 0];
      },
    });
    await budget.reserve({ consumer: 'curated-feed', operation: 'timeline', requestedPosts: 1 });
    await budget.reserve({ consumer: 'company-monitoring', operation: 'search', requestedPosts: 1 });
    assert.deepEqual(calls[0].keys.slice(0, 2), calls[1].keys.slice(0, 2));

    now = Date.parse('2026-10-01T00:00:00.000Z');
    await budget.reserve({ consumer: 'curated-feed', operation: 'timeline', requestedPosts: 1 });
    assert.match(calls[2].keys[0], /:day:2026-10-01$/);
    assert.match(calls[2].keys[1], /:month:2026-10$/);
  });

  it('rejects a missing requested-Post maximum before Redis is called', async () => {
    let called = false;
    const budget = createXPostBudget({
      evalCommand: async () => { called = true; return null; },
    });
    await assert.rejects(() => budget.reserve({ consumer: 'curated-feed', operation: 'timeline' }),
      /requestedPosts must be a positive integer/);
    assert.equal(called, false);
  });
});
