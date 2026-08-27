// #7084: EXECUTE the durable last-good publish gate, do not describe it.
//
// The gate that runs in production is Lua inside Redis. Every other test in
// this suite stubs runRedisPipeline, so the script's own behaviour was covered
// only by regex-matching its source text and byte-comparing it to a second
// copy of itself — two copies agreeing proves nothing about either being
// correct, and that blind spot is exactly how the cjson round-trip that
// rewrote every `[]` as `{}` shipped through five review rounds.
//
// This file runs the real script text in a Lua 5.3 VM (fengari) against an
// in-memory Redis double. Only `redis.call`, `cjson`, and the KEYS/ARGV
// globals are shimmed; the script's control flow is the genuine article.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

import { DIGEST_LASTGOOD_PUBLISH_SCRIPT } from '../shared/digest-lastgood-publish-script.mjs';
import { LASTGOOD_MAX_AGE_MS, LASTGOOD_TTL_S } from '../server/worldmonitor/news/v1/_lastgood.ts';

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const BODY_KEY = 'news:digest:lastgood:v1:full:en';
const REVOKED_KEY = 'news:digest:revoked-urls:v1';

/**
 * Minimal Redis double. Only the three commands the script issues are
 * implemented; anything else throws so an added command cannot pass silently.
 */
function makeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ttls = new Map();
  return {
    store,
    ttls,
    call(cmd, args) {
      const verb = String(cmd).toUpperCase();
      if (verb === 'SMEMBERS') return store.get(args[0]) ?? [];
      if (verb === 'GET') {
        const value = store.get(args[0]);
        return typeof value === 'string' ? value : null;
      }
      if (verb === 'SET') {
        store.set(args[0], args[1]);
        if (String(args[2] ?? '').toUpperCase() === 'EX') ttls.set(args[0], Number(args[3]));
        return 'OK';
      }
      throw new Error(`redis double: unimplemented command ${verb}`);
    },
  };
}

/** Push a JS value onto the Lua stack as a Lua value (tables for arrays/objects). */
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

/** Read one Lua stack slot back as a JS value (only what cjson.encode needs). */
function readValue(L, index) {
  const type = lua.lua_type(L, index);
  if (type === lua.LUA_TNIL) return null;
  if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index);
  if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index);
  if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index));
  if (type !== lua.LUA_TTABLE) return null;
  // Decide array vs object the way cjson does: a table with a 1..n integer
  // sequence and nothing else is an array.
  const absolute = lua.lua_absindex(L, index);
  const obj = {};
  let count = 0;
  let maxIndex = 0;
  let allIntegerKeys = true;
  lua.lua_pushnil(L);
  while (lua.lua_next(L, absolute) !== 0) {
    count += 1;
    const keyType = lua.lua_type(L, -2);
    let key;
    if (keyType === lua.LUA_TNUMBER) {
      const n = lua.lua_tonumber(L, -2);
      if (Number.isInteger(n) && n >= 1) maxIndex = Math.max(maxIndex, n);
      else allIntegerKeys = false;
      key = String(n);
    } else {
      allIntegerKeys = false;
      key = to_jsstring(lua.lua_tostring(L, -2));
    }
    obj[key] = readValue(L, -1);
    lua.lua_pop(L, 1);
  }
  if (allIntegerKeys && count > 0 && maxIndex === count) {
    return Array.from({ length: count }, (_, i) => obj[String(i + 1)]);
  }
  return obj;
}

/**
 * Run the real script text with the given KEYS/ARGV against the redis double.
 * Returns { result, redis }.
 */
function runScript({ keys, argv, redis }) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  // redis.call(cmd, ...)
  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const argc = lua.lua_gettop(S);
    const cmd = to_jsstring(lua.lua_tostring(S, 1));
    const args = [];
    for (let i = 2; i <= argc; i += 1) args.push(to_jsstring(lua.lua_tostring(S, i)));
    const out = redis.call(cmd, args);
    pushValue(S, out);
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));

  // cjson.decode / cjson.encode
  lua.lua_createtable(L, 0, 2);
  lua.lua_pushjsclosure(L, (S) => {
    const raw = to_jsstring(lua.lua_tostring(S, 1));
    pushValue(S, JSON.parse(raw));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('decode'));
  lua.lua_pushjsclosure(L, (S) => {
    lua.lua_pushstring(S, to_luastring(JSON.stringify(readValue(S, 1))));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('encode'));
  lua.lua_setglobal(L, to_luastring('cjson'));

  pushValue(L, keys);
  lua.lua_setglobal(L, to_luastring('KEYS'));
  pushValue(L, argv.map(String));
  lua.lua_setglobal(L, to_luastring('ARGV'));

  // Build the failure text lazily — a template literal is evaluated even when
  // the assertion passes, and lua_tostring returns null on a non-error stack.
  const luaError = () => {
    const raw = lua.lua_tostring(L, -1);
    return raw ? to_jsstring(raw) : '<no error message on the stack>';
  };
  const loaded = lauxlib.luaL_loadstring(L, to_luastring(DIGEST_LASTGOOD_PUBLISH_SCRIPT));
  if (loaded !== lua.LUA_OK) assert.fail(`script failed to compile: ${luaError()}`);
  const called = lua.lua_pcall(L, 0, 1, 0);
  if (called !== lua.LUA_OK) assert.fail(`script raised: ${luaError()}`);
  return { result: readValue(L, -1), redis };
}

const publish = ({ data, acceptedAt = NOW, now = NOW, initial = {} }) =>
  runScript({
    keys: [BODY_KEY, REVOKED_KEY],
    argv: [now, LASTGOOD_MAX_AGE_MS, acceptedAt, LASTGOOD_TTL_S, JSON.stringify(data)],
    redis: makeRedis(initial),
  });

const bodyOf = (links, extra = {}) => ({
  categories: { politics: { items: links.map((link) => ({ link, tickers: [] })) } },
  ...extra,
});

const snapshot = (data, acceptedAt) => JSON.stringify({ acceptedAt, categoryCount: 1, itemCount: 1, data });

describe('durable last-good publish gate — executed, not described (#7084)', () => {
  it('writes when there is no incumbent, and stores the body BYTE-FOR-BYTE', () => {
    const data = bodyOf(['https://a.test/1']);
    const { result, redis } = publish({ data });
    assert.equal(result, 1);
    const stored = redis.store.get(BODY_KEY);
    assert.equal(
      stored,
      `{"acceptedAt":${NOW},"categoryCount":1,"itemCount":1,"data":${JSON.stringify(data)}}`,
      'the candidate body must be spliced in verbatim, never re-encoded',
    );
    assert.equal(redis.ttls.get(BODY_KEY), LASTGOOD_TTL_S);
  });

  it('preserves empty arrays — the cjson round trip rewrote them as {}', () => {
    // `tickers: []` rides on every proto item and `items: []` on any category
    // the freshness floor emptied. A decode/encode round trip turned both into
    // `{}`, which threw out of filterRevokedUrls and out of the browser's .map.
    const data = {
      categories: {
        politics: { items: [{ link: 'https://a.test/1', tickers: [] }] },
        markets: { items: [] },
      },
      feedStatuses: {},
    };
    const { result, redis } = publish({ data });
    assert.equal(result, 1);
    const parsed = JSON.parse(redis.store.get(BODY_KEY));
    assert.deepEqual(parsed.data, data, 'the round trip must not alter the body at all');
    assert.ok(Array.isArray(parsed.data.categories.markets.items), 'items: [] must stay an array');
    assert.ok(Array.isArray(parsed.data.categories.politics.items[0].tickers), 'tickers: [] must stay an array');
  });

  it('keeps a live incumbent that is richer on categories', () => {
    const incumbent = {
      categories: { politics: { items: [{ link: 'https://a.test/1' }] }, tech: { items: [{ link: 'https://b.test/1' }] } },
    };
    const { result, redis } = publish({
      data: bodyOf(['https://a.test/1']),
      initial: { [BODY_KEY]: snapshot(incumbent, NOW - 60_000) },
    });
    assert.equal(result, 0, 'a narrower candidate must not displace a live snapshot');
    assert.equal(JSON.parse(redis.store.get(BODY_KEY)).acceptedAt, NOW - 60_000, 'incumbent left untouched');
  });

  it('keeps a live incumbent that is richer on items', () => {
    const incumbent = bodyOf(['https://a.test/1', 'https://a.test/2', 'https://a.test/3']);
    const { result } = publish({
      data: bodyOf(['https://a.test/9']),
      initial: { [BODY_KEY]: snapshot(incumbent, NOW - 60_000) },
    });
    assert.equal(result, 0, 'breadth parity is not enough — depth must not regress either');
  });

  it('replaces an incumbent past the six-hour window', () => {
    const incumbent = bodyOf(['https://a.test/1', 'https://a.test/2']);
    const { result } = publish({
      data: bodyOf(['https://a.test/9']),
      initial: { [BODY_KEY]: snapshot(incumbent, NOW - LASTGOOD_MAX_AGE_MS - 1) },
    });
    assert.equal(result, 1, 'an expired snapshot can never veto');
  });

  it('does not expire exactly AT the six-hour boundary', () => {
    const incumbent = bodyOf(['https://a.test/1', 'https://a.test/2']);
    const { result } = publish({
      data: bodyOf(['https://a.test/9']),
      initial: { [BODY_KEY]: snapshot(incumbent, NOW - LASTGOOD_MAX_AGE_MS) },
    });
    assert.equal(result, 0, 'at the bound the incumbent is still live');
  });

  it('replaces a future-dated (corrupt) incumbent rather than wedging on it', () => {
    const incumbent = bodyOf(['https://a.test/1', 'https://a.test/2']);
    const { result } = publish({
      data: bodyOf(['https://a.test/9']),
      initial: { [BODY_KEY]: snapshot(incumbent, NOW + 60_000) },
    });
    assert.equal(result, 1, 'the serve path refuses a future-dated row, so it must not veto here either');
  });

  it('replaces an incumbent whose stored JSON is corrupt', () => {
    const { result } = publish({
      data: bodyOf(['https://a.test/9']),
      initial: { [BODY_KEY]: 'not json at all' },
    });
    assert.equal(result, 1);
  });

  it('rejects a candidate whose every item is revoked', () => {
    const { result, redis } = publish({
      data: bodyOf(['https://a.test/1']),
      initial: { [REVOKED_KEY]: ['https://a.test/1'] },
    });
    assert.equal(result, -1, 'a fully-revoked candidate has no servable items');
    assert.equal(redis.store.get(BODY_KEY), undefined, 'nothing may be written on rejection');
  });

  it('rejects a candidate with zero categories', () => {
    assert.equal(publish({ data: { categories: {} } }).result, -1);
  });

  it('re-measures the incumbent under the CURRENT revocation view', () => {
    // The incumbent looked richer when it was published, but two of its items
    // have since been revoked. Publication-time counts would let a dead
    // snapshot veto its own repair.
    const incumbent = bodyOf(['https://a.test/old-1', 'https://a.test/old-2', 'https://a.test/live']);
    const { result } = publish({
      data: bodyOf(['https://a.test/new-1', 'https://a.test/new-2']),
      initial: {
        [BODY_KEY]: snapshot(incumbent, NOW - 60_000),
        [REVOKED_KEY]: ['https://a.test/old-1', 'https://a.test/old-2'],
      },
    });
    assert.equal(result, 1, 'a revoked-out incumbent must not veto a richer live candidate');
  });

  it('stores revoked items unfiltered so a lifted revocation restores them', () => {
    const data = bodyOf(['https://a.test/1', 'https://a.test/2']);
    const { redis } = publish({ data, initial: { [REVOKED_KEY]: ['https://a.test/1'] } });
    const parsed = JSON.parse(redis.store.get(BODY_KEY));
    assert.equal(parsed.data.categories.politics.items.length, 2, 'the body keeps every item');
    assert.equal(parsed.itemCount, 1, 'but the richness count reflects what is servable now');
  });

  it('agrees with measureServableRichness, the TS twin the sidecar build uses', async () => {
    // Two implementations of one policy: the sidecar (tauri) build decides
    // replacement with measureServableRichness, production decides it in this
    // Lua. Nothing compared them, so their edge-case handling could drift and
    // the desktop build would quietly apply a different rule.
    const { __testing__ } = await import('../server/worldmonitor/news/v1/_lastgood-store.ts');
    const measure = __testing__.measureServableRichness;
    const cases = [
      { data: bodyOf(['https://a.test/1', 'https://a.test/2']), revoked: [] },
      { data: bodyOf(['https://a.test/1', 'https://a.test/2']), revoked: ['https://a.test/1'] },
      {
        data: {
          categories: {
            politics: { items: [{ link: 'https://a.test/1' }] },
            markets: { items: [] },
            tech: { items: [{ link: 'https://b.test/1' }, { link: 'https://b.test/2' }] },
          },
        },
        revoked: ['https://b.test/2'],
      },
    ];
    for (const { data, revoked } of cases) {
      const { redis } = publish({ data, initial: { [REVOKED_KEY]: revoked } });
      const stored = JSON.parse(redis.store.get(BODY_KEY));
      const ts = measure(data, new Set(revoked));
      assert.deepEqual(
        { categoryCount: stored.categoryCount, itemCount: stored.itemCount }, ts,
        `Lua and TS must count ${JSON.stringify(data)} identically under ${JSON.stringify(revoked)}`,
      );
    }
  });

  it('issues exactly one SMEMBERS and one GET, and writes exactly one key', () => {
    const data = bodyOf(['https://a.test/1']);
    const seen = [];
    const redis = makeRedis();
    const inner = redis.call.bind(redis);
    redis.call = (cmd, args) => { seen.push(String(cmd).toUpperCase()); return inner(cmd, args); };
    runScript({
      keys: [BODY_KEY, REVOKED_KEY],
      argv: [NOW, LASTGOOD_MAX_AGE_MS, NOW, LASTGOOD_TTL_S, JSON.stringify(data)],
      redis,
    });
    assert.deepEqual(seen, ['SMEMBERS', 'GET', 'SET'], 'the atomic gate must stay a three-command operation');
  });
});
