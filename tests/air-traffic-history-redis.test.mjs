import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const history = require('../scripts/shared/air-traffic-history.cjs');

const cli = process.env.REDIS_CLI_BIN || 'redis-cli';
const server = process.env.REDIS_SERVER_BIN || 'redis-server';
const enabled = spawnSync(cli, ['--version']).status === 0 && spawnSync(server, ['--version']).status === 0;

const T = Date.UTC(2026, 10, 13, 23, 55, 0);
const okPoint = (t, n = 100) => ({ t, status: 'ok', usSeen: n, usAirborne: n - 10, usLowClimbing: 7, euAirborne: 50, hubs: { ATL: { air: 3, ground: 9 } }, statesTotal: 400 });
const gapPoint = (t) => ({ t, status: 'gap' });

test('the write plan targets one hash per UTC day with EXPIREAT at day end plus 35 days', () => {
  const plan = history.buildTrafficPointWrite(okPoint(T));
  assert.equal(plan.key, 'aviation:traffic:history:v1:2026-11-13');
  assert.equal(plan.expireAt, Math.floor(Date.UTC(2026, 10, 14) / 1000) + 35 * 86400);
  const next = history.buildTrafficPointWrite(okPoint(T + 600_000));
  assert.equal(next.key, 'aviation:traffic:history:v1:2026-11-14');
});

test('a gap point stores only its bin and status', () => {
  const plan = history.buildTrafficPointWrite(gapPoint(T));
  const hset = plan.commands.find(c => c[1] === plan.key);
  assert.equal(hset[0], 'HSETNX');
  assert.deepEqual(JSON.parse(hset[3]), { t: T, status: 'gap' });
  assert.ok(!plan.commands.some(c => c[1] === history.HEARTBEAT_KEY), 'a gap never advances the heartbeat');
});

test('a point that is neither ok nor gap is rejected', () => {
  assert.throws(() => history.buildTrafficPointWrite({ t: T, status: 'ok', usSeen: -1 }), /invalid traffic point/);
  assert.throws(() => history.buildTrafficPointWrite({ t: T + 1, status: 'gap' }), /invalid traffic point/);
});

test('real Redis keeps one point per bin, upgrades a gap, never downgrades an ok point, and sets expiry', { skip: !enabled && 'redis-server and redis-cli required' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-traffic-redis-'));
  const socket = join(dir, 'redis.sock');
  const started = spawnSync(server, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--daemonize', 'yes', '--pidfile', join(dir, 'pid'), '--logfile', join(dir, 'log')], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const command = (...args) => {
    const result = spawnSync(cli, ['-s', socket, '--raw', ...args.map(String)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    for (let i = 0; i < 50 && spawnSync(cli, ['-s', socket, 'PING']).status !== 0; i++) await new Promise(r => setTimeout(r, 50));
    const pipeline = async (commands) => commands.map(c => ({ result: command(...c) }));
    const key = history.buildTrafficPointWrite(okPoint(T)).key;

    await history.recordTrafficPoint(gapPoint(T), pipeline);
    assert.equal(JSON.parse(command('HGET', key, T)).status, 'gap');
    assert.equal(command('EXISTS', history.HEARTBEAT_KEY), '0');

    await history.recordTrafficPoint(okPoint(T), pipeline);
    assert.equal(JSON.parse(command('HGET', key, T)).status, 'ok', 'an ok point replaces a gap');

    await history.recordTrafficPoint(okPoint(T, 120), pipeline, T + 42_000);
    assert.equal(JSON.parse(command('HGET', key, T)).usSeen, 120, 'a rewrite of the same bin replaces it');
    assert.equal(command('HLEN', key), '1');

    await history.recordTrafficPoint(gapPoint(T), pipeline);
    assert.equal(JSON.parse(command('HGET', key, T)).status, 'ok', 'a gap never overwrites an ok point');

    assert.equal(Number(command('EXPIRETIME', key)), history.buildTrafficPointWrite(okPoint(T)).expireAt);
    const meta = JSON.parse(command('GET', history.HEARTBEAT_KEY));
    assert.deepEqual(meta, { fetchedAt: T + 42_000, recordCount: 400 }, 'the heartbeat is the fetch time, not the bin start');
    assert.ok(Number(command('TTL', history.HEARTBEAT_KEY)) > 86400);
    assert.equal(command('GET', history.ACTIVATION_KEY), '1');
    assert.equal(command('TTL', history.ACTIVATION_KEY), '-1');
  } finally {
    spawnSync(cli, ['-s', socket, 'SHUTDOWN', 'NOSAVE']);
    rmSync(dir, { recursive: true, force: true });
  }
});
