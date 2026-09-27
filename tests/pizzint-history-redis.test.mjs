import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import history from '../scripts/shared/pizzint-history.cjs';

const cli = process.env.REDIS_CLI_BIN || 'redis-cli';
const server = process.env.REDIS_SERVER_BIN || 'redis-server';
const enabled = spawnSync(cli, ['--version']).status === 0 && spawnSync(server, ['--version']).status === 0;

test('real Redis preserves newest slots, fixed expiry, and all-or-nothing cap rejection', { skip: !enabled && 'redis-server and redis-cli required' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pizzint-redis-'));
  const socket = join(dir, 'redis.sock');
  const started = spawnSync(server, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--daemonize', 'yes', '--pidfile', join(dir, 'pid'), '--logfile', join(dir, 'log')], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const command = (...args) => {
    const result = spawnSync(cli, ['-s', socket, '--raw', ...args.map(String)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    const captured = new Date(Math.floor(Date.now() / 600000) * 600000);
    const input = (offset, live, placeId = 'venue') => history.buildPizzintHistoryWrite({ provider: 'besttime', capturedAt: new Date(+captured + offset).toISOString(), locations: [{ placeId, currentPopularity: live, forecastPopularity: 20, dataFreshness: 'DATA_FRESHNESS_FRESH', isClosedNow: false }] });
    const evalWrite = (write, cap = 4000) => command('EVAL', history.WRITE_LUA, '1', write.keys[0], ...write.records.flatMap(({ field, capturedMs, value }) => [field, capturedMs, value]), write.expireAt, cap);
    const first = input(1000, 10);
    assert.equal(evalWrite(first), '1\n0\n0\n1');
    assert.equal(evalWrite(first), '0\n0\n1\n1');
    assert.equal(evalWrite(input(2000, 30)), '0\n1\n0\n1');
    assert.equal(evalWrite(first), '0\n0\n1\n1');
    assert.equal(history.decodePizzintHistoryRecord(command('HGET', first.keys[0], first.records[0].field)).live, 30);
    assert.equal(Number(command('EXPIRETIME', first.keys[0])), first.expireAt);
    const capped = input(3000, 90);
    capped.records.push(...input(3000, 70, 'other').records);
    assert.match(evalWrite(capped, 1), /history_bucket_cap/);
    assert.equal(command('HLEN', first.keys[0]), '1');
    assert.equal(history.decodePizzintHistoryRecord(command('HGET', first.keys[0], first.records[0].field)).live, 30);
  } finally {
    command('SHUTDOWN', 'NOSAVE');
  }
});
