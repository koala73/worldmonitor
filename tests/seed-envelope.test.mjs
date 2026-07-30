import test from 'node:test';
import assert from 'node:assert/strict';

import {
  unwrapEnvelope,
  stripSeedEnvelope,
  buildEnvelope,
} from '../scripts/_seed-envelope-source.mjs';

test('unwrapEnvelope: null input → null envelope + null data', () => {
  assert.deepEqual(unwrapEnvelope(null), { _seed: null, data: null });
  assert.deepEqual(unwrapEnvelope(undefined), { _seed: null, data: null });
});

test('unwrapEnvelope: legacy raw value passes through as data', () => {
  assert.deepEqual(unwrapEnvelope({ events: [1, 2, 3] }), {
    _seed: null,
    data: { events: [1, 2, 3] },
  });
});

test('unwrapEnvelope: legacy array passes through as data', () => {
  assert.deepEqual(unwrapEnvelope([1, 2, 3]), { _seed: null, data: [1, 2, 3] });
});

test('unwrapEnvelope: envelope shape parses _seed + data', () => {
  const wrapped = {
    _seed: { fetchedAt: 1_700_000_000_000, recordCount: 5, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: { events: [{ id: 1 }] },
  };
  const out = unwrapEnvelope(wrapped);
  assert.equal(out._seed.fetchedAt, 1_700_000_000_000);
  assert.equal(out._seed.state, 'OK');
  assert.deepEqual(out.data, { events: [{ id: 1 }] });
});

test('unwrapEnvelope: malformed _seed block (missing fetchedAt) → treated as legacy', () => {
  const bogus = { _seed: { sourceVersion: 'v1' }, data: { x: 1 } };
  const out = unwrapEnvelope(bogus);
  assert.equal(out._seed, null);
  // Falls through the `_seed` branch: whole object becomes `data`.
  assert.deepEqual(out.data, bogus);
});

test('unwrapEnvelope: stringified JSON is parsed', () => {
  const wrapped = JSON.stringify({
    _seed: { fetchedAt: 123, recordCount: 0, sourceVersion: 'v1', schemaVersion: 1, state: 'OK_ZERO' },
    data: [],
  });
  const out = unwrapEnvelope(wrapped);
  assert.equal(out._seed.state, 'OK_ZERO');
  assert.deepEqual(out.data, []);
});

test('unwrapEnvelope: stringified garbage → legacy passthrough', () => {
  const out = unwrapEnvelope('not json at all');
  assert.equal(out._seed, null);
  assert.equal(out.data, 'not json at all');
});

test('stripSeedEnvelope: returns data only', () => {
  const wrapped = {
    _seed: { fetchedAt: 1, recordCount: 1, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: { hello: 'world' },
  };
  assert.deepEqual(stripSeedEnvelope(wrapped), { hello: 'world' });
});

test('stripSeedEnvelope: legacy value passes through unchanged', () => {
  const legacy = { events: [1, 2] };
  assert.deepEqual(stripSeedEnvelope(legacy), legacy);
});

test('stripSeedEnvelope: null → null', () => {
  assert.equal(stripSeedEnvelope(null), null);
});

test('buildEnvelope: minimal OK build', () => {
  const env = buildEnvelope({
    fetchedAt: 1, recordCount: 5, sourceVersion: 'v1', schemaVersion: 1, state: 'OK',
    data: { events: [] },
  });
  assert.equal(env._seed.state, 'OK');
  assert.equal(env._seed.recordCount, 5);
  assert.deepEqual(env.data, { events: [] });
  assert.equal(env._seed.failedDatasets, undefined);
});

test('buildEnvelope: ERROR state carries failedDatasets + errorReason', () => {
  const env = buildEnvelope({
    fetchedAt: 1, recordCount: 0, sourceVersion: 'v1', schemaVersion: 1, state: 'ERROR',
    failedDatasets: ['wgi', 'fao'],
    errorReason: 'upstream 503',
    data: null,
  });
  assert.equal(env._seed.state, 'ERROR');
  assert.deepEqual(env._seed.failedDatasets, ['wgi', 'fao']);
  assert.equal(env._seed.errorReason, 'upstream 503');
});

test('buildEnvelope: groupId included for multi-key group writes', () => {
  const env = buildEnvelope({
    fetchedAt: 1, recordCount: 222, sourceVersion: 'v7', schemaVersion: 1, state: 'OK',
    groupId: 'resilience-static:2026-04-14',
    data: { countries: {} },
  });
  assert.equal(env._seed.groupId, 'resilience-static:2026-04-14');
});

test('unwrapEnvelope round-trips buildEnvelope output', () => {
  const env = buildEnvelope({
    fetchedAt: 42, recordCount: 3, sourceVersion: 'v9', schemaVersion: 2, state: 'OK',
    data: { items: [{ a: 1 }, { b: 2 }, { c: 3 }] },
  });
  const out = unwrapEnvelope(env);
  assert.deepEqual(out._seed, env._seed);
  assert.deepEqual(out.data, env.data);
});
