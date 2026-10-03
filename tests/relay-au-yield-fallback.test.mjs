import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-03T20:00:00Z');

function harness({ meta = null, enabled = true, childError = null, deferChild = false } = {}) {
  const start = source.indexOf('const AU_YIELD_CHECK_INTERVAL_MS');
  assert.ok(start >= 0, 'relay must provide automatic AU fallback scheduling');
  const end = source.indexOf('// PizzINT Seed', start);
  assert.ok(end > start);
  const calls = [];
  const loops = [];
  const reads = [];
  let finish;
  const factory = new Function('path', '__dirname', 'execFile', 'process', 'upstashGet', 'UPSTASH_ENABLED', 'relayLogScriptOutput', 'startBootSeedLoop', 'console', 'Date', `${source.slice(start, end)}\nreturn { seedAuYieldCurve, startAuYieldCurveSeedLoop };`);
  const subject = factory(path, '/app/scripts', (bin, args, options, callback) => {
    calls.push({ bin, args, options });
    finish = () => callback(childError, '', '');
    if (!deferChild) finish();
  }, { execPath: '/usr/bin/node', env: { EXISTING_SETTING: 'kept' } }, async key => {
    reads.push(key);
    return meta;
  }, enabled, () => {}, (...args) => loops.push(args), { log() {}, warn() {} }, { now: () => now });
  return { ...subject, calls, loops, reads, finish: () => finish() };
}

const fresh = () => ({ fetchedAt: now - day / 2, newestItemAt: now - 3 * day });

test('healthy primary publication suppresses fallback execution', async () => {
  const h = harness({ meta: fresh() });
  await h.seedAuYieldCurve();
  assert.deepEqual(h.reads, ['seed-meta:economic:yield-curve-au']);
  assert.equal(h.calls.length, 0);
});

test('overdue heartbeat runs only the AU seeder with bounded time and its completion key', async () => {
  const h = harness({ meta: { ...fresh(), fetchedAt: now - day } });
  await h.seedAuYieldCurve();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].bin, '/usr/bin/node');
  assert.deepEqual(h.calls[0].args, ['/app/scripts/seed-yield-curve-au.mjs']);
  assert.equal(h.calls[0].options.timeout, 300_000);
  assert.equal(h.calls[0].options.env.EXISTING_SETTING, 'kept');
  assert.equal(h.calls[0].options.env.WM_BUNDLE_COMPLETION_META_KEY, 'seed-completion:economic:yield-curve-au');
  assert.equal(h.calls[0].options.env.BUNDLE_SECTION_TIMEOUT_MS, '300000');
});

test('stale content triggers fallback even when primary heartbeat is recent', async () => {
  const h = harness({ meta: { ...fresh(), newestItemAt: now - 10 * day } });
  await h.seedAuYieldCurve();
  assert.equal(h.calls.length, 1);
});

test('missing invalid and future clocks cannot suppress source recovery', async () => {
  for (const meta of [null, {}, { ...fresh(), fetchedAt: 'bad' }, { ...fresh(), fetchedAt: now + 1 }, { ...fresh(), newestItemAt: null }, { ...fresh(), newestItemAt: now + 1 }]) {
    const h = harness({ meta });
    await h.seedAuYieldCurve();
    assert.equal(h.calls.length, 1, JSON.stringify(meta));
  }
});

test('a failed source child rejects and remains eligible on the next tick', async () => {
  const h = harness({ childError: Object.assign(new Error('RBA HTTP 403'), { code: 75 }) });
  await assert.rejects(h.seedAuYieldCurve(), /RBA HTTP 403/);
  await assert.rejects(h.seedAuYieldCurve(), /RBA HTTP 403/);
  assert.equal(h.calls.length, 2);
});

test('overlapping ticks do not launch another child', async () => {
  const h = harness({ deferChild: true });
  const first = h.seedAuYieldCurve();
  await Promise.resolve();
  await h.seedAuYieldCurve();
  assert.equal(h.calls.length, 1);
  h.finish();
  await first;
});

test('relay schedules a six-hour freshness check and disables it without Redis', () => {
  const h = harness();
  h.startAuYieldCurveSeedLoop();
  assert.equal(h.loops.length, 1);
  assert.equal(h.loops[0][1], 'seed-meta:economic:yield-curve-au');
  assert.equal(h.loops[0][2], 6 * 60 * 60 * 1000);
  assert.equal(h.loops[0][3], h.seedAuYieldCurve);
  const disabled = harness({ enabled: false });
  disabled.startAuYieldCurveSeedLoop();
  assert.equal(disabled.loops.length, 0);
});
