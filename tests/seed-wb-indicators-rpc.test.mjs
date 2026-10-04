import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const seeder = fileURLToPath(new URL('../scripts/seed-wb-indicators.mjs', import.meta.url));
const prefix = 'economic:worldbank:v2:';
const bootstrapKey = 'economic:worldbank-techreadiness:v1';
const gdpKey = `${prefix}NY.GDP.MKTP.CD:all:30:2026`;
const retained = { data: [{ countryCode: 'USA', countryName: 'United States', indicatorCode: 'NY.GDP.MKTP.CD', indicatorName: 'GDP', year: 2023, value: 7 }] };
const fetchedAt = Date.parse('2026-10-03T12:00:00Z');

const preload = `
import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.env.WB_FIXTURE_CONFIG, 'utf8'));
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [config.now])); }
  static now() { return config.now; }
};
const cache = new Map(Object.entries(config.cache));
const commands = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === 'wb-redis.invalid') {
    const batch = JSON.parse(init.body);
    commands.push(...batch);
    return Response.json(batch.map(command => {
      if (command[0] === 'GET') return { result: cache.get(command[1]) ?? null };
      if (command[0] === 'SET') { cache.set(command[1], command[2]); return { result: 'OK' }; }
      if (command[0] === 'EXPIRE') return { result: cache.has(command[1]) ? 1 : 0 };
      throw new Error('Unexpected Redis command ' + command[0]);
    }));
  }
  if (url.hostname !== 'api.worldbank.org') throw new Error('Unexpected network host ' + url.hostname);
  const indicator = url.pathname.split('/').at(-1);
  if (config.failGdp && indicator === 'NY.GDP.MKTP.CD') return Response.json([{ message: 'Provider unavailable' }]);
  const [start, end] = url.searchParams.get('date').split(':').map(Number);
  const rows = [2000, 2024, 2025].filter(year => year >= start && year <= end).flatMap(year =>
    [['USA', 'US'], ['CHI', 'JG']].map(([iso3, iso2]) => ({
      countryiso3code: iso3, country: { id: iso2, value: iso3 },
      indicator: { value: indicator }, date: String(year), value: 42,
    })));
  return Response.json([{ pages: 1, total: rows.length }, rows]);
};
process.on('exit', () => writeFileSync(process.env.WB_FIXTURE_RESULT, JSON.stringify({ cache: Object.fromEntries(cache), commands })));
`;

function runSeed({ cache = {}, failGdp = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-rpc-seed-'));
  try {
    const importPath = join(dir, 'fetch.mjs');
    const config = join(dir, 'config.json');
    const resultPath = join(dir, 'result.json');
    writeFileSync(importPath, preload);
    writeFileSync(config, JSON.stringify({ now: fetchedAt, cache, failGdp }));
    const child = spawnSync(process.execPath, ['--import', importPath, seeder], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        UPSTASH_REDIS_REST_URL: 'https://wb-redis.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'synthetic',
        WB_FIXTURE_CONFIG: config,
        WB_FIXTURE_RESULT: resultPath,
      },
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(child.error, undefined);
    return { ...JSON.parse(readFileSync(resultPath, 'utf8')), status: child.status, log: child.stdout + child.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('RPC history covers the full lookback while ranking observations keep their original window', () => {
  const run = runSeed();
  assert.equal(run.status, 0, run.log);
  for (const indicator of ['IT.NET.USER.ZS', 'IT.CEL.SETS.P2', 'IT.NET.BBND.P2', 'GB.XPD.RSDV.GD.ZS']) {
    const rows = JSON.parse(run.cache[`${prefix}${indicator}:all:30:2026`]).data;
    assert.deepEqual(rows.filter(row => row.countryCode === 'USA').map(row => row.year), [2000, 2024, 2025]);
  }
  const ranking = JSON.parse(run.cache[bootstrapKey]).find(row => row.country === 'USA');
  assert.equal(ranking.observations.internet.year, 2024);
  const channelIslands = JSON.parse(run.cache[gdpKey]).data.find(row => row.countryCode === 'CHI');
  assert.equal(channelIslands.countryIso2, 'JG');
  for (const [key, value] of Object.entries(run.cache).filter(([key]) => key.startsWith(prefix))) {
    const meta = JSON.parse(run.cache[`seed-meta:${key}`]);
    assert.equal(meta.fetchedAt, fetchedAt);
    assert.equal(meta.recordCount, JSON.parse(value).data.length);
  }
});

test('ranking drop preservation still publishes the first RPC snapshots', () => {
  const oldRankings = JSON.stringify([{ country: 'PREVIOUS' }]);
  const run = runSeed({ cache: {
    [bootstrapKey]: oldRankings,
    [`seed-meta:${bootstrapKey}`]: JSON.stringify({ fetchedAt: 1, recordCount: 100 }),
  } });
  assert.equal(run.status, 0, run.log);
  assert.equal(run.cache[bootstrapKey], oldRankings);
  assert.equal(JSON.parse(run.cache[gdpKey]).data.length, 6);
  assert.ok(run.cache[`seed-meta:${gdpKey}`]);
});

test('a missing catalogue snapshot makes the seeder fail instead of verifying one healthy sample', () => {
  const run = runSeed({ failGdp: true });
  assert.equal(run.status, 1, run.log);
  assert.match(run.log, /NY\.GDP\.MKTP\.CD/);
  assert.equal(run.cache[gdpKey], undefined);
  assert.ok(run.cache[`${prefix}IT.NET.USER.ZS:all:30:2026`]);
});

test('a malformed retained snapshot cannot satisfy catalogue coverage', () => {
  const run = runSeed({ failGdp: true, cache: { [gdpKey]: JSON.stringify({ data: [{}] }) } });
  assert.equal(run.status, 1, run.log);
  assert.match(run.log, /RPC snapshots missing for NY\.GDP\.MKTP\.CD/);
});

for (const year of [2026, 2025]) {
  test(`provider failure retains a usable ${year} snapshot without advancing its metadata`, () => {
    const key = `${prefix}NY.GDP.MKTP.CD:all:30:${year}`;
    const oldMeta = JSON.stringify({ fetchedAt: 123, recordCount: 1 });
    const run = runSeed({ failGdp: true, cache: {
      [key]: JSON.stringify(retained), [`seed-meta:${key}`]: oldMeta,
    } });
    assert.equal(run.status, 0, run.log);
    assert.deepEqual(JSON.parse(run.cache[key]), retained);
    assert.equal(run.cache[`seed-meta:${key}`], oldMeta);
    assert.equal(run.commands.some(command => command[0] === 'SET' && command[1] === key), false);
  });
}
