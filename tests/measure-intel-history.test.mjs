import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDocumentSize } from 'convex/values';
import { measureHistoryStorage, readHistoryCost } from '../scripts/measure-intel-history.mjs';

const row = (id, domain = 'energy') => ({ _id: id, _creationTime: 1, domain, resource: 'intelligence',
  ingestedAt: 1, occurredAt: 1, title: 'An event', embedding: [0.1, 0.2] });

test('storage measurement walks all pages and reports per-domain document size without retaining content', async () => {
  const rows = [row('one'), row('two', 'conflict')];
  const cursors = [];
  const result = await measureHistoryStorage({ query: async (name, args) => {
    assert.equal(name, '_system/cli/tableData');
    assert.equal(args.table, 'intelHistory');
    cursors.push(args.paginationOpts.cursor);
    return args.paginationOpts.cursor === null
      ? { page: [rows[0]], isDone: false, continueCursor: 'next' }
      : { page: [rows[1]], isDone: true, continueCursor: 'done' };
  } });
  assert.deepEqual(cursors, [null, 'next']);
  assert.equal(result.complete, true);
  assert.equal(result.rows, 2);
  assert.equal(result.scopes[0].documentBytes, getDocumentSize(rows[0]));
  assert.equal(result.scopes[0].rawVectorBytes, 16);
  assert.equal(result.vectorIndexBilledBytes, null);
  assert.doesNotMatch(JSON.stringify(result), /An event|"embedding"/);
});

test('row limits mark an incomplete scan and empty tables have a valid complete zero', async () => {
  const result = await measureHistoryStorage({ maxRows: 1, query: async () => ({ page: [row('one')], isDone: false, continueCursor: 'next' }) });
  assert.equal(result.complete, false);
  assert.equal(result.rows, 1);
  const empty = await measureHistoryStorage({ query: async () => ({ page: [], isDone: true, continueCursor: '' }) });
  assert.equal(empty.complete, true);
  assert.equal(empty.rows, 0);
  await assert.rejects(measureHistoryStorage({ maxRows: -1, query: async () => {} }), /maxRows/);
});

test('a missing daily ledger is not a measured zero and unknown cost remains explicit', async () => {
  const env = { UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test' };
  const scope = { domain: 'energy', resource: 'intelligence', day: '2026-10-19' };
  const missing = await readHistoryCost(scope, { env, fetchImpl: async () => Response.json({ result: [] }) });
  assert.equal(missing.status, 'not_observed');
  const observed = await readHistoryCost(scope, { env, fetchImpl: async () => Response.json({ result: [
    'runs', '2', 'knownCostUsd', '0.001', 'unknownCostRequests', '1', 'unknownEmbeddingRuns', '0',
  ] }) });
  assert.equal(observed.status, 'observed');
  assert.equal(observed.reportedUsageComplete, false);
  assert.equal(observed.counters.knownCostUsd, 0.001);
  await assert.rejects(readHistoryCost({ ...scope, day: '2026-02-31' }, { env }), /day/);
});
