import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CACHE_KEY, MAX_STALE_MIN } from '../scripts/china-futures/contract.mjs';

test('opt-in health registration is absent when disabled and strict when enabled', async () => {
  const saved = process.env.CHINA_FUTURES_NEWS_ENABLED;
  try {
    delete process.env.CHINA_FUTURES_NEWS_ENABLED;
    const off = (await import('../api/health.js?shfe-off')).__testing__;
    assert.equal(off.STANDALONE_KEYS.chinaFuturesNotices, undefined);
    process.env.CHINA_FUTURES_NEWS_ENABLED = '1';
    const on = (await import('../api/health.js?shfe-on')).__testing__;
    assert.equal(on.STANDALONE_KEYS.chinaFuturesNotices, CACHE_KEY);
    assert.equal(on.SEED_META.chinaFuturesNotices.key, 'seed-meta:news:china-futures:shfe:notices');
    assert.equal(on.SEED_META.chinaFuturesNotices.maxStaleMin, MAX_STALE_MIN);
    assert.equal(on.BOOTSTRAP_KEYS.chinaFuturesNotices, undefined);
    assert.equal(on.classifyKey('chinaFuturesNotices', CACHE_KEY, { allowOnDemand: true }, {
      keyStrens: new Map(), keyErrors: new Map(), keyMetaValues: new Map(), keyMetaErrors: new Map(), now: Date.now(),
    }).status, 'EMPTY');
  } finally {
    if (saved === undefined) delete process.env.CHINA_FUTURES_NEWS_ENABLED; else process.env.CHINA_FUTURES_NEWS_ENABLED = saved;
  }
});

test('original macro scheduler and Railway build include the opted-in producer', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const bundle = read('scripts/seed-bundle-macro.mjs');
  assert.match(bundle, /process\.env\.CHINA_FUTURES_NEWS_ENABLED === '1'/);
  assert.match(bundle, /script: 'seed-china-futures-notices\.mjs'.*intervalMs: 6 \* HOUR/);
  assert.ok(bundle.includes(`canonicalKey: '${CACHE_KEY}'`));
  const registry = JSON.parse(read('scripts/railway-services.json'));
  const records = Array.isArray(registry) ? registry : registry.services;
  const service = records.find((entry) => entry.entry === 'scripts/seed-bundle-macro.mjs');
  for (const path of ['scripts/seed-china-futures-notices.mjs', 'scripts/china-futures/contract.mjs', 'scripts/china-futures/shfe-notices.mjs', 'scripts/_html-entities.mjs']) assert.ok(service.watchPatterns.includes(path), path);
});
