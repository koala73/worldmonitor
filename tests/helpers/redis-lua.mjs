// Runs a Redis Lua script's real text in a Lua VM (fengari) against a test
// store's own command handler, so a store double that answers EVAL executes
// the script instead of describing it. Only `redis.call`, `unpack` (Redis
// scripts run Lua 5.1, fengari 5.3) and KEYS/ARGV are shimmed. A nil reply is
// pushed as false, as Redis does.
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

function pushValue(L, value) {
  if (value === null || value === undefined) { lua.lua_pushboolean(L, false); return; }
  if (typeof value === 'number') { lua.lua_pushinteger(L, value); return; }
  if (typeof value === 'boolean') { lua.lua_pushboolean(L, value); return; }
  if (Array.isArray(value)) {
    lua.lua_createtable(L, value.length, 0);
    value.forEach((entry, i) => {
      pushValue(L, entry);
      lua.lua_seti(L, -2, i + 1);
    });
    return;
  }
  lua.lua_pushstring(L, to_luastring(String(value)));
}

function readValue(L, index) {
  const type = lua.lua_type(L, index);
  if (type === lua.LUA_TNUMBER) return Math.trunc(lua.lua_tonumber(L, index));
  if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index));
  if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index) ? 1 : null;
  if (type !== lua.LUA_TTABLE) return null;
  const out = [];
  for (let i = 1; ; i++) {
    lua.lua_geti(L, index, i);
    if (lua.lua_type(L, -1) === lua.LUA_TNIL) { lua.lua_pop(L, 1); break; }
    out.push(readValue(L, lua.lua_gettop(L)));
    lua.lua_pop(L, 1);
  }
  return out;
}

/**
 * EVAL `script` with `keys` and `args`; `call(verb, args)` answers each
 * redis.call with a plain reply. Throws the script's error text.
 */
export function evalRedisLua(script, keys, args, call) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const argc = lua.lua_gettop(S);
    const verb = to_jsstring(lua.lua_tostring(S, 1)).toUpperCase();
    const callArgs = [];
    for (let i = 2; i <= argc; i++) callArgs.push(to_jsstring(lua.lua_tolstring(S, i)));
    pushValue(S, call(verb, callArgs));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));
  lua.lua_getglobal(L, to_luastring('table'));
  lua.lua_getfield(L, -1, to_luastring('unpack'));
  lua.lua_setglobal(L, to_luastring('unpack'));
  lua.lua_pop(L, 1);
  pushValue(L, keys.map(String));
  lua.lua_setglobal(L, to_luastring('KEYS'));
  pushValue(L, args.map(String));
  lua.lua_setglobal(L, to_luastring('ARGV'));
  const message = () => to_jsstring(lua.lua_tostring(L, -1) ?? to_luastring('<no message>'));
  if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK) throw new Error(`script failed to compile: ${message()}`);
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) throw new Error(`script raised: ${message()}`);
  return readValue(L, lua.lua_gettop(L));
}

/** Answer an ['EVAL', script, numkeys, ...keys, ...args] command through `call`. */
export function evalCommand(command, call) {
  const [, script, numkeys, ...rest] = command;
  const count = Number(numkeys);
  return evalRedisLua(String(script), rest.slice(0, count), rest.slice(count), call);
}
