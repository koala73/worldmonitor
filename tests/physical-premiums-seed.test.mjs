import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import fengari from 'fengari';

import {
  PHYSICAL_DIVERGENCE_KEY,
  PHYSICAL_PREMIUM_FETCH_TIMEOUT_MS,
  PHYSICAL_PREMIUM_HISTORY_KEY_PREFIX,
  PHYSICAL_PREMIUM_LOCK_TTL_MS,
  PHYSICAL_PREMIUM_SECTION_TIMEOUT_MS,
  PHYSICAL_PREMIUM_SECTION_WORST_CASE_MS,
  PHYSICAL_PREMIUM_SHARED_SEED_WORST_CASE_MS,
  APPEND_HISTORY_LUA,
  PUBLISH_PHYSICAL_PREMIUM_LUA,
  PUBLISH_DIVERGENCE_LUA,
  appendPhysicalPremiumHistory,
  buildPhysicalDivergenceSnapshot,
  buildPhysicalPremiumPayload,
  convertSgePriceToUsdPerOz,
  fetchSgeHtml,
  fetchPhysicalPremiumPayload,
  parseSeedTargetArgs,
  parseSgeBenchmarkHtml,
  physicalPremiumHistoryKey,
  physicalPremiumHistoryWriteCommand,
  physicalPremiumPublishCommand,
  physicalDivergenceMeta,
  physicalDivergencePublishCommand,
  publishPhysicalDivergenceDerivedData,
  retryDerivedRedisCommand,
  runPhysicalPremiumSeed,
  shouldWritePhysicalPremiumActivationMarker,
  validatePhysicalPremiumPayload,
} from '../scripts/seed-physical-premiums.mjs';
import { ADMISSION_HEADROOM_MS, KILL_GRACE_MS } from '../scripts/_bundle-runner.mjs';
import {
  HISTORY_LIMIT,
  METHODOLOGY_VERSION,
  TRAILING_WINDOW_POINTS,
  physicalPremiumHistoryPoint,
} from '../scripts/lib/physical-divergence.mjs';

const fixture = (name) => readFileSync(
  resolve(import.meta.dirname, 'fixtures/physical-premiums', name),
  'utf8',
);

const goldHtml = fixture('sge-gold-daily.html');
const silverHtml = fixture('sge-silver-daily.html');

function executeAppendHistoryLua(initialEntries, command) {
  const { lua, lauxlib, lualib, to_jsstring, to_luastring } = fengari;
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const [, , , key, date, encodedPoint, historyLimit, analysisLimit] = command;
  const source = `
local list = { ${initialEntries.map((entry) => JSON.stringify(entry)).join(', ')} }
KEYS = { ${JSON.stringify(key)} }
ARGV = { ${JSON.stringify(date)}, ${JSON.stringify(encodedPoint)}, ${JSON.stringify(historyLimit)}, ${JSON.stringify(analysisLimit)} }
cjson = {}
function cjson.decode(encoded)
  local parsedDate = string.match(encoded, '"date":"([^"]+)"')
  if parsedDate == nil then error('invalid JSON') end
  return { date = parsedDate }
end
redis = {}
function redis.call(commandName, ...)
  local args = { ... }
  if commandName == 'LRANGE' then
    local first = tonumber(args[2])
    local last = tonumber(args[3])
    if last < 0 then last = #list + last end
    local result = {}
    for index = first + 1, math.min(last + 1, #list) do table.insert(result, list[index]) end
    return result
  end
  if commandName == 'LREM' then
    local encoded = args[3]
    local retained = {}
    for _, item in ipairs(list) do
      if item ~= encoded then table.insert(retained, item) end
    end
    list = retained
    return 1
  end
  if commandName == 'LPUSH' then
    table.insert(list, 1, args[2])
    return #list
  end
  if commandName == 'LTRIM' then
    local first = tonumber(args[2])
    local last = tonumber(args[3])
    local retained = {}
    for index = first + 1, math.min(last + 1, #list) do table.insert(retained, list[index]) end
    list = retained
    return 'OK'
  end
  error('unsupported Redis command: ' .. commandName)
end
local function executeProductionScript()
${APPEND_HISTORY_LUA}
end
local result = executeProductionScript()
return #list, result, list
`;
  const status = lauxlib.luaL_dostring(state, to_luastring(source));
  if (status !== lua.LUA_OK) {
    const message = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_close(state);
    throw new Error(message);
  }
  const resultIndex = lua.lua_absindex(state, -2);
  const listIndex = lua.lua_absindex(state, -1);
  const readTable = (index) => Array.from({ length: lua.lua_rawlen(state, index) }, (_, offset) => {
    lua.lua_rawgeti(state, index, offset + 1);
    const value = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_pop(state, 1);
    return value;
  });
  const execution = {
    length: lua.lua_tointeger(state, -3),
    result: readTable(resultIndex),
    list: readTable(listIndex),
  };
  lua.lua_close(state);
  return execution;
}

function executePublishLua(command, script = PUBLISH_DIVERGENCE_LUA) {
  const { lua, lauxlib, lualib, to_jsstring, to_luastring } = fengari;
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const keyCount = Number(command[2]);
  const keys = command.slice(3, 3 + keyCount);
  const args = command.slice(3 + keyCount);
  const source = `
KEYS = { ${keys.map((value) => JSON.stringify(value)).join(', ')} }
ARGV = { ${args.map((value) => JSON.stringify(value)).join(', ')} }
local writes = {}
local ttls = {}
redis = {}
function redis.call(commandName, ...)
  local values = { ... }
  if commandName ~= 'SET' then error('unsupported Redis command: ' .. commandName) end
  writes[values[1]] = values[2]
  if values[3] == 'EX' then ttls[values[1]] = tonumber(values[4]) end
  return 'OK'
end
local function executeProductionScript()
${script}
end
executeProductionScript()
local result = {}
for _, key in ipairs(KEYS) do
  table.insert(result, key)
  table.insert(result, writes[key] or '__missing__')
  table.insert(result, tostring(ttls[key] or -1))
end
return result
`;
  const status = lauxlib.luaL_dostring(state, to_luastring(source));
  if (status !== lua.LUA_OK) {
    const message = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_close(state);
    throw new Error(message);
  }
  const resultIndex = lua.lua_absindex(state, -1);
  const flat = Array.from({ length: lua.lua_rawlen(state, resultIndex) }, (_, offset) => {
    lua.lua_rawgeti(state, resultIndex, offset + 1);
    const value = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_pop(state, 1);
    return value;
  });
  lua.lua_close(state);
  return Object.fromEntries(Array.from({ length: keyCount }, (_, index) => {
    const offset = index * 3;
    return [flat[offset], {
      value: flat[offset + 1] === '__missing__' ? undefined : flat[offset + 1],
      ttlSeconds: Number(flat[offset + 2]),
    }];
  }));
}

describe('physical premium seed', () => {
  it('keeps the bounded fetch phase inside the Redis lease', () => {
    assert.equal(PHYSICAL_PREMIUM_FETCH_TIMEOUT_MS, 60_000);
    assert.equal(PHYSICAL_PREMIUM_LOCK_TTL_MS, 600_000);
    assert.ok(PHYSICAL_PREMIUM_FETCH_TIMEOUT_MS < PHYSICAL_PREMIUM_LOCK_TTL_MS);
    assert.ok(120_000 < PHYSICAL_PREMIUM_SECTION_WORST_CASE_MS);
    assert.equal(PHYSICAL_PREMIUM_SHARED_SEED_WORST_CASE_MS, 228_500);
    assert.equal(PHYSICAL_PREMIUM_SECTION_WORST_CASE_MS, 435_500);
    assert.ok(PHYSICAL_PREMIUM_SECTION_WORST_CASE_MS < PHYSICAL_PREMIUM_SECTION_TIMEOUT_MS);
    assert.ok(PHYSICAL_PREMIUM_SECTION_TIMEOUT_MS < PHYSICAL_PREMIUM_LOCK_TTL_MS);
    assert.ok(PHYSICAL_PREMIUM_SECTION_TIMEOUT_MS + KILL_GRACE_MS + ADMISSION_HEADROOM_MS < 570_000);
  });

  it('parses the latest PM prints from real SGE response fixtures', () => {
    const gold = parseSgeBenchmarkHtml(goldHtml, { contract: 'SHAU', unit: 'gram' });
    const silver = parseSgeBenchmarkHtml(silverHtml, { contract: 'SHAG', unit: 'kilogram' });

    assert.equal(gold.length, 7);
    assert.deepEqual(gold[0], {
      asOf: '2026-08-18',
      contract: 'SHAU',
      amPrice: 953.79,
      pmPrice: 953.88,
      price: 953.88,
      session: 'PM',
      currency: 'CNY',
      unit: 'gram',
    });
    assert.equal(silver[0].price, 15941);
    assert.equal(silver[0].unit, 'kilogram');
  });

  it('labels an AM fallback as AM when the PM print is absent', () => {
    const html = `
      <table>
        <tr><th>Trade Date</th><th>Contract</th><th>Benchmark Price AM</th><th>Benchmark Price PM</th></tr>
        <tr><td>20260818</td><td>SHAU</td><td>953.79</td><td></td></tr>
      </table>`;
    const [row] = parseSgeBenchmarkHtml(html, { contract: 'SHAU', unit: 'gram' });
    assert.equal(row.session, 'AM');
    const payload = buildPhysicalPremiumPayload({
      goldRows: [row],
      silverRows: [{ ...row, contract: 'SHAG', unit: 'kilogram', price: 15941 }],
      commodityQuotes: { quotes: [{ symbol: 'GC=F', price: 4455.6 }, { symbol: 'SI=F', price: 65.31 }] },
      fxRates: { CNY: 0.1486, fallbackCurrencies: [] },
      computedAt: '2026-08-18T12:30:00.000Z',
    });
    assert.equal(payload.premiums[0].physical.source, 'Shanghai Gold Exchange SHAU AM benchmark');
  });

  it('rejects oversized and off-origin SGE responses before parsing', async () => {
    const headers = new Headers({ 'content-type': 'text/html', 'content-length': '256001' });
    await assert.rejects(
      fetchSgeHtml('https://en.sge.com.cn/data', 'SHAU', async () => ({
        ok: true, url: 'https://en.sge.com.cn/data', headers, text: async () => '<table></table>',
      })),
      /exceeds 256 KB/,
    );
    await assert.rejects(
      fetchSgeHtml('https://en.sge.com.cn/data', 'SHAU', async () => ({
        ok: true, url: 'https://example.com/data', headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<table></table>',
      })),
      /Unexpected SHAU response origin/,
    );
  });

  it('cancels chunked and falsely declared SGE bodies at the byte limit', async () => {
    for (const contentLength of [undefined, '1']) {
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(64_000));
          if (pulls >= 10) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const headers = new Headers({ 'content-type': 'text/html' });
      if (contentLength) headers.set('content-length', contentLength);

      await assert.rejects(
        fetchSgeHtml('https://en.sge.com.cn/data', 'SHAU', async () => new Response(body, {
          status: 200,
          headers,
        })),
        /exceeds 256 KB/,
      );
      assert.equal(cancelled, true);
      assert.ok(pulls < 10, 'the reader must stop before consuming the full body');
    }
  });

  it('executes the production four-input fetch seam with independent provenance clocks', async () => {
    const sgeCalls = [];
    const snapshotCalls = [];
    const paperFetchedAt = Date.parse('2026-08-18T12:22:24.000Z');
    const fxFetchedAt = Date.parse('2026-08-18T12:28:48.000Z');
    const payload = await fetchPhysicalPremiumPayload(
      { runStartedAtMs: Date.parse('2026-08-18T12:30:00.000Z') },
      {
        fetchSgeHtmlFn: async (url, contract) => {
          sgeCalls.push([url, contract]);
          return contract === 'SHAU' ? goldHtml : silverHtml;
        },
        readSeedSnapshotFn: async (key, options) => {
          snapshotCalls.push([key, options]);
          if (key === 'market:commodities-bootstrap:v1') {
            return {
              data: { quotes: [{ symbol: 'GC=F', price: 4455.6 }, { symbol: 'SI=F', price: 65.31 }] },
              meta: { fetchedAt: paperFetchedAt },
            };
          }
          return {
            data: { CNY: 0.1486, fallbackCurrencies: [] },
            meta: { fetchedAt: fxFetchedAt },
          };
        },
      },
    );

    assert.deepEqual(sgeCalls.map(([, contract]) => contract), ['SHAU', 'SHAG']);
    assert.deepEqual(snapshotCalls.map(([key]) => key), [
      'market:commodities-bootstrap:v1',
      'shared:fx-rates:v1',
    ]);
    assert.ok(snapshotCalls.every(([, options]) => options.strict && options.includeEnvelopeMeta));
    assert.ok(payload.premiums.every((premium) => premium.physical.asOf === '2026-08-18'));
    assert.ok(payload.premiums.every((premium) => premium.paper.asOf === '2026-08-18T12:22:24.000Z'));
    assert.equal(payload.fx.asOf, '2026-08-18T12:28:48.000Z');
  });

  it('uses the official SHAU gram and SHAG kilogram units in the troy-ounce conversion', () => {
    assert.ok(Math.abs(convertSgePriceToUsdPerOz(953.88, 'gram', 0.1486) - 4408.811089267622) < 1e-9);
    assert.ok(Math.abs(convertSgePriceToUsdPerOz(15941, 'kilogram', 0.1486) - 73.67892981718369) < 1e-9);
  });

  it('builds auditable physical and paper legs plus the derived premiums', () => {
    const payload = buildPhysicalPremiumPayload({
      goldRows: parseSgeBenchmarkHtml(goldHtml, { contract: 'SHAU', unit: 'gram' }),
      silverRows: parseSgeBenchmarkHtml(silverHtml, { contract: 'SHAG', unit: 'kilogram' }),
      commodityQuotes: {
        quotes: [
          { symbol: 'GC=F', price: 4455.6 },
          { symbol: 'SI=F', price: 65.31 },
        ],
      },
      fxRates: { CNY: 0.1486, fallbackCurrencies: [] },
      computedAt: '2026-08-18T12:30:00.000Z',
    });

    assert.equal(payload.premiums.length, 2);
    assert.deepEqual(payload.premiums[0].physical, {
      price: 953.88,
      currency: 'CNY',
      unit: 'gram',
      source: 'Shanghai Gold Exchange SHAU PM benchmark',
      asOf: '2026-08-18',
    });
    assert.deepEqual(payload.premiums[0].paper, {
      price: 4455.6,
      source: 'COMEX GC=F futures snapshot',
      asOf: '2026-08-18T12:30:00.000Z',
    });
    assert.equal(payload.premiums[0].premiumUsdPerOz, -46.7889);
    assert.equal(payload.premiums[0].premiumPct, -1.0501);
    assert.equal(payload.premiums[1].premiumUsdPerOz, 8.3689);
    assert.equal(payload.premiums[1].premiumPct, 12.8142);
    assert.deepEqual(payload.fx, {
      pair: 'CNY/USD',
      rate: 0.1486,
      source: 'shared:fx-rates:v1',
      asOf: '2026-08-18T12:30:00.000Z',
    });
    assert.equal(validatePhysicalPremiumPayload(payload), true);

    const future = structuredClone(payload);
    future.premiums[0].physical.asOf = '2026-08-19';
    assert.equal(validatePhysicalPremiumPayload(future), false);
  });

  it('fails closed on changed SGE markup', () => {
    assert.throws(
      () => parseSgeBenchmarkHtml('<table><tr><td>changed format</td></tr></table>', { contract: 'SHAU', unit: 'gram' }),
      /SHAU benchmark/,
    );
  });

  it('scopes non-production keys by environment and revision', () => {
    assert.deepEqual(parseSeedTargetArgs([]), { env: 'production', sha: '' });
    assert.deepEqual(
      parseSeedTargetArgs(['--env', 'preview', '--sha', 'abc123']),
      { env: 'preview', sha: 'abc123' },
    );
    assert.deepEqual(
      parseSeedTargetArgs(['--env=development']),
      { env: 'development', sha: 'dev' },
    );
    assert.throws(() => parseSeedTargetArgs(['--env=staging']), /Invalid --env/);
  });

  it('publishes the raw snapshot and production activation marker atomically', () => {
    assert.equal(shouldWritePhysicalPremiumActivationMarker('production'), true);
    assert.equal(shouldWritePhysicalPremiumActivationMarker('preview'), false);
    assert.equal(shouldWritePhysicalPremiumActivationMarker('development'), false);
    const production = physicalPremiumPublishCommand({
      canonicalKey: 'market:physical-premium:v1',
      payload: '{"premium":1}',
      ttlSeconds: 3600,
      env: 'production',
    });
    const productionWrites = executePublishLua(production, PUBLISH_PHYSICAL_PREMIUM_LUA);
    assert.equal(productionWrites['market:physical-premium:v1'].value, '{"premium":1}');
    assert.equal(productionWrites['market:physical-premium:v1'].ttlSeconds, 3600);
    assert.equal(productionWrites['seed-activated:market:physical-premium'].value, '1');
    assert.equal(productionWrites['seed-activated:market:physical-premium'].ttlSeconds, -1);

    const preview = physicalPremiumPublishCommand({
      canonicalKey: 'preview:abc:market:physical-premium:v1',
      payload: '{"premium":1}',
      ttlSeconds: 3600,
      env: parseSeedTargetArgs(['--env', 'preview', '--sha', 'abc']).env,
    });
    const previewWrites = executePublishLua(preview, PUBLISH_PHYSICAL_PREMIUM_LUA);
    assert.equal(previewWrites['seed-activated:market:physical-premium'].value, undefined);
  });

  it('passes runtime bounds, target scope, and publish callbacks to runSeed', async () => {
    const calls = [];
    const invocation = await runPhysicalPremiumSeed(
      ['--env', 'preview', '--sha', 'abc'],
      {
        runSeedFn: (...args) => args,
        publishPremiumFn: async (context) => { calls.push(['premium', context]); },
        publishDivergenceFn: async (context) => { calls.push(['divergence', context]); },
      },
    );
    const [domain, resource, canonicalKey, fetchFn, options] = invocation;
    assert.deepEqual(
      { domain, resource, canonicalKey },
      {
        domain: 'market',
        resource: 'physical-premium:preview:abc',
        canonicalKey: 'preview:abc:market:physical-premium:v1',
      },
    );
    assert.equal(options.lockTtlMs, PHYSICAL_PREMIUM_LOCK_TTL_MS);
    assert.equal(options.fetchPhaseTimeoutMs, PHYSICAL_PREMIUM_FETCH_TIMEOUT_MS);
    assert.equal(fetchFn, fetchPhysicalPremiumPayload);
    await options.publishAtomically({}, {
      canonicalKey,
      payload: '{"premium":1}',
      ttlSeconds: 3600,
    });
    const payload = { premiums: [] };
    await options.afterPublish(payload);
    assert.deepEqual(calls, [
      ['premium', { canonicalKey, payload: '{"premium":1}', ttlSeconds: 3600, env: 'preview' }],
      ['divergence', { payload, prefix: 'preview:abc:' }],
    ]);
  });

  it('uses one atomic append, date dedupe, and trim command for each bounded history list', async () => {
    const historyPoint = physicalPremiumHistoryPoint({
      premiumPct: -1.0501,
      premiumUsdPerOz: -46.7889,
      physical: { asOf: '2026-08-18' },
      paper: { asOf: '2026-08-19T12:30:00.000Z' },
      computedAt: '2026-08-20T09:00:00.000Z',
    });
    assert.ok(historyPoint);
    assert.equal(historyPoint.date, '2026-08-18');
    assert.equal(historyPoint.physicalAsOf, '2026-08-18');
    assert.equal(historyPoint.paperAsOf, '2026-08-19T12:30:00.000Z');
    assert.equal(historyPoint.methodologyVersion, METHODOLOGY_VERSION);
    const key = physicalPremiumHistoryKey('gold');
    const command = physicalPremiumHistoryWriteCommand(key, historyPoint);

    assert.equal(key, `${PHYSICAL_PREMIUM_HISTORY_KEY_PREFIX}:gold`);
    assert.equal(command[0], 'EVAL');
    assert.match(command[1], /LRANGE/);
    assert.match(command[1], /LREM/);
    assert.match(command[1], /LPUSH/);
    assert.match(command[1], /LTRIM/);
    assert.deepEqual(command.slice(2), ['1', key, historyPoint.date, JSON.stringify(historyPoint), '750', '250']);
    assert.equal(command[4], historyPoint.physicalAsOf);
    assert.notEqual(command[4], historyPoint.paperAsOf.slice(0, 10));

    const olderEntries = Array.from({ length: 750 }, (_, index) => ({
      ...historyPoint,
      date: new Date(Date.parse('2026-08-17T00:00:00.000Z') - index * 86_400_000).toISOString().slice(0, 10),
      physicalAsOf: new Date(Date.parse('2026-08-17T00:00:00.000Z') - index * 86_400_000).toISOString().slice(0, 10),
    }));
    const replacedEntry = { ...historyPoint, premiumPct: 99, premiumUsdPerOz: 99 };
    const initialList = [
      ...olderEntries.slice(0, 400),
      replacedEntry,
      ...olderEntries.slice(400),
    ].map(JSON.stringify);
    const execution = executeAppendHistoryLua(initialList, command);
    const calls = [];
    const appended = await appendPhysicalPremiumHistory(
      { restUrl: 'https://redis.test', token: 'test' },
      key,
      historyPoint,
      async (_creds, nextCommand) => {
        calls.push(nextCommand);
        return { result: execution.result };
      },
    );
    assert.deepEqual(calls, [command]);
    assert.equal(execution.length, HISTORY_LIMIT);
    assert.equal(execution.list.filter((encoded) => JSON.parse(encoded).date === historyPoint.date).length, 1);
    assert.deepEqual(JSON.parse(execution.list[0]), historyPoint);
    assert.equal(appended.length, TRAILING_WINDOW_POINTS);
    assert.deepEqual(appended[0], historyPoint);
  });

  it('publishes the snapshot, health metadata, and cooldowns in one pinned command', () => {
    const snapshot = {
      readings: [{ state: 'ok' }, { state: 'ok' }],
      composite: { state: 'ok', reason: '' },
      transitions: [{
        id: 'physical-premium:gold:normal-elevated:1787056200000',
        metal: 'gold',
      }],
    };
    const command = physicalDivergencePublishCommand({
      divergenceKey: 'test:market:physical-divergence:v1',
      metaKey: 'test:seed-meta:market:physical-divergence',
      snapshot,
      nowMs: 1_787_056_200_000,
      prefix: 'test:',
    });

    assert.equal(command[0], 'EVAL');
    assert.equal(command[1], PUBLISH_DIVERGENCE_LUA);
    assert.equal(command[2], '4');
    assert.deepEqual(command.slice(3, 7), [
      'test:market:physical-divergence:v1',
      'test:seed-meta:market:physical-divergence',
      'test:seed-activated:market:physical-divergence',
      'test:market:physical-divergence-transition-cooldown:v1:gold',
    ]);
    assert.equal(JSON.parse(command[8]).sourceState, 'ok');
    assert.equal(command[11], '0');
    assert.equal(JSON.parse(command.at(-1)).transitionId, snapshot.transitions[0].id);

    const previewWrites = executePublishLua(command);
    assert.deepEqual(JSON.parse(previewWrites[command[3]].value), snapshot);
    assert.equal(previewWrites[command[3]].ttlSeconds, Number(command[9]));
    assert.equal(JSON.parse(previewWrites[command[4]].value).sourceState, 'ok');
    assert.equal(previewWrites[command[4]].ttlSeconds, Number(command[9]));
    assert.equal(previewWrites[command[5]].value, undefined);
    assert.equal(JSON.parse(previewWrites[command[6]].value).transitionId, snapshot.transitions[0].id);
    assert.equal(previewWrites[command[6]].ttlSeconds, Number(command[10]));

    const productionCommand = physicalDivergencePublishCommand({
      divergenceKey: 'market:physical-divergence:v1',
      metaKey: 'seed-meta:market:physical-divergence',
      snapshot: { ...snapshot, transitions: [] },
      nowMs: 1_787_056_200_000,
    });
    assert.equal(productionCommand[5], 'seed-activated:market:physical-divergence');
    assert.equal(productionCommand.at(-1), '1');
    const productionWrites = executePublishLua(productionCommand);
    assert.equal(productionWrites[productionCommand[5]].value, '1');
    assert.equal(productionWrites[productionCommand[5]].ttlSeconds, -1);
  });

  it('derives health from every member and publishes the earliest input deadline', () => {
    const snapshot = {
      readings: [
        {
          state: 'insufficient_history',
          physicalAsOf: '2026-08-18',
          paperAsOf: '2026-08-18T12:30:00.000Z',
          provenance: { fxAsOf: '2026-08-18T12:30:00.000Z' },
        },
        {
          state: 'stale_input',
          physicalAsOf: '2026-08-18',
          paperAsOf: '2026-08-18T12:30:00.000Z',
          provenance: { fxAsOf: '2026-08-18T12:30:00.000Z' },
        },
      ],
      composite: { state: 'stale_input', reason: 'member_not_ok:silver:stale_input' },
    };
    const meta = physicalDivergenceMeta(snapshot, Date.parse('2026-08-18T12:30:00.000Z'));
    assert.equal(meta.sourceState, 'stale');
    assert.equal(meta.inputFreshUntil, Date.parse('2026-08-20T00:30:00.000Z'));

    snapshot.readings[1].state = 'missing_input';
    assert.equal(
      physicalDivergenceMeta(snapshot, Date.parse('2026-08-18T12:30:00.000Z')).sourceState,
      'error',
    );
  });

  it('publishes the Shanghai physical-print deadline when it is the earliest clock', () => {
    const snapshot = {
      readings: ['gold', 'silver'].map(() => ({
        state: 'ok',
        physicalAsOf: '2026-08-18',
        paperAsOf: '2026-09-30T00:00:00.000Z',
        provenance: { fxAsOf: '2026-09-30T00:00:00.000Z' },
      })),
      composite: { state: 'ok', reason: '' },
    };

    const meta = physicalDivergenceMeta(snapshot, Date.parse('2026-08-18T12:30:00.000Z'));
    assert.equal(meta.inputFreshUntil, Date.parse('2026-08-30T16:00:00.000Z'));
  });

  it('publishes bounded histories, the derived snapshot, metadata, and transition cooldowns', async () => {
    const payload = buildPhysicalPremiumPayload({
      goldRows: parseSgeBenchmarkHtml(goldHtml, { contract: 'SHAU', unit: 'gram' }),
      silverRows: parseSgeBenchmarkHtml(silverHtml, { contract: 'SHAG', unit: 'kilogram' }),
      commodityQuotes: {
        quotes: [{ symbol: 'GC=F', price: 4300 }, { symbol: 'SI=F', price: 70 }],
      },
      fxRates: { CNY: 0.1486, fallbackCurrencies: [] },
      computedAt: '2026-08-18T12:30:00.000Z',
    });
    const histories = Object.fromEntries(payload.premiums.map((premium) => [
      premium.metal,
      Array.from({ length: 60 }, (_, index) => ({
        date: new Date(Date.parse('2026-08-18T00:00:00.000Z') - index * 86_400_000).toISOString().slice(0, 10),
        premiumPct: index === 0 ? premium.premiumPct : 0,
        premiumUsdPerOz: index === 0 ? premium.premiumUsdPerOz : 0,
        physicalAsOf: new Date(Date.parse('2026-08-18T00:00:00.000Z') - index * 86_400_000).toISOString().slice(0, 10),
        paperAsOf: new Date(Date.parse('2026-08-18T12:30:00.000Z') - index * 86_400_000).toISOString(),
        methodologyVersion: METHODOLOGY_VERSION,
      })),
    ]));
    const previousSnapshot = {
      readings: payload.premiums.map((premium) => ({
        metal: premium.metal,
        state: 'ok',
        regime: 'normal',
      })),
    };
    const commands = [];
    const retryDelays = [];
    let transientFailureInjected = false;
    const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
    const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    try {
      const snapshot = await publishPhysicalDivergenceDerivedData({
        payload,
        prefix: 'test:',
        nowMs: Date.parse('2026-08-18T12:30:00.000Z'),
        retryDelayFn: async (delayMs) => retryDelays.push(delayMs),
        commandFn: async (_creds, command) => {
          commands.push(command);
          if (command[0] === 'EVAL' && command[1] === APPEND_HISTORY_LUA) {
            const metal = command[3].endsWith(':gold') ? 'gold' : 'silver';
            if (metal === 'gold' && !transientFailureInjected) {
              transientFailureInjected = true;
              throw Object.assign(new Error('Upstash HTTP 503'), { status: 503, retryAfterMs: 0 });
            }
            return { result: histories[metal].map((entry) => JSON.stringify(entry)) };
          }
          if (command[0] === 'EVAL' && command[1] === PUBLISH_DIVERGENCE_LUA) {
            return { result: Number(command[2]) };
          }
          if (command[0] === 'GET' && command[1] === 'test:market:physical-divergence:v1') {
            return { result: JSON.stringify(previousSnapshot) };
          }
          if (command[0] === 'GET') return { result: null };
          return { result: 'OK' };
        },
      });

      assert.equal(commands.filter(([verb]) => verb === 'EVAL').length, 4);
      assert.deepEqual(retryDelays, [250]);
      assert.ok(commands.some((command) => command[0] === 'GET' && command[1] === 'test:market:physical-divergence:v1'));
      const publish = commands.find((command) => command[1] === PUBLISH_DIVERGENCE_LUA);
      assert.ok(publish);
      assert.equal(publish[3], 'test:market:physical-divergence:v1');
      assert.equal(publish[4], 'test:seed-meta:market:physical-divergence');
      assert.equal(publish[5], 'test:seed-activated:market:physical-divergence');
      const publishedKeys = publish.slice(3, 3 + Number(publish[2]));
      const cooldownWrites = publishedKeys.filter((key) => (
        key.startsWith('test:market:physical-divergence-transition-cooldown:v1:')
      ));
      assert.ok(snapshot.transitions.length > 0);
      assert.equal(cooldownWrites.length, snapshot.transitions.length);
      assert.equal(commands.some(([verb]) => verb === 'SET'), false);
    } finally {
      if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
      if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
    }
  });

  it('publishes stale states without appending stale cohorts to durable history', async () => {
    const payload = buildPhysicalPremiumPayload({
      goldRows: parseSgeBenchmarkHtml(goldHtml, { contract: 'SHAU', unit: 'gram' }),
      silverRows: parseSgeBenchmarkHtml(silverHtml, { contract: 'SHAG', unit: 'kilogram' }),
      commodityQuotes: {
        quotes: [{ symbol: 'GC=F', price: 4300 }, { symbol: 'SI=F', price: 70 }],
      },
      fxRates: { CNY: 0.1486, fallbackCurrencies: [] },
      computedAt: '2026-08-18T12:00:00.000Z',
    });
    const existing = Object.fromEntries(payload.premiums.map((premium) => [
      premium.metal,
      [{
        date: '2026-08-17',
        premiumPct: 1,
        premiumUsdPerOz: 1,
        physicalAsOf: '2026-08-17',
        paperAsOf: '2026-08-17T12:00:00.000Z',
        methodologyVersion: METHODOLOGY_VERSION,
      }],
    ]));
    const commands = [];
    const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
    const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    try {
      const snapshot = await publishPhysicalDivergenceDerivedData({
        payload,
        nowMs: Date.parse('2026-08-20T00:00:01.000Z'),
        retryDelayFn: async () => {},
        commandFn: async (_creds, command) => {
          commands.push(command);
          if (command[0] === 'LRANGE') {
            const metal = command[1].endsWith(':gold') ? 'gold' : 'silver';
            return { result: existing[metal].map(JSON.stringify) };
          }
          if (command[0] === 'GET') return { result: null };
          return { result: 'OK' };
        },
      });

      assert.equal(commands.filter((command) => command[0] === 'EVAL').length, 1);
      assert.equal(commands.find((command) => command[0] === 'EVAL')?.[1], PUBLISH_DIVERGENCE_LUA);
      assert.equal(commands.filter(([verb]) => verb === 'LRANGE').length, 2);
      assert.ok(snapshot.readings.every((reading) => reading.state === 'stale_input'));
      assert.ok(snapshot.readings.every((reading) => reading.reason === 'paper_snapshot_older_than_36_hours'));
      assert.ok(snapshot.readings.every((reading) => reading.historyPoints === 1));
      assert.equal(physicalDivergenceMeta(snapshot, Date.parse('2026-08-20T00:00:01.000Z')).sourceState, 'stale');
    } finally {
      if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
      if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
    }
  });

  it('exhausts transient derived Redis failures and does not retry permanent failures', async () => {
    const creds = { restUrl: 'https://redis.test', token: 'test' };
    const delays = [];
    let transientAttempts = 0;
    await assert.rejects(
      retryDerivedRedisCommand(
        creds,
        ['GET', 'test:key'],
        async () => {
          transientAttempts += 1;
          throw Object.assign(new Error('Upstash HTTP 503'), { status: 503 });
        },
        async (delayMs) => delays.push(delayMs),
      ),
      /Upstash HTTP 503/,
    );
    assert.equal(transientAttempts, 3);
    assert.deepEqual(delays, [250, 500]);

    let timeoutAttempts = 0;
    await assert.rejects(
      retryDerivedRedisCommand(
        creds,
        ['GET', 'test:key'],
        async () => {
          timeoutAttempts += 1;
          throw Object.assign(new Error('Upstash HTTP 408'), { status: 408 });
        },
        async () => {},
      ),
      /Upstash HTTP 408/,
    );
    assert.equal(timeoutAttempts, 3);

    const cappedDelays = [];
    let cappedAttempts = 0;
    await assert.rejects(
      retryDerivedRedisCommand(
        creds,
        ['GET', 'test:key'],
        async () => {
          cappedAttempts += 1;
          throw Object.assign(new Error('Upstash HTTP 429'), { status: 429, retryAfterMs: 2_000 });
        },
        async (delayMs) => cappedDelays.push(delayMs),
      ),
      /Upstash HTTP 429/,
    );
    assert.equal(cappedAttempts, 3);
    assert.deepEqual(cappedDelays, [2_000, 2_000]);

    let permanentAttempts = 0;
    await assert.rejects(
      retryDerivedRedisCommand(
        creds,
        ['GET', 'test:key'],
        async () => {
          permanentAttempts += 1;
          throw Object.assign(new Error('Upstash HTTP 400'), { status: 400 });
        },
        async () => { throw new Error('permanent failures must not delay'); },
      ),
      /Upstash HTTP 400/,
    );
    assert.equal(permanentAttempts, 1);
  });

  it('builds one transition-only divergence snapshot and a fail-closed composite', () => {
    const payload = buildPhysicalPremiumPayload({
      goldRows: parseSgeBenchmarkHtml(goldHtml, { contract: 'SHAU', unit: 'gram' }),
      silverRows: parseSgeBenchmarkHtml(silverHtml, { contract: 'SHAG', unit: 'kilogram' }),
      commodityQuotes: {
        quotes: [{ symbol: 'GC=F', price: 4300 }, { symbol: 'SI=F', price: 70 }],
      },
      fxRates: { CNY: 0.1486, fallbackCurrencies: [] },
      computedAt: '2026-08-18T12:30:00.000Z',
    });
    const histories = Object.fromEntries(payload.premiums.map((premium) => [
      premium.metal,
      Array.from({ length: 60 }, (_, index) => ({
        date: new Date(Date.parse('2026-08-18T00:00:00.000Z') - index * 86_400_000).toISOString().slice(0, 10),
        premiumPct: index === 0 ? premium.premiumPct : 0,
        premiumUsdPerOz: index === 0 ? premium.premiumUsdPerOz : 0,
        physicalAsOf: new Date(Date.parse('2026-08-18T00:00:00.000Z') - index * 86_400_000).toISOString().slice(0, 10),
        paperAsOf: new Date(Date.parse('2026-08-18T12:30:00.000Z') - index * 86_400_000).toISOString(),
        methodologyVersion: METHODOLOGY_VERSION,
      })),
    ]));
    const previousSnapshot = {
      readings: payload.premiums.map((premium) => ({
        metal: premium.metal,
        state: 'ok',
        regime: 'normal',
      })),
    };
    const snapshot = buildPhysicalDivergenceSnapshot({
      premiums: payload.premiums,
      fx: payload.fx,
      histories,
      previousSnapshot,
      cooldowns: {},
      nowMs: Date.parse('2026-08-18T12:30:00.000Z'),
    });

    assert.equal(PHYSICAL_DIVERGENCE_KEY, 'market:physical-divergence:v1');
    assert.equal(snapshot.readings.length, 2);
    assert.equal(snapshot.composite.state, 'ok');
    // Pin the count before the predicate: `every` is true on an empty array, so asserting
    // only the predicate would stay green if this stopped emitting transitions altogether —
    // which is this test's stated subject.
    assert.ok(snapshot.transitions.length > 0);
    assert.ok(snapshot.transitions.every((transition) => transition.fromRegime === 'normal'));
    assert.equal(snapshot.methodologyVersion, METHODOLOGY_VERSION);
    assert.deepEqual(snapshot.readings[0].provenance, {
      physicalSource: 'Shanghai Gold Exchange SHAU PM benchmark',
      physicalSymbol: 'SHAU',
      physicalAsOf: '2026-08-18',
      paperSource: 'COMEX GC=F futures snapshot',
      paperSymbol: 'GC=F',
      paperAsOf: '2026-08-18T12:30:00.000Z',
      fxSource: 'shared:fx-rates:v1',
      fxPair: 'CNY/USD',
      fxAsOf: '2026-08-18T12:30:00.000Z',
      historyKey: 'market:physical-premium-history:v1:gold',
      historyWindowPoints: TRAILING_WINDOW_POINTS,
      methodologyVersion: METHODOLOGY_VERSION,
    });
  });
});
