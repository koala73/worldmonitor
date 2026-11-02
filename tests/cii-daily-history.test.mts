import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { persistCiiDailyHistory } from '../server/worldmonitor/intelligence/v1/get-risk-scores';
import { CII_COUNTRY_CODES } from '../shared/cii-weights';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config';
import { buildCiiHistory, buildCiiMovers, parseCiiDailyPoints } from '../shared/cii-daily-history';
import { readCiiMovers, readCountryCiiHistory } from '../api/mcp/_cii-history';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 18, 12);
const compact = (offset = 0, score = 40, version = CII_FORMULA_VERSION) => ({
  d: new Date(now + offset * DAY).toISOString().slice(0, 10), v: version,
  s: score, u: 1, c: 2, m: 3, n: 4, t: now + offset * DAY,
});
const points = (...rows: ReturnType<typeof compact>[]) => parseCiiDailyPoints(rows.map(row => JSON.stringify(row)), now).points;

test('country history preserves gaps, actual change dates and methodology breaks', () => {
  const history = buildCiiHistory(points(compact(-29, 10, 'v7'), compact(-20, 20), compact(-2, 30), compact(0, 40)), 30, CII_FORMULA_VERSION, now);
  assert.equal(history.returnedDays, 3);
  assert.deepEqual(history.points.map(p => p.date), ['2026-09-28', '2026-10-16', '2026-10-18']);
  assert.deepEqual(history.change, { fromDate: '2026-09-28', fromScore: 20, toDate: '2026-10-18', toScore: 40, delta: 20 });
  assert.deepEqual(history.versionBreaks, [{ date: '2026-09-28', from: 'v7', to: CII_FORMULA_VERSION }]);
  assert.deepEqual(history.points[0]?.components, { ciiContribution: 1, geoConvergence: 2, militaryActivity: 3, newsActivity: 4 });
  assert.equal(history.stale, false);
  assert.equal(buildCiiHistory(points(compact(-1)), 1, CII_FORMULA_VERSION, now).stale, true);
  assert.equal(buildCiiHistory(points(compact(0)), 7, CII_FORMULA_VERSION, now).change, null);
  assert.equal(buildCiiHistory([], 30, CII_FORMULA_VERSION, now).stale, true);
});

test('history rejects corrupt, future and inconsistent dates and ages the source clock', () => {
  const parsed = parseCiiDailyPoints([JSON.stringify(compact()), '{', JSON.stringify(compact(1)), JSON.stringify({ ...compact(), d: '2026-02-30' }), JSON.stringify({ ...compact(), s: null })], now);
  assert.equal(parsed.points.length, 1);
  assert.equal(parsed.invalid, true);
  assert.equal(buildCiiHistory(parsed.points, 7, CII_FORMULA_VERSION, now + 31 * 60_000).stale, true);
});

test('movers rank both directions, exclude the deadband and require a comparable start', () => {
  const endpoints = new Map([
    ['IR', points(compact(-31, 20), compact(0, 40))],
    ['US', points(compact(-30, 30), compact(0, 10))],
    ['GB', points(compact(-30, 20), compact(0, 21))],
    ['FR', points(compact(-30, 20), compact(0, 19))],
    ['DE', points(compact(-29, 10), compact(0, 40))],
    ['CN', points(compact(-30, 10, 'v7'), compact(0, 40))],
    ['RU', []],
  ]);
  const movers = buildCiiMovers(endpoints, 30, CII_FORMULA_VERSION, now);
  assert.deepEqual(movers.risers, [{ countryCode: 'IR', fromDate: '2026-09-17', from: 20, to: 40, delta: 20 }]);
  assert.deepEqual(movers.fallers, [{ countryCode: 'US', fromDate: '2026-09-18', from: 30, to: 10, delta: -20 }]);
  assert.deepEqual(movers.insufficient_history, ['CN', 'DE', 'RU']);
  const many = new Map(Array.from({ length: 10 }, (_, i) => [String(i), points(compact(-7, 10), compact(0, 20 + i))]));
  assert.equal(buildCiiMovers(many, 7, CII_FORMULA_VERSION, now).risers.length, 5);
});

const cli = process.env.REDIS_CLI_BIN || 'redis-cli';
const server = process.env.REDIS_SERVER_BIN || 'redis-server';
const enabled = spawnSync(cli, ['--version']).status === 0 && spawnSync(server, ['--version']).status === 0;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let socket: string;
const command = (...args: Array<string | number>) => {
  const result = spawnSync(cli, ['-s', socket, '--json', ...args.map(String)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
before(() => {
  if (!enabled) return;
  const dir = mkdtempSync(join(tmpdir(), 'cii-redis-'));
  socket = join(dir, 'redis.sock');
  const started = spawnSync(server, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--daemonize', 'yes', '--pidfile', join(dir, 'pid'), '--logfile', join(dir, 'log')]);
  assert.equal(started.status, 0);
  for (let i = 0; i < 100; i++) {
    const ping = spawnSync(cli, ['-s', socket, '--raw', 'PING'], { encoding: 'utf8' });
    if (ping.stdout.trim() === 'PONG') break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
});
after(() => {
  if (socket) spawnSync(cli, ['-s', socket, 'SHUTDOWN', 'NOSAVE']);
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
});

test('fresh writer replaces daily closes atomically, trims 365 days, retains versions and stamps confirmed health', { skip: !enabled && 'redis-server and redis-cli required' }, async () => {
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: 'https://upstash.test', UPSTASH_REDIS_REST_TOKEN: 'fixture', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'cii-history-test' });
  delete process.env.LOCAL_API_MODE;
  const pipelines: unknown[][][] = [];
  globalThis.fetch = (async (_input, init) => {
    const commands = JSON.parse(String(init?.body));
    pipelines.push(commands);
    return Response.json(commands.map((cmd: Array<string | number>) => ({ result: command(...cmd) })));
  }) as typeof fetch;
  const response = (timestamp: number, score = 40, version = CII_FORMULA_VERSION) => ({
    ciiScores: CII_COUNTRY_CODES.map(region => ({ region, combinedScore: score, components: { ciiContribution: 1, geoConvergence: 2, militaryActivity: 3, newsActivity: 4 }, computedAt: timestamp, methodologyVersion: version })),
    strategicRisks: [], degraded: false, stale: false,
  });
  const write = (timestamp: number, score?: number, version?: string) => persistCiiDailyHistory(response(timestamp, score, version) as never);
  await write(now - 365 * DAY, 10, 'v7');
  await write(now - 364 * DAY, 15, 'v7');
  await write(now - 7 * DAY, 20);
  await write(now, 40);
  const evalCommand = pipelines.at(-1)![0]!;
  const keys = evalCommand.slice(3, 3 + Number(evalCommand[2])) as string[];
  const key = keys.find(k => k.endsWith(':IR'))!;
  assert.ok(key.includes('preview:cii-hist'));
  assert.equal(command('ZCARD', key), 3);
  const ttl = command('TTL', key);
  assert.ok(ttl >= 400 * 86400 - 2 && ttl <= 400 * 86400);
  await write(now + 1000, 50);
  await write(now + 500, 30);
  const stored = command('ZRANGE', key, 0, -1).map((row: string) => JSON.parse(row));
  assert.equal(stored.length, 3);
  assert.equal(stored[0].v, 'v7');
  assert.equal(stored[2].s, 50);
  assert.equal(stored[2].v, CII_FORMULA_VERSION);
  assert.equal(stored[2].d, '2026-10-18');
  const index = keys.find(k => k.endsWith(':history:index'))!;
  const meta = keys.find(k => k.endsWith('seed-meta:intelligence:risk-scores-history'))!;
  const activation = keys.find(k => k.endsWith('seed-activated:intelligence:risk-scores-history'));
  assert.ok(activation, 'first confirmed daily publication activates strict health');
  assert.equal(command('GET', activation), String(now + 1000));
  assert.equal(command('TTL', activation), -1, 'activation survives data and metadata expiry');
  assert.deepEqual(JSON.parse(command('GET', meta)), { fetchedAt: now + 1000, recordCount: 31 });
  assert.equal(JSON.parse(command('GET', index)).countries.length, 31);
  const { history } = await readCountryCiiHistory('IR', 30, CII_FORMULA_VERSION, now + 1000);
  assert.equal(history.returnedDays, 2);
  assert.equal(history.change?.delta, 30);
  const ranked = await readCiiMovers(7, now + 1000);
  assert.equal(ranked.available, true);
  assert.equal(ranked.movers.risers.length, 5);
  assert.deepEqual(ranked.movers.insufficient_history, []);
  assert.equal(ranked.movers.risers[0]?.delta, 30);
  const count = pipelines.length;
  await persistCiiDailyHistory({ ...response(now + 2000), stale: true } as never);
  await persistCiiDailyHistory({ ...response(now + 2000), degraded: true } as never);
  assert.equal(pipelines.length, count);
  const previousMeta = command('GET', meta);
  command('SET', key, 'wrong-type');
  await write(now + 2000, 60);
  assert.equal(command('GET', meta), previousMeta, 'a failed country write cannot advance the heartbeat');
  const us = keys.find(k => k.endsWith(':US'))!;
  assert.equal(JSON.parse(command('ZRANGE', us, -1, -1)[0]).s, 50, 'type preflight prevents a partial country publish');
});
