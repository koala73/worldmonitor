import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

import { STORY_ALIAS_PUBLISH_SCRIPT } from '../shared/story-alias-publish-script.mjs';

const LOCK_KEY = 'story:alias:publish-lock:v1';
const ALIAS_A = 'story:alias:v1:a';
const ALIAS_B = 'story:alias:v1:b';

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
        if (String(args[2] ?? '').toUpperCase() === 'EX') ttls.set(args[0], Number(args[3]));
        return 'OK';
      }
      throw new Error(`redis double: unimplemented command ${verb}`);
    },
  };
}

function pushStringArray(L, values) {
  lua.lua_createtable(L, values.length, 0);
  values.forEach((value, index) => {
    lua.lua_pushstring(L, to_luastring(String(value)));
    lua.lua_seti(L, -2, index + 1);
  });
}

function readResult(L) {
  const type = lua.lua_type(L, -1);
  if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, -1);
  if (type === lua.LUA_TSTRING) {
    const value = to_jsstring(lua.lua_tostring(L, -1));
    const numeric = Number(value);
    return Number.isFinite(numeric) && String(numeric) === value ? numeric : value;
  }
  if (type === lua.LUA_TNIL) return null;
  return null;
}

function runAliasScript({ keys, argv, redis }) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const argc = lua.lua_gettop(S);
    const command = to_jsstring(lua.lua_tostring(S, 1));
    const args = [];
    for (let index = 2; index <= argc; index += 1) {
      args.push(to_jsstring(lua.lua_tostring(S, index)));
    }
    const result = redis.call(command, args);
    if (result === null) lua.lua_pushnil(S);
    else if (typeof result === 'number') lua.lua_pushnumber(S, result);
    else lua.lua_pushstring(S, to_luastring(result));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));

  pushStringArray(L, keys);
  lua.lua_setglobal(L, to_luastring('KEYS'));
  pushStringArray(L, argv);
  lua.lua_setglobal(L, to_luastring('ARGV'));

  const errorText = () => {
    const message = lua.lua_tostring(L, -1);
    return message ? to_jsstring(message) : '<no Lua error message>';
  };
  assert.equal(lauxlib.luaL_loadstring(L, to_luastring(STORY_ALIAS_PUBLISH_SCRIPT)), lua.LUA_OK, errorText());
  assert.equal(lua.lua_pcall(L, 0, 1, 0), lua.LUA_OK, errorText());
  return readResult(L);
}

describe('story alias fenced publish script', () => {
  it('writes the entire alias cohort when the caller still owns the lease', () => {
    const redis = makeRedis({ [LOCK_KEY]: 'writer-a' });
    const result = runAliasScript({
      keys: [LOCK_KEY, ALIAS_A, ALIAS_B],
      argv: ['writer-a', 'canonical-a', '604800'],
      redis,
    });

    assert.equal(result, 1);
    assert.equal(redis.store.get(ALIAS_A), 'canonical-a');
    assert.equal(redis.store.get(ALIAS_B), 'canonical-a');
    assert.equal(redis.ttls.get(ALIAS_A), 604800);
    assert.equal(redis.ttls.get(ALIAS_B), 604800);
  });

  it('does not let an expired or superseded writer overwrite live aliases', () => {
    const redis = makeRedis({
      [LOCK_KEY]: 'writer-new',
      [ALIAS_A]: 'canonical-new',
      [ALIAS_B]: 'canonical-new',
    });
    const result = runAliasScript({
      keys: [LOCK_KEY, ALIAS_A, ALIAS_B],
      argv: ['writer-old', 'canonical-old', '604800'],
      redis,
    });

    assert.equal(result, 0);
    assert.equal(redis.store.get(ALIAS_A), 'canonical-new');
    assert.equal(redis.store.get(ALIAS_B), 'canonical-new');
  });

  it('keeps the proxy allowlist copy byte-identical to the shared script', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const proxy = readFileSync(resolve(here, '../docker/redis-rest-proxy.mjs'), 'utf8');
    const block = proxy.match(/const STORY_ALIAS_PUBLISH_SCRIPT = (\[[\s\S]*?\])\.join\('\\n'\);/);
    assert.ok(block, 'the proxy must carry a pinned story-alias script copy');
    const proxyScript = (new Function(`return ${block[1]};`)()).join('\n');
    assert.equal(proxyScript, STORY_ALIAS_PUBLISH_SCRIPT);
    assert.match(proxy, /ALLOWED_EVAL_SCRIPTS/, 'the pinned script must be allowlisted');
  });
});
