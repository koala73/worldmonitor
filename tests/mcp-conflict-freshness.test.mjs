import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const NOW = Date.parse('2026-10-21T10:07:26.681Z');
const MINUTE = 60_000;
const CONTENT_BUDGET = 90 * 24 * 60;
const tool = CACHE_TOOLS.find(t => t.name === 'get_conflict_events');
const ucdpKey = 'seed-meta:conflict:ucdp-events';
const unrestKey = 'seed-meta:unrest:events';
const metaAtAge = age => ({ fetchedAt: NOW - age * MINUTE, recordCount: 3, status: 'ok' });
const ucdpMeta = age => ({ ...metaAtAge(age), candidateVersion: '26.0.9', candidateComplete: true,
  annualFailedPages: 0, newestItemAt: NOW - 21 * 24 * 60 * MINUTE, maxContentAgeMin: CONTENT_BUDGET });

async function dispatch(t, ucdp = ucdpMeta(359), unrest = metaAtAge(10)) {
  const originalEnv = process.env;
  process.env = { ...originalEnv, UPSTASH_REDIS_REST_URL: 'https://conflict-redis.test', UPSTASH_REDIS_REST_TOKEN: 'test-token' };
  t.after(() => { process.env = originalEnv; });
  const values = new Map([
    ['conflict:ucdp-events:v1', { candidateVersion: '26.0.9', events: [{ id: 'event', country: 'Ukraine', deathsBest: 1 }] }],
    ['unrest:events:v1', { events: [] }],
    ...tool._cacheKeys.filter(key => key.includes('risk:')).map(key => [key, { ciiScores: [] }]),
    ['conflict:iran-events:v1', { events: [] }],
    [ucdpKey, ucdp], [unrestKey, unrest],
  ]);
  t.mock.method(globalThis, 'fetch', async url => {
    const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
    assert.ok(values.has(key), `unexpected Redis read ${key}`);
    return Response.json({ result: values.get(key) == null ? null : JSON.stringify(values.get(key)) });
  });
  return executeTool(tool, { limit: 3 }, NOW);
}

test('conflict MCP metadata budgets agree with the health contract', () => {
  for (const name of ['ucdpEvents', 'unrestEvents']) {
    const cfg = health.SEED_META[name];
    assert.equal(tool._freshnessChecks.find(check => check.key === cfg.key).maxStaleMin, cfg.maxStaleMin);
  }
});

for (const age of [31, 359, 360, 365, 420]) {
  test(`scheduled UCDP snapshot remains fresh at ${age} minutes through MCP dispatch`, async t => {
    const meta = ucdpMeta(age);
    const result = await dispatch(t, meta);
    assert.equal(result.stale, false);
    assert.equal(result.cached_at, new Date(meta.fetchedAt).toISOString());
    assert.equal(result.conflict_source.ucdp.fetchedAt, meta.fetchedAt);
    assert.equal(result.conflict_source.ucdp.candidateVersion, '26.0.9');
    assert.deepEqual(result.data['ucdp-events'].events.map(event => event.id), ['event']);
    assert.deepEqual(result.data.events.events, []);
  });
}

for (const [label, meta] of [
  ['expired', ucdpMeta(421)],
  ['failed refresh', { ...ucdpMeta(1), status: 'error' }],
  ['missing', null],
  ['invalid timestamp', { ...ucdpMeta(1), fetchedAt: 'invalid' }],
]) {
  test(`UCDP ${label} metadata remains stale through MCP dispatch`, async t => {
    const result = await dispatch(t, meta);
    assert.equal(result.stale, true);
    if (meta == null || meta.fetchedAt === 'invalid') assert.equal(result.cached_at, null);
    assert.equal(result.data['ucdp-events'].events[0].id, 'event');
  });
}

for (const [label, unrest, stale] of [
  ['exact expiry boundary', metaAtAge(120), false],
  ['expired', metaAtAge(121), true],
  ['failed refresh', { ...metaAtAge(1), status: 'error' }, true],
  ['missing', null, true],
  ['invalid timestamp', { fetchedAt: 'invalid' }, true],
]) {
  test(`unrest ${label} stays independent of fresh UCDP metadata`, async t => {
    assert.equal((await dispatch(t, ucdpMeta(1), unrest)).stale, stale);
  });
}

for (const [label, newestItemAt, stale] of [
  ['monthly candidate observations', NOW - 21 * 24 * 60 * MINUTE, false],
  ['exact content boundary', NOW - CONTENT_BUDGET * MINUTE, false],
  ['expired observations', NOW - (CONTENT_BUDGET + 1) * MINUTE, true],
  ['missing observation clock', null, true],
  ['invalid observation clock', 'invalid', true],
  ['future observations', NOW + 10 * MINUTE, true],
]) {
  test(`UCDP ${label} agrees with health despite a fresh fetch`, async t => {
    const meta = { ...ucdpMeta(1), newestItemAt };
    const cfg = health.SEED_META.ucdpEvents;
    const assessed = health.readSeedMeta(cfg, new Map([[cfg.key, JSON.stringify(meta)]]), new Map(), NOW);
    assert.equal(assessed.contentAge.contentStale, stale);
    assert.equal((await dispatch(t, meta)).stale, stale);
  });
}
