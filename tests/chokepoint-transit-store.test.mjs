import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDurableTransitTracker } from '../shared/chokepoint-transit-store.js';
import { createTransitTracker } from '../shared/chokepoint-transit-tracker.js';
import { readTransitWindow } from '../shared/chokepoint-transit-window.js';

const HOUR = 3600000;
const at = 1792800000000;
const name = 'Strait of Hormuz';
const gates = { [name]: { a: [[26.45, 55.95, 0.25]], b: [[26.2, 56.85, 0.3]] } };
const make = evaluate => createDurableTransitTracker({ gates, maxTransitMs: 18 * HOUR, cooldownMs: HOUR / 2, evaluate });
const observe = (tracker, side, ts, id = '123456789') => tracker.observe(id, ...gates[name][side][0].slice(0, 2), 'tanker', ts);
const cli = process.env.REDIS_CLI_BIN || 'redis-cli';
const server = process.env.REDIS_SERVER_BIN || 'redis-server';
const enabled = spawnSync(cli, ['--version']).status === 0 && spawnSync(server, ['--version']).status === 0;

test('real Redis continues gates across restarts without renewing crossing clocks', { skip: !enabled && 'redis-server and redis-cli required' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'transit-gates-'));
  const socket = join(dir, 'redis.sock');
  const started = spawnSync(server, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--daemonize', 'yes', '--pidfile', join(dir, 'pid'), '--logfile', join(dir, 'log')], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const command = (...args) => {
    const result = spawnSync(cli, ['-s', socket, '--json', ...args.map(String)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnSync(cli, ['-s', socket, 'PING']).status === 0) { ready = true; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(ready);
    const evaluate = async (script, keys, args) => command('EVAL', script, keys.length, ...keys, ...args);
    const window = now => readTransitWindow(new Map(), now, evaluate);
    await t.test('pairs the first gate even when another relay committed the second gate first', async () => {
      command('FLUSHDB');
      const first = make(evaluate);
      const second = make(evaluate);
      observe(first, 'a', at);
      observe(second, 'b', at + HOUR);
      await second.flush(at + HOUR);
      await first.flush(at + HOUR + 1);
      assert.deepEqual((await window(at + HOUR + 1)).get(name), [{ mmsi: '123456789', type: 'tanker', ts: at + HOUR }]);
    });
    await t.test('recovery pairs buffered reports by their gap, not their age at flush', async () => {
      command('FLUSHDB');
      let fail = true;
      const tracker = make(async (...args) => fail ? null : evaluate(...args));
      observe(tracker, 'a', at);
      await assert.rejects(tracker.flush(at), /gate update failed/);
      observe(tracker, 'b', at + 17 * HOUR);
      await assert.rejects(tracker.flush(at + 18 * HOUR + 1), /gate update failed/);
      fail = false;
      await tracker.flush(at + 18 * HOUR + 2);
      assert.deepEqual((await window(at + 18 * HOUR + 2)).get(name), [{ mmsi: '123456789', type: 'tanker', ts: at + 17 * HOUR }]);
    });
    await t.test('late observations correct completion clocks without keeping superseded events', async () => {
      command('FLUSHDB');
      const tracker = make(evaluate);
      observe(tracker, 'a', at);
      observe(tracker, 'b', at + 2 * HOUR);
      await tracker.flush(at + 2 * HOUR);
      const delayed = make(evaluate);
      observe(delayed, 'b', at + HOUR);
      await delayed.flush(at + 2 * HOUR + 1);
      assert.deepEqual((await window(at + 2 * HOUR + 1)).get(name), [{ mmsi: '123456789', type: 'tanker', ts: at + HOUR }]);
    });
    await t.test('trimming journal history preserves the continuous tracker cooldown phase', async () => {
      command('FLUSHDB');
      const crossings = new Map();
      const continuous = createTransitTracker({ gates, maxTransitMs: 18 * HOUR, cooldownMs: HOUR / 2, crossings });
      const durable = make(evaluate);
      for (let i = 0; i <= 240; i++) {
        const ts = at + i * HOUR / 3;
        const side = i % 2 ? 'b' : 'a';
        observe(continuous, side, ts);
        observe(durable, side, ts);
        if (i % 3 === 0) await durable.flush(ts);
      }
      const now = at + 80 * HOUR;
      const expected = crossings.get(name).filter(row => row.ts > now - 24 * HOUR)
        .map(({ mmsi, type, ts }) => ({ mmsi, type, ts }));
      assert.deepEqual((await window(now)).get(name), expected);
    });
    await t.test('one overflowing vessel does not block another chokepoint', async () => {
      command('FLUSHDB');
      const tracker = createDurableTransitTracker({
        gates: { ...gates, Other: { a: [[1, 1, 0.1]], b: [[2, 2, 0.1]] } },
        maxTransitMs: 18 * HOUR, cooldownMs: HOUR / 2,
        evaluate: (script, keys, args) => { args[6] = 2; return evaluate(script, keys, args); },
      });
      for (let i = 0; i < 3; i++) observe(tracker, 'a', at + i);
      tracker.observe('other-vessel', 1, 1, 'cargo', at);
      tracker.observe('other-vessel', 2, 2, 'cargo', at + 1000);
      const unavailable = await tracker.flush(at + 1000);
      assert.ok(unavailable.has(name));
      assert.ok(!unavailable.has('Other'));
      assert.equal((await window(at + 1000)).get('Other').length, 1);
    });
    await t.test('late input eviction accounts for newer reports removed from the same journal', async () => {
      command('FLUSHDB');
      const capped = make((script, keys, args) => { args[6] = 2; return evaluate(script, keys, args); });
      observe(capped, 'a', at + HOUR);
      observe(capped, 'a', at + 2 * HOUR);
      await capped.flush(at + 2 * HOUR);
      observe(capped, 'a', at);
      assert.ok((await capped.flush(at + 2 * HOUR)).has(name));
      assert.ok((await make(evaluate).flush(at + 43 * HOUR)).has(name));
      assert.equal((await make(evaluate).flush(at + 44.5 * HOUR)).size, 0);
    });
    await t.test('storage caps mark the affected waterway unavailable across restarts with a fixed source deadline', async () => {
      for (const [argument, limit] of [[5, 1], [6, 1], [7, 1]]) {
        command('FLUSHDB');
        const capped = make((script, keys, args) => {
          args[argument] = limit;
          return evaluate(script, keys, args);
        });
        observe(capped, 'a', at);
        await capped.flush(at);
        observe(capped, 'b', at + 1000, argument === 6 ? '123456789' : '987654321');
        assert.ok((await capped.flush(at + 1000)).has(name));
        assert.equal(command('HGET', 'supply_chain:transit-gates:v1', '_rows'), argument === 6 ? '0' : '1');
        assert.equal(command('ZCARD', 'supply_chain:transit-gate-times:v1'), argument === 6 ? 0 : 1);
        const restarted = make(evaluate);
        assert.ok((await restarted.flush(at + HOUR)).has(name));
        assert.equal(JSON.parse(command('HGET', 'supply_chain:transit-gates:v1', '_incomplete'))[name], at + 1000 + 42.5 * HOUR);
        assert.equal((await restarted.flush(at + 1000 + 42.5 * HOUR)).size, 0);
      }
    });
    await t.test('buffer loss is durable even when all accepted reports are saved', async () => {
      command('FLUSHDB');
      const tracker = make(evaluate);
      // Duplicate reports exercise the pending cap without exhausting the journal.
      for (let i = 0; i <= 20000; i++) observe(tracker, 'a', at);
      assert.ok((await tracker.flush(at)).has(name));
      assert.equal(command('HGET', 'supply_chain:transit-gates:v1', '_rows'), '1');
      assert.ok((await make(evaluate).flush(at + HOUR)).has(name));
      assert.equal((await make(evaluate).flush(at + 42.5 * HOUR)).size, 0);
    });
    command('FLUSHDB');
    let tracker = make(evaluate);
    observe(tracker, 'a', at);
    await tracker.flush(at);
    assert.equal((await window(at)).size, 0);
    tracker = make(evaluate);
    observe(tracker, 'b', at + 4 * HOUR);
    observe(tracker, 'b', at + 4 * HOUR + 1000);
    observe(tracker, 'b', at + 4 * HOUR + 2000);
    await tracker.flush(at + 4 * HOUR + 2000);
    assert.deepEqual((await window(at + 4 * HOUR + 2000)).get(name), [{ mmsi: '123456789', type: 'tanker', ts: at + 4 * HOUR }]);

    // Older overlapping batches and a new process inside the cooldown do not
    // duplicate the crossing or move its original completion time.
    const overlap = make(evaluate);
    observe(overlap, 'a', at + HOUR);
    observe(overlap, 'b', at + 4 * HOUR);
    await overlap.flush(at + 4 * HOUR + 3000);
    tracker = make(evaluate);
    observe(tracker, 'a', at + 4 * HOUR + 5000);
    await tracker.flush(at + 4 * HOUR + 5000);
    assert.equal((await window(at + 4 * HOUR + 5000)).get(name).length, 1);
    assert.equal((await window(at + 28 * HOUR)).size, 0);

    command('FLUSHDB');
    tracker = make(evaluate);
    observe(tracker, 'a', at);
    await tracker.flush(at);
    tracker = make(evaluate);
    observe(tracker, 'b', at + 18 * HOUR + 1);
    await tracker.flush(at + 18 * HOUR + 1);
    assert.equal((await window(at + 18 * HOUR + 1)).size, 0, 'restart must not reset the gap clock');

    command('FLUSHDB');
    tracker = make(evaluate);
    observe(tracker, 'a', at);
    await tracker.flush(at);
    tracker = make(evaluate);
    observe(tracker, 'b', at + 18 * HOUR);
    await tracker.flush(at + 18 * HOUR);
    assert.equal((await window(at + 18 * HOUR)).get(name).length, 1, 'exact gap boundary is still accepted');
    await tracker.flush(at + 61 * HOUR);
    assert.equal(command('HGET', 'supply_chain:transit-gates:v1', '_rows'), '0');
    assert.equal(command('ZCARD', 'supply_chain:transit-gate-times:v1'), 0);

    command('FLUSHDB');
    let loseAck = true;
    tracker = make(async (...args) => {
      const result = await evaluate(...args);
      if (loseAck) { loseAck = false; return null; }
      return result;
    });
    observe(tracker, 'a', at);
    observe(tracker, 'b', at + HOUR);
    await assert.rejects(tracker.flush(at + HOUR), /gate update failed/);
    await tracker.flush(at + HOUR + 1);
    assert.equal((await window(at + HOUR + 1)).get(name).length, 1, 'retry after a lost response is idempotent');
  } finally {
    spawnSync(cli, ['-s', socket, 'SHUTDOWN', 'NOSAVE']);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent flushes serialize and retain observations newer than the caller clock', async () => {
  const batches = [];
  let release;
  const tracker = make(async (_script, _keys, args) => {
    batches.push(JSON.parse(args[4]));
    if (batches.length === 1) await new Promise(resolve => { release = resolve; });
    return [1, '{}'];
  });
  observe(tracker, 'a', at);
  const first = tracker.flush(at);
  const second = tracker.flush(at);
  const third = tracker.flush(at);
  observe(tracker, 'b', at + 1000);
  release();
  await Promise.all([first, second, third]);
  await tracker.flush(at + 1000);
  assert.deepEqual(batches.flat().map(row => [row[2], row[4]]), [['a', at], ['b', at + 1000]]);
});

test('failed writes keep observations and reject publication instead of accepting an empty window', async () => {
  let fail = true;
  let batch;
  const tracker = make(async (_script, _keys, args) => {
    if (fail) return null;
    batch = JSON.parse(args[4]);
    return [1, '{}'];
  });
  observe(tracker, 'a', at);
  await assert.rejects(tracker.flush(at), /gate update failed/);
  observe(tracker, 'b', at + HOUR);
  fail = false;
  await tracker.flush(at + HOUR);
  assert.deepEqual(batch.map(row => row[2]), ['a', 'b']);
});


test('recovery bounds requests and retains the failed chunk plus new arrivals', async () => {
  const batches = [];
  let fail = true;
  const tracker = make(async (_script, _keys, args) => {
    const rows = JSON.parse(args[4]);
    batches.push(rows);
    assert.ok(rows.length <= 1000);
    if (batches.length === 2 && fail) return null;
    return [1, '{}'];
  });
  for (let i = 0; i < 2100; i++) observe(tracker, 'a', at + i, String(Math.floor(i / 700)));
  await assert.rejects(tracker.flush(at + 2100), /gate update failed/);
  observe(tracker, 'b', at + 2200, '2');
  fail = false;
  await tracker.flush(at + 2200);
  assert.deepEqual(batches.map(rows => rows.length), [1000, 1000, 1000, 101]);
  assert.equal(batches[2][0][4], at + 1000);
  assert.equal(batches[3].at(-1)[4], at + 2200);
});

test('buffer exhaustion remains visible after successful writes instead of publishing partial input', async () => {
  const tracker = make(async () => [1, '{}']);
  for (let i = 0; i <= 20000; i++) observe(tracker, 'a', at + i);
  assert.ok((await tracker.flush(at + 20000)).has(name));
});


test('each request bounds the number of full vessel histories replayed', async () => {
  let count = 0;
  const tracker = make(async (_script, _keys, args) => {
    const rows = JSON.parse(args[4]);
    assert.ok(new Set(rows.map(row => JSON.stringify(row.slice(0, 2)))).size <= 4);
    count += rows.length;
    return [1, '{}'];
  });
  for (let i = 0; i < 30; i++) observe(tracker, 'a', at, String(i));
  await tracker.flush(at);
  assert.equal(count, 30);
});

test('in-flight reports count toward the memory cap and dropped-input deadlines do not move on retry', async () => {
  let release;
  const batches = [];
  const deadlines = [];
  const tracker = make(async (_script, _keys, args) => {
    batches.push(JSON.parse(args[4]));
    deadlines.push(args[8]);
    if (batches.length === 1) await new Promise(resolve => { release = resolve; });
    return [1, args[8]];
  });
  for (let i = 0; i < 20000; i++) observe(tracker, 'a', at, String(Math.floor(i / 1000)));
  const first = tracker.flush(at);
  observe(tracker, 'b', at + 1);
  release();
  assert.ok((await first).has(name));
  assert.ok((await tracker.flush(at + HOUR)).has(name));
  assert.equal(batches.flat().length, 20000);
  assert.equal(JSON.parse(deadlines.at(-1))[name], at + 1 + 42.5 * HOUR);
  assert.equal((await tracker.flush(at + 1 + 42.5 * HOUR)).size, 0);
});


test('one vessel cannot fill the pending buffer and suppress another waterway', async () => {
  const accepted = [];
  const tracker = createDurableTransitTracker({
    gates: { ...gates, Other: { a: [[1, 1, 0.1]], b: [[2, 2, 0.1]] } },
    maxTransitMs: 18 * HOUR, cooldownMs: HOUR / 2,
    evaluate: async (_script, _keys, args) => { accepted.push(...JSON.parse(args[4])); return [1, args[8]]; },
  });
  for (let i = 0; i < 20000; i++) observe(tracker, 'a', at);
  tracker.observe('other-vessel', 1, 1, 'cargo', at);
  tracker.observe('other-vessel', 2, 2, 'cargo', at + 1000);
  const unavailable = await tracker.flush(at + 1000);
  assert.deepEqual([...unavailable], [name]);
  assert.equal(accepted.filter(row => row[0] === name).length, 1000);
  assert.equal(accepted.filter(row => row[0] === 'Other').length, 2);
});
