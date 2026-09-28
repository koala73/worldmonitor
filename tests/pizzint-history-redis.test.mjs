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
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const ping = spawnSync(cli, ['-s', socket, '--raw', 'PING'], { encoding: 'utf8' });
    if (ping.status === 0 && ping.stdout.trim() === 'PONG') { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  const command = (...args) => {
    const result = spawnSync(cli, ['-s', socket, '--raw', ...args.map(String)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    assert.ok(ready, 'Redis did not become ready within five seconds');
    const captured = new Date(Math.floor(Date.now() / 600000) * 600000);
    const input = (offset, live, placeId = 'venue') => history.buildPizzintHistoryWrite({ provider: 'besttime', capturedAt: new Date(+captured + offset).toISOString(), locations: [{ placeId, currentPopularity: live, forecastPopularity: 20, dataFreshness: 'DATA_FRESHNESS_FRESH', isClosedNow: false }] });
    const evalWrite = (write, cap = 4000) => command('EVAL', history.WRITE_LUA, write.keys.length, ...write.keys, ...write.records.flatMap(({ field, capturedMs, value }) => [field, capturedMs, value]), write.expireAt, write.metaExpireAt, cap);
    const first = input(1000, 10);
    assert.equal(evalWrite(first), '1\n0\n0\n1');
    assert.equal(evalWrite(first), '0\n0\n1\n1');
    assert.equal(evalWrite(input(2000, 30)), '0\n1\n0\n1');
    assert.equal(evalWrite(first), '0\n0\n1\n1');
    assert.equal(history.decodePizzintHistoryRecord(command('HGET', first.keys[0], first.records[0].field)).live, 30);
    const expectedTtl = first.expireAt - Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(Number(command('TTL', first.keys[0])) - expectedTtl) <= 1);
    const metadata = command('GET', first.keys[1]);
    assert.deepEqual(JSON.parse(metadata), { fetchedAt: +captured + 2000, recordCount: 1 });
    // The meta key must OUTLIVE its data key so health reports STALE_SEED rather
    // than losing the heartbeat and the payload in the same instant.
    const metaTtl = Number(command('TTL', first.keys[1]));
    assert.ok(Math.abs(metaTtl - (first.metaExpireAt - Math.floor(Date.now() / 1000))) <= 1);
    assert.ok(metaTtl > expectedTtl, `meta TTL ${metaTtl} must exceed data TTL ${expectedTtl}`);
    const capped = input(3000, 90);
    capped.records.push(...input(3000, 70, 'other').records);
    assert.match(evalWrite(capped, 1), /history_bucket_cap/);
    assert.equal(command('HLEN', first.keys[0]), '1');
    assert.equal(command('GET', first.keys[1]), metadata);
    assert.equal(history.decodePizzintHistoryRecord(command('HGET', first.keys[0], first.records[0].field)).live, 30);

    // A SUCCESSFUL multi-record write is what pins the stride-3 ARGV walk and the
    // trailing expireAt/metaExpireAt/cap arguments. With one record per write an
    // off-by-one in the loop bound still yields a plausible result tuple, so
    // without this the layout is effectively unverified.
    const multi = history.buildPizzintHistoryWrite({
      provider: 'besttime', capturedAt: new Date(+captured + 4000).toISOString(),
      locations: ['m1', 'm2', 'm3'].map((placeId, index) => ({
        placeId, currentPopularity: 10 + index, forecastPopularity: 20,
        dataFreshness: 'DATA_FRESHNESS_FRESH', isClosedNow: false,
      })),
    });
    assert.equal(multi.records.length, 3);
    assert.equal(evalWrite(multi), '3\n0\n0\n4');
    for (const [index, record] of multi.records.entries()) {
      assert.equal(history.decodePizzintHistoryRecord(command('HGET', multi.keys[0], record.field)).live, 10 + index);
    }
    assert.deepEqual(JSON.parse(command('GET', multi.keys[1])), { fetchedAt: +captured + 4000, recordCount: 4 });

    // The provider-agnostic heartbeat is what api/health.js can actually watch:
    // one stable key, advanced by whichever provider wrote, on a rolling TTL.
    assert.equal(multi.keys[2], history.HEARTBEAT_KEY);
    assert.deepEqual(JSON.parse(command('GET', history.HEARTBEAT_KEY)), { fetchedAt: +captured + 4000, recordCount: 4 });
    const beatTtl = Number(command('TTL', history.HEARTBEAT_KEY));
    assert.ok(beatTtl > 0 && beatTtl <= history.HEARTBEAT_TTL_SECONDS, `heartbeat TTL ${beatTtl}`);

    // The durable activation marker is what expires api/health.js's EMPTY grace.
    assert.equal(multi.keys[3], history.ACTIVATION_KEY);
    assert.equal(command('GET', history.ACTIVATION_KEY), '1');
    assert.equal(command('TTL', history.ACTIVATION_KEY), '-1', 'the marker must be durable');

    // A later write from the OTHER provider must advance the same heartbeat, and
    // an out-of-order one must not rewind it -- that is the whole point of the
    // key: it tracks archive liveness across a provider switch.
    const fallback = history.buildPizzintHistoryWrite({
      provider: 'pizzint', capturedAt: new Date(+captured + 9000).toISOString(),
      locations: [{
        placeId: 'venue', currentPopularity: 11, forecastPopularity: 20,
        dataFreshness: 'DATA_FRESHNESS_FRESH', isClosedNow: false,
        recordedAt: new Date(+captured + 9000).toISOString(),
      }],
    });
    evalWrite(fallback);
    assert.equal(JSON.parse(command('GET', history.HEARTBEAT_KEY)).fetchedAt, +captured + 9000);
    evalWrite(multi);
    assert.equal(
      JSON.parse(command('GET', history.HEARTBEAT_KEY)).fetchedAt, +captured + 9000,
      'the heartbeat clock must never regress',
    );
  } finally {
    command('SHUTDOWN', 'NOSAVE');
  }
});
