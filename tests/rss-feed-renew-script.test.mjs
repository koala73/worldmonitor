// Runs the real 304 renewal script in a Lua 5.3 VM (fengari) against an
// in-memory Redis double. Only redis.call, cjson and KEYS/ARGV are shimmed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

import { RSS_FEED_RENEW_SCRIPT } from '../shared/rss-feed-renew-script.mjs';

const KEY = 'rss:feed:v11:full:https://feeds.example.org/world.xml';
const PARSED_AT = 1_795_000_000_123;
const EXPIRES_AT = PARSED_AT + 7_200_000;

function makeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ttls = new Map();
  return {
    store,
    ttls,
    call(command, args) {
      const verb = String(command).toUpperCase();
      if (verb === 'GET') return store.get(args[0]) ?? null;
      if (verb === 'SET') {
        store.set(args[0], args[1]);
        if (String(args[2] ?? '').toUpperCase() === 'PXAT') ttls.set(args[0], Number(args[3]));
        return 'OK';
      }
      throw new Error(`redis double: unimplemented command ${verb}`);
    },
  };
}

function pushValue(L, value) {
  if (value === null || value === undefined) { lua.lua_pushnil(L); return; }
  if (typeof value === 'number') { lua.lua_pushnumber(L, value); return; }
  if (typeof value === 'boolean') { lua.lua_pushboolean(L, value); return; }
  if (typeof value === 'string') { lua.lua_pushstring(L, to_luastring(value)); return; }
  if (Array.isArray(value)) {
    lua.lua_createtable(L, value.length, 0);
    value.forEach((entry, index) => {
      pushValue(L, entry);
      lua.lua_seti(L, -2, index + 1);
    });
    return;
  }
  const entries = Object.entries(value);
  lua.lua_createtable(L, 0, entries.length);
  for (const [key, entry] of entries) {
    pushValue(L, entry);
    lua.lua_setfield(L, -2, to_luastring(key));
  }
}

function runRenew({ argv, redis }) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const argc = lua.lua_gettop(S);
    const command = to_jsstring(lua.lua_tostring(S, 1));
    const args = [];
    for (let i = 2; i <= argc; i += 1) args.push(to_jsstring(lua.lua_tostring(S, i)));
    pushValue(S, redis.call(command, args));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));

  // cjson.decode raises a Lua error on bad JSON, as the real one does.
  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const raw = to_jsstring(lua.lua_tostring(S, 1));
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return lauxlib.luaL_error(S, to_luastring('Expected value but found invalid token'));
    }
    pushValue(S, parsed);
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('decode'));
  lua.lua_setglobal(L, to_luastring('cjson'));

  pushValue(L, [KEY]);
  lua.lua_setglobal(L, to_luastring('KEYS'));
  pushValue(L, argv.map(String));
  lua.lua_setglobal(L, to_luastring('ARGV'));

  const luaError = () => {
    const raw = lua.lua_tostring(L, -1);
    return raw ? to_jsstring(raw) : '<no error message on the stack>';
  };
  if (lauxlib.luaL_loadstring(L, to_luastring(RSS_FEED_RENEW_SCRIPT)) !== lua.LUA_OK) assert.fail(`compile: ${luaError()}`);
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) assert.fail(`script raised: ${luaError()}`);
  return lua.lua_tonumber(L, -1);
}

const entry = (parsedAt, fetchedAt) => JSON.stringify({ items: [{ title: 'Story' }], parsedTotal: 1, parsedAt, fetchedAt });

describe('RSS feed 304 renewal script', () => {
  it('renews the entry while Redis still holds the parse the refresh read', () => {
    const redis = makeRedis({ [KEY]: entry(PARSED_AT, PARSED_AT) });
    const renewed = entry(PARSED_AT, PARSED_AT + 600_000);
    assert.equal(runRenew({ argv: [PARSED_AT, renewed, EXPIRES_AT], redis }), 1);
    assert.equal(redis.store.get(KEY), renewed);
    assert.equal(redis.ttls.get(KEY), EXPIRES_AT, 'an absolute expiry, not a TTL');
  });

  it('leaves a newer parse in place', () => {
    const newer = entry(PARSED_AT + 1, PARSED_AT + 1);
    const redis = makeRedis({ [KEY]: newer });
    assert.equal(runRenew({ argv: [PARSED_AT, entry(PARSED_AT, PARSED_AT + 600_000), EXPIRES_AT], redis }), 0);
    assert.equal(redis.store.get(KEY), newer);
    assert.equal(redis.ttls.has(KEY), false);
  });

  it('does not recreate an entry that expired, or overwrite one it cannot read', () => {
    const empty = makeRedis();
    assert.equal(runRenew({ argv: [PARSED_AT, entry(PARSED_AT, PARSED_AT), EXPIRES_AT], redis: empty }), 0);
    assert.equal(empty.store.has(KEY), false);

    const garbled = makeRedis({ [KEY]: 'not json' });
    assert.equal(runRenew({ argv: [PARSED_AT, entry(PARSED_AT, PARSED_AT), EXPIRES_AT], redis: garbled }), 0);
    assert.equal(garbled.store.get(KEY), 'not json');
  });

  it('is pinned byte for byte in the self-hosted Redis proxy allowlist', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const proxy = readFileSync(resolve(root, 'docker/redis-rest-proxy.mjs'), 'utf8');
    const block = proxy.match(/const RSS_FEED_RENEW_SCRIPT = (\[[\s\S]*?\])\.join\('\\n'\);/);
    assert.ok(block, 'the proxy carries a pinned copy');
    // eslint-disable-next-line no-new-func
    assert.equal(new Function(`return ${block[1]}`)().join('\n'), RSS_FEED_RENEW_SCRIPT);
    assert.match(proxy, /const ALLOWED_EVAL_SCRIPTS = new Set\(\[[\s\S]*?\n {2}RSS_FEED_RENEW_SCRIPT,[\s\S]*?\]\);/);
  });
});
