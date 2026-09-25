import assert from 'node:assert/strict';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';
import { WIDGET_RESERVE_LUA, WIDGET_TARIFF } from '../api/_widget-quota.js';

function push(L, value) {
  if (value === undefined || value === null) return lua.lua_pushnil(L);
  if (typeof value === 'boolean') return lua.lua_pushboolean(L, value);
  if (typeof value === 'number') return lua.lua_pushnumber(L, value);
  if (typeof value === 'string')
    return lua.lua_pushstring(L, to_luastring(value));
  lua.lua_newtable(L);
  for (const [key, item] of Object.entries(value)) {
    push(L, item);
    if (Array.isArray(value)) lua.lua_seti(L, -2, Number(key) + 1);
    else lua.lua_setfield(L, -2, to_luastring(key));
  }
}
function read(L, index) {
  if (lua.lua_type(L, index) === lua.LUA_TNUMBER)
    return lua.lua_tonumber(L, index);
  if (lua.lua_type(L, index) === lua.LUA_TSTRING)
    return to_jsstring(lua.lua_tostring(L, index));
  if (lua.lua_type(L, index) === lua.LUA_TBOOLEAN)
    return lua.lua_toboolean(L, index);
  const result = {};
  const absolute = lua.lua_absindex(L, index);
  lua.lua_pushnil(L);
  while (lua.lua_next(L, absolute)) {
    const key = read(L, -2);
    result[key] = read(L, -1);
    lua.lua_pop(L, 1);
  }
  return result;
}
export function quotaStore(limit = 100000000) {
  const store = new Map(
    Object.entries({
      tariff: WIDGET_TARIFF,
      globalLimit: String(limit),
      basicLimit: String(limit),
      proLimit: String(limit),
      day: '0',
      spent: '0',
    }),
  );
  const clock = { now: 1789084800 };
  function run(argv) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const register = (name, methods) => {
      lua.lua_newtable(L);
      for (const [method, fn] of Object.entries(methods)) {
        lua.lua_pushjsfunction(L, (S) => {
          try {
            push(
              S,
              fn(
                ...Array.from({ length: lua.lua_gettop(S) }, (_, i) =>
                  read(S, i + 1),
                ),
              ),
            );
            return 1;
          } catch (err) {
            push(S, err.message);
            return lua.lua_error(S);
          }
        });
        lua.lua_setfield(L, -2, to_luastring(method));
      }
      lua.lua_setglobal(L, to_luastring(name));
    };
    register('redis', {
      call(command, ...args) {
        if (command === 'TIME') return [String(clock.now), '0'];
        if (command === 'HMGET')
          return args.slice(1).map((k) => store.get(k) ?? false);
        if (command === 'HGET') return store.get(args[1]) ?? false;
        if (command === 'HSET') {
          for (let i = 1; i < args.length; i += 2)
            store.set(args[i], String(args[i + 1]));
          return 1;
        }
        throw new Error(`Unexpected Redis command ${command}`);
      },
    });
    register('cjson', { encode: JSON.stringify, decode: JSON.parse });
    push(L, ['widget:quota:v1']);
    lua.lua_setglobal(L, to_luastring('KEYS'));
    push(L, argv.map(String));
    lua.lua_setglobal(L, to_luastring('ARGV'));
    assert.equal(
      lauxlib.luaL_loadstring(L, to_luastring(WIDGET_RESERVE_LUA)),
      lua.LUA_OK,
    );
    const status = lua.lua_pcall(L, 0, 1, 0);
    assert.equal(status, lua.LUA_OK, status ? String(read(L, -1)) : '');
    const result = read(L, -1);
    lua.lua_close(L);
    return [result[1], result[2]];
  }
  return {
    store,
    clock,
    run,
    fetch: async (_url, init) => {
      const command = JSON.parse(init.body);
      assert.equal(command[0], 'EVAL');
      assert.equal(command[1], WIDGET_RESERVE_LUA);
      return Response.json({ result: run(command.slice(4)) });
    },
  };
}
