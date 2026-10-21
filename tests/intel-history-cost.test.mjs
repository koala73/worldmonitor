import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embedBatch } from '../scripts/lib/brief-embedding.mjs';
import { appendSeedHistory } from '../scripts/_seed-history.mjs';
import { recordHistoryCost, historyCostKey, HISTORY_COST_UPDATE_SCRIPT } from '../scripts/lib/intel-history-cost.mjs';
import { readHistoryCost } from '../scripts/measure-intel-history.mjs';

const vector = Array(512).fill(0.125);
const env = {
  CONVEX_SITE_URL: 'https://convex.test',
  RELAY_SHARED_SECRET: 'relay-test',
  OPENROUTER_API_KEY: 'embedding-test',
};

function embedDeps({ usage = { prompt_tokens: 7, cost: 0.00000014 }, cached = false, invalid = false } = {}) {
  const observed = [];
  return {
    observed,
    _apiKey: 'embedding-test',
    redisPipeline: async commands => commands.map(() => ({ result: cached ? JSON.stringify(vector) : null })),
    fetch: async () => Response.json({ usage, data: [{ index: 0, embedding: invalid ? [] : vector }] }),
    onUsage: value => observed.push(value),
  };
}

test('embedding telemetry attributes the actual provider usage and deduplicates input texts', async () => {
  const deps = embedDeps();
  assert.deepEqual(await embedBatch(['one', 'one'], deps), [vector, vector]);
  assert.equal(deps.observed.length, 1);
  assert.deepEqual(deps.observed[0], {
    inputTexts: 2, uniqueTexts: 1, cacheHitTexts: 0, providerInputs: 1,
    providerRequests: 1, knownCostUsd: 0.00000014, unknownCostRequests: 0,
    knownPromptTokens: 7, unknownTokenRequests: 0,
  });
});

test('a fully cached batch has measured zero spend and makes no provider request', async () => {
  const deps = embedDeps({ cached: true });
  deps.fetch = async () => { throw new Error('unexpected provider request'); };
  await embedBatch(['one', 'one'], deps);
  assert.equal(deps.observed[0]?.knownCostUsd, 0);
  assert.equal(deps.observed[0]?.unknownCostRequests, 0);
  assert.equal(deps.observed[0]?.providerRequests, 0);
  assert.equal(deps.observed[0]?.cacheHitTexts, 1);
});

test('a mixed cache batch attributes only misses and preserves a provider-reported zero', async () => {
  const deps = embedDeps();
  deps.redisPipeline = async commands => commands.map((_, i) => ({ result: i === 0 ? JSON.stringify(vector) : null }));
  deps.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).input, ['two']);
    return Response.json({ usage: { prompt_tokens: 3, cost: 0 }, data: [{ index: 0, embedding: vector }] });
  };
  await embedBatch(['one', 'two', 'one'], deps);
  assert.equal(deps.observed[0].providerInputs, 1);
  assert.equal(deps.observed[0].cacheHitTexts, 1);
  assert.equal(deps.observed[0].knownCostUsd, 0);
  assert.equal(deps.observed[0].unknownCostRequests, 0);
});

test('missing or invalid provider usage is unknown rather than free', async () => {
  for (const usage of [undefined, {}, { cost: -1, prompt_tokens: -3 }, { cost: '0.1', prompt_tokens: '7' }]) {
    const deps = embedDeps({ usage: null });
    deps.fetch = async () => Response.json({ usage, data: [{ index: 0, embedding: vector }] });
    await embedBatch(['one'], deps);
    assert.equal(deps.observed[0]?.unknownCostRequests, 1);
    assert.equal(deps.observed[0]?.unknownTokenRequests, 1);
  }
});

test('a paid response is accounted for even when its vector is rejected', async () => {
  const deps = embedDeps({ invalid: true });
  await assert.rejects(embedBatch(['one'], deps), /unexpected length/);
  assert.equal(deps.observed[0]?.knownCostUsd, 0.00000014);
  assert.equal(deps.observed[0]?.providerRequests, 1);
});

test('a transport failure has unknown spend and an observer failure preserves embedding behavior', async () => {
  const deps = embedDeps();
  deps.fetch = async () => { throw new Error('disconnected'); };
  await assert.rejects(embedBatch(['one'], deps), /fetch failed/);
  assert.equal(deps.observed[0]?.unknownCostRequests, 1);
  const throwing = embedDeps();
  throwing.onUsage = () => { throw new Error('telemetry unavailable'); };
  assert.deepEqual(await embedBatch(['one'], throwing), [vector]);
});

test('history preserves paid embedding usage when every relay chunk fails', async () => {
  const observed = [];
  await assert.rejects(appendSeedHistory({
    domain: 'energy', resource: 'intelligence', runId: 'failed-run',
    records: [{ dedupeKey: 'event-1', title: 'One', occurredAt: Date.now() }],
  }, {
    env,
    embed: async (_texts, options) => {
      options.onUsage({ inputTexts: 1, uniqueTexts: 1, cacheHitTexts: 0, providerInputs: 1,
        providerRequests: 1, knownCostUsd: 0.01, unknownCostRequests: 0,
        knownPromptTokens: 7, unknownTokenRequests: 0 });
      return [vector];
    },
    fetchImpl: async () => new Response('relay unavailable', { status: 503 }),
    sleep: async () => {},
    recordCost: async observation => observed.push(observation),
  }), /503/);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].knownCostUsd, 0.01);
  assert.equal(observed[0].failedRuns, 1);
  assert.equal(observed[0].failedChunks, 1);
  assert.equal(observed[0].inserted, 0);
});

test('telemetry persistence failure cannot reject a successful history append', async () => {
  const result = await appendSeedHistory({
    domain: 'energy', resource: 'intelligence', runId: 'success-run',
    records: [{ dedupeKey: 'event-1', title: 'One', occurredAt: Date.now() }],
  }, {
    env,
    embed: async () => [vector],
    fetchImpl: async () => Response.json({ inserted: 1, skipped: 0, retracted: 0 }),
    recordCost: async () => { throw new Error('Redis unavailable'); },
  });
  assert.equal(result.inserted, 1);
});

test('daily persistence uses one atomic update scoped by domain, resource, model, and UTC day', async () => {
  const commands = [];
  const at = Date.parse('2026-10-19T23:59:59Z');
  const result = await recordHistoryCost({ domain: 'energy', resource: 'intelligence', at,
    runs: 1, providerRequests: 1, knownCostUsd: 0.01, unknownCostRequests: 0 }, {
    env: { UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test' },
    fetchImpl: async (_url, init) => {
      commands.push(JSON.parse(init.body));
      assert.ok(init.signal);
      return Response.json({ result: 'OK' });
    },
  });
  assert.equal(result, true);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].slice(0, 4), ['EVAL', HISTORY_COST_UPDATE_SCRIPT, 1,
    historyCostKey('energy', 'intelligence', '2026-10-19')]);
  const values = JSON.parse(commands[0][4]);
  assert.equal(values.knownCostUsd, 0.01);
  assert.equal(values.runs, 1);
  assert.equal(commands[0][6], Date.parse('2027-05-08T00:00:00Z') / 1000);
  assert.notEqual(historyCostKey('energy', 'intelligence', '2026-10-19'), historyCostKey('military', 'intelligence', '2026-10-19'));
  assert.notEqual(historyCostKey('a:b', 'c', '2026-10-19'), historyCostKey('a', 'b:c', '2026-10-19'));
});

test('unconfirmed persistence and invalid counters cannot report a recorded observation', async () => {
  const observation = { domain: 'energy', resource: 'intelligence', at: Date.now(), runs: 1 };
  const deps = { env: { UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test' } };
  for (const body of [{ error: 'wrong type' }, { result: null }]) {
    await assert.rejects(recordHistoryCost(observation, { ...deps, fetchImpl: async () => Response.json(body) }), /not confirmed/);
  }
  await assert.rejects(recordHistoryCost({ ...observation, knownCostUsd: Number.NaN }, deps), /invalid history cost/);
  assert.equal(await recordHistoryCost(observation, { env: {} }), false);
});

const cli = process.env.REDIS_CLI_BIN || 'redis-cli';
const server = process.env.REDIS_SERVER_BIN || 'redis-server';
const hasRedis = spawnSync(cli, ['--version']).status === 0 && spawnSync(server, ['--version']).status === 0;

test('real Redis accumulates concurrent observations atomically and rejects corrupt totals without partial writes',
  { skip: !hasRedis && 'redis-server and redis-cli required' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intel-cost-'));
    const socket = join(dir, 'redis.sock');
    const started = spawnSync(server, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no',
      '--daemonize', 'yes', '--pidfile', join(dir, 'pid'), '--logfile', join(dir, 'log')], { encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr);
    const exec = promisify(execFile);
    const command = async (...args) => (await exec(cli, ['-s', socket, '--raw', ...args.map(String)])).stdout.trim();
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try { ready = await command('PING') === 'PONG'; } catch {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(ready, 'Redis must be ready');
      const at = Date.now();
      const observation = { domain: 'energy', resource: 'intelligence', at, runs: 1,
        knownCostUsd: 0.00000014, providerRequests: 1, knownPromptTokens: 7 };
      const deps = {
        env: { UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test' },
        fetchImpl: async (_url, init) => Response.json({ result: await command(...JSON.parse(init.body)) }),
      };
      await Promise.all(Array.from({ length: 16 }, (_, i) => recordHistoryCost({ ...observation, at: at - i }, deps)));
      const key = historyCostKey('energy', 'intelligence', new Date(at).toISOString().slice(0, 10));
      assert.equal(await command('HGET', key, 'runs'), '16');
      assert.equal(await command('HGET', key, 'knownPromptTokens'), '112');
      assert.ok(Math.abs(Number(await command('HGET', key, 'knownCostUsd')) - 16 * 0.00000014) < 1e-15);
      assert.equal(Number(await command('HGET', key, 'lastObservedAt')), at);
      assert.ok(Number(await command('TTL', key)) > 0);

      const result = await appendSeedHistory({ domain: 'energy', resource: 'intelligence', runId: 'integrated-run',
        records: [{ dedupeKey: 'event-1', title: 'One', occurredAt: at }],
      }, {
        env: { ...env, ...deps.env },
        embed: (texts, options) => embedBatch(texts, { ...embedDeps(),
          wallClockMs: options.wallClockMs, onUsage: options.onUsage }),
        fetchImpl: (url, init) => url === deps.env.UPSTASH_REDIS_REST_URL
          ? deps.fetchImpl(url, init)
          : Promise.resolve(Response.json({ inserted: 1, skipped: 0, retracted: 0 })),
      });
      assert.equal(result.inserted, 1);
      const measured = await readHistoryCost({ domain: 'energy', resource: 'intelligence',
        day: new Date(at).toISOString().slice(0, 10) }, {
        ...deps,
        fetchImpl: async (_url, init) => Response.json({ result: (await command(...JSON.parse(init.body))).split('\n') }),
      });
      assert.equal(measured.reportedUsageComplete, true);
      assert.equal(measured.counters.runs, 17);
      assert.equal(measured.counters.knownPromptTokens, 119);
      assert.equal(measured.counters.inserted, 1);
      assert.ok(Math.abs(measured.counters.knownCostUsd - 17 * 0.00000014) < 1e-15);

      await command('HSET', key, 'knownPromptTokens', 'corrupt');
      const before = await command('HGETALL', key);
      await assert.rejects(recordHistoryCost(observation, deps), /not confirmed/);
      assert.equal(await command('HGETALL', key), before);
    } finally {
      await command('SHUTDOWN', 'NOSAVE');
      rmSync(dir, { recursive: true, force: true });
    }
  });
