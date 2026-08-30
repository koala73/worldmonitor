import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

const here = dirname(fileURLToPath(import.meta.url));

const {
  OPENSKY_COOLDOWN_KEY,
  OPENSKY_LEGACY_COOLDOWN_KEY,
  OPENSKY_MAX_COOLDOWN_MS,
  OPENSKY_MAX_CLOCK_SKEW_MS,
  OPENSKY_SHARED_FALLBACK_COOLDOWN_MS,
  OPENSKY_MAX_DEADLINE_SET_LUA,
  OPENSKY_COMPARE_AND_DEL_LUA,
  accountFingerprint,
  cooldownKeyForAccount,
  clampCooldownMs,
  ttlSecondsForCooldown,
  inspectCooldownRecord,
  buildCooldownRecord,
  applyMaxDeadlineWrite,
  applyCompareAndDelete,
  maxDeadlineSetCommand,
  compareAndDelCommand,
  legacyCooldownCompatibilityEnabled,
} = createRequire(import.meta.url)('../scripts/_opensky-account-cooldown.cjs');

function pushLuaValue(L, value) {
  if (value === null || value === undefined) {
    lua.lua_pushnil(L);
  } else if (typeof value === 'boolean') {
    lua.lua_pushboolean(L, value);
  } else if (typeof value === 'number') {
    lua.lua_pushnumber(L, value);
  } else if (typeof value === 'string') {
    lua.lua_pushstring(L, to_luastring(value));
  } else {
    const entries = Object.entries(value);
    lua.lua_createtable(L, 0, entries.length);
    for (const [key, entry] of entries) {
      pushLuaValue(L, entry);
      lua.lua_setfield(L, -2, to_luastring(key));
    }
  }
}

function pushLuaStringArray(L, values) {
  lua.lua_createtable(L, values.length, 0);
  values.forEach((value, index) => {
    lua.lua_pushstring(L, to_luastring(String(value)));
    lua.lua_seti(L, -2, index + 1);
  });
}

function makeLuaRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    call(command, args) {
      const verb = String(command).toUpperCase();
      if (verb === 'GET') return store.get(args[0]) ?? null;
      if (verb === 'SET') {
        store.set(args[0], args[1]);
        return 'OK';
      }
      throw new Error('Redis double: unimplemented ' + verb);
    },
  };
}

function runMaxDeadlineSet(redis, record, keys = [OPENSKY_COOLDOWN_KEY]) {
  const command = maxDeadlineSetCommand(
    keys,
    record,
    ttlSecondsForCooldown(record.cooldownMs),
  );
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    const args = [];
    for (let index = 2; index <= lua.lua_gettop(S); index += 1) {
      args.push(to_jsstring(lua.lua_tostring(S, index)));
    }
    const result = redis.call(to_jsstring(lua.lua_tostring(S, 1)), args);
    if (result === null) lua.lua_pushnil(S);
    else if (typeof result === 'number') lua.lua_pushnumber(S, result);
    else lua.lua_pushstring(S, to_luastring(result));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('call'));
  lua.lua_setglobal(L, to_luastring('redis'));

  lua.lua_createtable(L, 0, 1);
  lua.lua_pushjsclosure(L, (S) => {
    pushLuaValue(S, JSON.parse(to_jsstring(lua.lua_tostring(S, 1))));
    return 1;
  }, 0);
  lua.lua_setfield(L, -2, to_luastring('decode'));
  lua.lua_setglobal(L, to_luastring('cjson'));

  const keyCount = Number(command[2]);
  pushLuaStringArray(L, command.slice(3, 3 + keyCount));
  lua.lua_setglobal(L, to_luastring('KEYS'));
  pushLuaStringArray(L, command.slice(3 + keyCount));
  lua.lua_setglobal(L, to_luastring('ARGV'));

  const errorText = () => {
    const message = lua.lua_tostring(L, -1);
    return message ? to_jsstring(message) : '<no Lua error message>';
  };
  assert.equal(lauxlib.luaL_loadstring(L, to_luastring(OPENSKY_MAX_DEADLINE_SET_LUA)), lua.LUA_OK, errorText());
  assert.equal(lua.lua_pcall(L, 0, 1, 0), lua.LUA_OK, errorText());
  return lua.lua_tonumber(L, -1);
}

test('shared cooldown key and fingerprint stay stable across processes', () => {
  assert.equal(OPENSKY_COOLDOWN_KEY, 'opensky:cooldown-until:v2');
  assert.equal(OPENSKY_LEGACY_COOLDOWN_KEY, 'opensky:cooldown-until:v1');
  assert.equal(accountFingerprint('test-client'), accountFingerprint('test-client'));
  assert.notEqual(accountFingerprint('test-client'), accountFingerprint('other-client'));
  const account = accountFingerprint('test-client');
  assert.equal(cooldownKeyForAccount(account), OPENSKY_COOLDOWN_KEY + ':' + account);
  assert.notEqual(cooldownKeyForAccount(account), cooldownKeyForAccount(accountFingerprint('other-client')));
  assert.equal(cooldownKeyForAccount(null), OPENSKY_COOLDOWN_KEY + ':unknown');
  assert.equal(accountFingerprint(''), null);
  assert.equal(accountFingerprint(), null);
});

test('legacy compatibility has a finite cutoff', () => {
  const cutoff = '2026-09-07T00:00:00.000Z';
  assert.equal(legacyCooldownCompatibilityEnabled({
    now: Date.parse('2026-09-06T23:59:59.999Z'),
    cutoff,
  }), true);
  assert.equal(legacyCooldownCompatibilityEnabled({
    now: Date.parse(cutoff),
    cutoff,
  }), false);
  assert.equal(legacyCooldownCompatibilityEnabled({
    now: Date.parse('2026-09-08T00:00:00.000Z'),
    cutoff,
  }), false);
});

test('max-deadline command can atomically target account and legacy keys', () => {
  const account = accountFingerprint('test-client');
  const accountKey = cooldownKeyForAccount(account);
  const record = buildCooldownRecord({
    now: 1_700_000_000_000,
    cooldownMs: 10 * 60_000,
    account,
    recordedBy: 'ais-relay',
  });
  const command = maxDeadlineSetCommand(
    [accountKey, OPENSKY_LEGACY_COOLDOWN_KEY],
    record,
    ttlSecondsForCooldown(record.cooldownMs),
  );

  assert.equal(command[2], '2');
  assert.deepEqual(command.slice(3, 5), [accountKey, OPENSKY_LEGACY_COOLDOWN_KEY]);
  assert.deepEqual(JSON.parse(command[5]), record);

  const redis = makeLuaRedis();
  assert.equal(runMaxDeadlineSet(redis, record, [accountKey, OPENSKY_LEGACY_COOLDOWN_KEY]), 2);
  assert.equal(redis.store.get(accountKey), JSON.stringify(record));
  assert.equal(redis.store.get(OPENSKY_LEGACY_COOLDOWN_KEY), JSON.stringify(record));
});

test('clamp uses the caller fallback and caps at 24h', () => {
  assert.equal(clampCooldownMs(null, 90_000), 90_000);
  assert.equal(clampCooldownMs(30, 90_000), 90_000, 'advertised window below fallback still uses fallback');
  assert.equal(clampCooldownMs(900, 90_000), 900_000);
  assert.equal(clampCooldownMs(999_999, 90_000), OPENSKY_MAX_COOLDOWN_MS);
  assert.equal(ttlSecondsForCooldown(90_000), 150);
});

test('shared persist fallback spans the seeder */5 cadence', () => {
  assert.ok(OPENSKY_SHARED_FALLBACK_COOLDOWN_MS >= 300_000);
  assert.equal(OPENSKY_SHARED_FALLBACK_COOLDOWN_MS, 10 * 60_000);
  assert.equal(clampCooldownMs(null, OPENSKY_SHARED_FALLBACK_COOLDOWN_MS), 10 * 60_000);
  assert.equal(clampCooldownMs(120, OPENSKY_SHARED_FALLBACK_COOLDOWN_MS), 10 * 60_000);
});

test('inspectCooldownRecord fails open on corrupt, mismatched, and implausible records', () => {
  const account = accountFingerprint('test-client');
  const now = 1_700_000_000_000;
  assert.equal(inspectCooldownRecord(null, { account, now }).remainingMs, 0);
  assert.equal(inspectCooldownRecord({ until: 'nope' }, { account, now }).remainingMs, 0);
  assert.deepEqual(
    inspectCooldownRecord({ until: now + 60_000 }, { account, now }),
    { remainingMs: 0, ignoreReason: 'account-mismatch' },
  );
  assert.deepEqual(
    inspectCooldownRecord({ until: now + 60_000, account: 'other' }, { account, now }),
    { remainingMs: 0, ignoreReason: 'account-mismatch' },
  );
  const implausible = inspectCooldownRecord(
    { until: now + OPENSKY_MAX_COOLDOWN_MS + 1, account },
    { account, now },
  );
  assert.equal(implausible.remainingMs, 0);
  assert.equal(implausible.ignoreReason, 'implausible-deadline');
  assert.equal(
    inspectCooldownRecord({ until: now + 45_000, account }, { account, now }).remainingMs,
    45_000,
  );
  assert.equal(
    inspectCooldownRecord({ until: now - 1, account }, { account, now }).remainingMs,
    0,
  );
});

test('inspectCooldownRecord retains a valid maximum cooldown across small writer-reader clock skew', () => {
  const account = accountFingerprint('test-client');
  const recordedAt = 1_700_000_000_000;
  const record = buildCooldownRecord({
    now: recordedAt,
    cooldownMs: OPENSKY_MAX_COOLDOWN_MS,
    account,
    recordedBy: 'seed-military-flights',
  });

  const inspected = inspectCooldownRecord(record, {
    account,
    now: recordedAt - 1,
  });
  assert.equal(inspected.remainingMs, OPENSKY_MAX_COOLDOWN_MS);
  assert.equal(inspected.ignoreReason, undefined);

  const atSkewLimit = inspectCooldownRecord(record, {
    account,
    now: recordedAt - OPENSKY_MAX_CLOCK_SKEW_MS,
  });
  assert.equal(atSkewLimit.remainingMs, OPENSKY_MAX_COOLDOWN_MS);

  const malformed = inspectCooldownRecord(
    { ...record, cooldownMs: String(record.cooldownMs) },
    { account, now: recordedAt - 1 },
  );
  assert.equal(malformed.remainingMs, 0);
  assert.equal(malformed.ignoreReason, 'implausible-deadline');

  const inconsistent = inspectCooldownRecord(
    { ...record, cooldownMs: record.cooldownMs - 1 },
    { account, now: recordedAt - 1 },
  );
  assert.equal(inconsistent.remainingMs, 0);
  assert.equal(inconsistent.ignoreReason, 'implausible-deadline');

  const farFuture = inspectCooldownRecord(record, {
    account,
    now: recordedAt - OPENSKY_MAX_CLOCK_SKEW_MS - 1,
  });
  assert.equal(farFuture.remainingMs, 0);
  assert.equal(farFuture.ignoreReason, 'implausible-deadline');
});

test('relay and seeder records are interchangeable for a matching account', () => {
  const account = accountFingerprint('shared-account');
  const now = 1_700_000_000_000;
  const seederRecord = buildCooldownRecord({
    now,
    cooldownMs: 10 * 60_000,
    retryAfterSeconds: null,
    account,
    recordedBy: 'seed-military-flights',
  });
  const relayRecord = buildCooldownRecord({
    now,
    cooldownMs: 90_000,
    retryAfterSeconds: 120,
    account,
    recordedBy: 'ais-relay',
  });
  assert.equal(seederRecord.recordedBy, 'seed-military-flights');
  assert.equal(relayRecord.recordedBy, 'ais-relay');
  assert.equal(inspectCooldownRecord(seederRecord, { account, now: now + 1_000 }).remainingMs, 599_000);
  assert.equal(inspectCooldownRecord(relayRecord, { account, now: now + 1_000 }).remainingMs, 89_000);
  assert.equal(seederRecord.revision, now);
  assert.equal(relayRecord.revision, now);
});

test('interleaved max-deadline writes keep the longer until', () => {
  const key = OPENSKY_COOLDOWN_KEY;
  const account = accountFingerprint('shared-account');
  const t0 = 1_700_000_000_000;
  const longRecord = buildCooldownRecord({
    now: t0,
    cooldownMs: 10 * 60_000,
    retryAfterSeconds: 900,
    account,
    recordedBy: 'seed-military-flights',
  });
  const shortRecord = buildCooldownRecord({
    now: t0 + 80,
    cooldownMs: 90_000,
    retryAfterSeconds: 30,
    account,
    recordedBy: 'ais-relay',
  });

  const lateShort = {};
  assert.equal(applyMaxDeadlineWrite(lateShort, key, longRecord).write, true);
  const skippedShort = applyMaxDeadlineWrite(lateShort, key, shortRecord);
  assert.equal(skippedShort.write, false);
  assert.equal(skippedShort.reason, 'existing-deadline-wins');
  assert.equal(skippedShort.existingUntil, longRecord.until);
  assert.equal(JSON.parse(lateShort[key]).until, longRecord.until);
  assert.equal(JSON.parse(lateShort[key]).recordedBy, 'seed-military-flights');

  const lateLong = {};
  assert.equal(applyMaxDeadlineWrite(lateLong, key, shortRecord).write, true);
  assert.equal(applyMaxDeadlineWrite(lateLong, key, longRecord).reason, 'newer-deadline');
  assert.equal(JSON.parse(lateLong[key]).until, longRecord.until);
  assert.equal(JSON.parse(lateLong[key]).recordedBy, 'seed-military-flights');
});

test('account-scoped keys preserve a new-account cooldown during rotation', () => {
  const t0 = 1_700_000_000_000;
  const oldAccount = accountFingerprint('old-client');
  const newAccount = accountFingerprint('new-client');
  const oldKey = cooldownKeyForAccount(oldAccount);
  const newKey = cooldownKeyForAccount(newAccount);
  const newAccountLong = buildCooldownRecord({
    now: t0,
    cooldownMs: 10 * 60_000,
    account: newAccount,
    recordedBy: 'seed-military-flights',
  });
  const oldAccountLaterShort = buildCooldownRecord({
    now: t0 + 1_000,
    cooldownMs: 90_000,
    account: oldAccount,
    recordedBy: 'ais-relay',
  });
  const store = {};

  applyMaxDeadlineWrite(store, newKey, newAccountLong);
  applyMaxDeadlineWrite(store, oldKey, oldAccountLaterShort);

  assert.notEqual(oldKey, newKey);
  assert.equal(JSON.parse(store[newKey]).account, newAccount);
  assert.equal(JSON.parse(store[newKey]).until, newAccountLong.until);
  assert.equal(inspectCooldownRecord(JSON.parse(store[newKey]), { account: newAccount, now: t0 }).remainingMs, 600_000);
});

test('compare-and-delete refuses a stale success after a newer longer cooldown', () => {
  const key = OPENSKY_COOLDOWN_KEY;
  const account = accountFingerprint('shared-account');
  const t0 = 1_700_000_000_000;
  const observedExpired = buildCooldownRecord({
    now: t0 - 200_000,
    cooldownMs: 90_000,
    account,
    recordedBy: 'ais-relay',
  });
  const newerLong = buildCooldownRecord({
    now: t0 + 25,
    cooldownMs: 15 * 60_000,
    retryAfterSeconds: 900,
    account,
    recordedBy: 'ais-relay',
  });

  const store = {};
  applyMaxDeadlineWrite(store, key, observedExpired);
  applyMaxDeadlineWrite(store, key, newerLong);

  assert.deepEqual(
    applyCompareAndDelete(store, key, {
      expectedJson: JSON.stringify(observedExpired),
      expectedRevision: String(observedExpired.revision),
      watermarkUntil: t0,
    }),
    { delete: false, reason: 'newer-revision' },
  );
  assert.equal(JSON.parse(store[key]).until, newerLong.until);

  assert.equal(
    applyCompareAndDelete(store, key, {
      expectedJson: '',
      expectedRevision: '',
      watermarkUntil: t0,
    }).delete,
    false,
    'fail-open success must not wipe an active later deadline',
  );

  const matching = { [key]: JSON.stringify(observedExpired) };
  assert.equal(
    applyCompareAndDelete(matching, key, {
      expectedRevision: String(observedExpired.revision),
      watermarkUntil: t0 - 1,
    }).reason,
    'revision-match',
  );
  assert.equal(matching[key], undefined);

  const leftover = { [key]: JSON.stringify(observedExpired) };
  assert.equal(
    applyCompareAndDelete(leftover, key, { watermarkUntil: t0 }).reason,
    'not-newer-than-watermark',
  );
  assert.equal(leftover[key], undefined);

  const corrupt = { [key]: '{not-json' };
  assert.equal(applyCompareAndDelete(corrupt, key, { watermarkUntil: t0 }).reason, 'unparseable');
});

test('EVAL command builders carry the shared Lua and compare args', () => {
  const record = buildCooldownRecord({
    now: 1_700_000_000_000,
    cooldownMs: 90_000,
    account: 'abc',
    recordedBy: 'ais-relay',
  });
  const setCmd = maxDeadlineSetCommand(OPENSKY_COOLDOWN_KEY, record, 150);
  assert.equal(setCmd[0], 'EVAL');
  assert.equal(setCmd[1], OPENSKY_MAX_DEADLINE_SET_LUA);
  assert.equal(setCmd[3], OPENSKY_COOLDOWN_KEY);
  assert.equal(JSON.parse(setCmd[4]).until, record.until);
  assert.equal(setCmd[6], String(record.until));
  assert.equal(setCmd[7], record.account);
  assert.match(OPENSKY_MAX_DEADLINE_SET_LUA, /type\(existing\) == 'table'/);
  assert.match(OPENSKY_MAX_DEADLINE_SET_LUA, /existing\['account'\] == incomingAccount/);

  const delCmd = compareAndDelCommand(OPENSKY_COOLDOWN_KEY, {
    expectedJson: JSON.stringify(record),
    expectedRevision: record.revision,
    watermarkUntil: record.recordedAt,
  });
  assert.equal(delCmd[1], OPENSKY_COMPARE_AND_DEL_LUA);
  assert.equal(delCmd[4], JSON.stringify(record));
  assert.equal(delCmd[5], String(record.revision));
  assert.equal(delCmd[6], String(record.recordedAt));
});

test('max-deadline Lua self-heals scalars and respects OpenSky account rotation', () => {
  const key = OPENSKY_COOLDOWN_KEY;
  const t0 = 1_700_000_000_000;
  const oldAccount = accountFingerprint('old-client');
  const newAccount = accountFingerprint('new-client');
  const scalarRepair = buildCooldownRecord({
    now: t0,
    cooldownMs: 90_000,
    account: newAccount,
    recordedBy: 'ais-relay',
  });
  const redis = makeLuaRedis({ [key]: JSON.stringify('legacy-scalar') });

  assert.equal(runMaxDeadlineSet(redis, scalarRepair), 1);
  assert.equal(redis.store.get(key), JSON.stringify(scalarRepair));

  const oldAccountLong = buildCooldownRecord({
    now: t0,
    cooldownMs: 10 * 60_000,
    account: oldAccount,
    recordedBy: 'seed-military-flights',
  });
  const newAccountShort = buildCooldownRecord({
    now: t0 + 1_000,
    cooldownMs: 90_000,
    account: newAccount,
    recordedBy: 'ais-relay',
  });
  redis.store.set(key, JSON.stringify(oldAccountLong));

  assert.equal(runMaxDeadlineSet(redis, newAccountShort), 1);
  assert.equal(redis.store.get(key), JSON.stringify(newAccountShort));

  const newAccountLong = buildCooldownRecord({
    now: t0 + 2_000,
    cooldownMs: 10 * 60_000,
    account: newAccount,
    recordedBy: 'seed-military-flights',
  });
  const newAccountLaterShort = buildCooldownRecord({
    now: t0 + 3_000,
    cooldownMs: 90_000,
    account: newAccount,
    recordedBy: 'ais-relay',
  });
  redis.store.set(key, JSON.stringify(newAccountLong));

  assert.equal(runMaxDeadlineSet(redis, newAccountLaterShort), 0);
  assert.equal(redis.store.get(key), JSON.stringify(newAccountLong));
});

test('relay and seeder wire the shared atomic helpers instead of SET/DEL', () => {
  const relay = readFileSync(join(here, '../scripts/ais-relay.cjs'), 'utf8');
  const seeder = readFileSync(join(here, '../scripts/seed-military-flights.mjs'), 'utf8');
  assert.match(relay, /maxDeadlineSetCommand/);
  assert.match(relay, /OPENSKY_MAX_DEADLINE_SET_LUA/);
  assert.match(relay, /cooldownKeyForAccount/);
  assert.match(relay, /OPENSKY_LEGACY_COOLDOWN_KEY/);
  assert.doesNotMatch(relay, /upstashSet\(OPENSKY_COOLDOWN_KEY/);
  assert.match(seeder, /maxDeadlineSetCommand/);
  assert.match(seeder, /compareAndDelCommand/);
  assert.match(seeder, /cooldownKeyForAccount/);
  assert.match(seeder, /OPENSKY_LEGACY_COOLDOWN_KEY/);
  assert.doesNotMatch(seeder, /redisSet\(\s*[\s\S]*OPENSKY_COOLDOWN_KEY/);
  assert.doesNotMatch(seeder, /redisDel\(\s*[\s\S]*OPENSKY_COOLDOWN_KEY/);
});
