import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { orderMacroSections } from '../scripts/_macro-bundle-order.mjs';
import { claimBundleTurn, acknowledgeBundleTurn } from '../scripts/_bundle-turn.mjs';
import { BUNDLE_PREFLIGHT_HEADROOM_MS, KILL_GRACE_MS } from '../scripts/_bundle-runner.mjs';
import { extractBundleSections, resolveExpr } from './helpers/bundle-section-parser.mjs';

const source = readFileSync(new URL('../scripts/seed-bundle-macro.mjs', import.meta.url), 'utf8');
const macro = extractBundleSections(source).filter(s => !['Physical-Premiums', 'Education-Attainment'].includes(s.label))
  .map(s => ({ label: s.label, timeoutMs: resolveExpr(source, s.timeoutMsExpr) }));
const physical = { label: 'Physical', timeoutMs: 480_000 };
const education = { label: 'Education', timeoutMs: 300_000 };
const retry = new Date('2026-11-05T10:00:00Z');

test('each macro source receives an admissible lead slot even if every earlier due job always times out', () => {
  const foodSources = JSON.parse(readFileSync(new URL('../shared/food-price-sources.json', import.meta.url)));
  assert.equal(macro.filter(s => s.label.startsWith('Food-')).length, foodSources.length);
  const admitted = new Set();
  for (let turn = 0; turn < macro.length; turn++) {
    const ordered = orderMacroSections(retry, education, physical, macro, turn);
    assert.equal(new Set(ordered).size, macro.length + 2);
    assert.equal(ordered[1], physical);
    assert.equal(ordered.at(-1), education);
    let elapsed = BUNDLE_PREFLIGHT_HEADROOM_MS;
    for (const section of ordered) {
      const worstCase = section.timeoutMs + KILL_GRACE_MS;
      if (elapsed + worstCase > 550_000) continue;
      elapsed += worstCase;
      admitted.add(section.label);
    }
    assert.ok(admitted.has(ordered[0].label), 'never-seeded lead fits the budget without relying on fetchedAt');
  }
  for (const section of macro) assert.ok(admitted.has(section.label), section.label);
  assert.equal(orderMacroSections(retry, education, physical, macro, macro.length)[0], macro[0]);
});

test('08:00 and 09:00 preserve Physical retry admission independently of the 10:00 cursor', () => {
  assert.equal(orderMacroSections(new Date('2026-11-05T08:00:00Z'), education, physical, macro)[0], physical);
  assert.equal(orderMacroSections(new Date('2026-11-08T08:00:00Z'), education, physical, macro)[0], education);
  const retryOrder = orderMacroSections(new Date('2026-11-08T09:00:00Z'), education, physical, macro);
  assert.equal(retryOrder[0], physical);
  assert.ok(BUNDLE_PREFLIGHT_HEADROOM_MS + physical.timeoutMs + KILL_GRACE_MS <= 550_000);
  for (const invalid of [-1, NaN, 0.5]) assert.throws(() => orderMacroSections(retry, education, physical, macro, invalid));
});

test('macro retries persist their turn and acknowledge completed failures through the runner hook', async () => {
  const commands = [];
  const options = { credentials: { restUrl: 'https://redis.example', token: 'fixture' }, token: 'macro-turn',
    fetchImpl: async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return Response.json({ result: commands.length === 1 ? [1, '17'] : 1 });
    },
  };
  const claim = await claimBundleTurn('macro', options);
  assert.deepEqual(claim, { turn: 17, token: 'macro-turn' });
  assert.deepEqual(commands[0].slice(3, 5), ['bundle:turn:macro', 'bundle:turn:macro:lease']);
  assert.equal(await acknowledgeBundleTurn('macro', claim, options), true);
  assert.deepEqual(commands[1].slice(3, 5), commands[0].slice(3, 5));
  assert.match(source, /getUTCHours\(\) === 10/);
  assert.match(source, /prefetchFreshness: true/);
  assert.match(source, /maxBundleMs: 550_000/);
  assert.ok(5_000 + 550_000 + 5_000 < 600_000, 'lease, complete runner budget and acknowledgement fit the container deadline');
  assert.match(source, /onTerminalComplete:[\s\S]+acknowledgeBundleTurn\('macro', claim\)/);
});

test('slow freshness reads finish together before exhausted-budget deferrals and cursor acknowledgement', () => {
  const runner = new URL('../scripts/_bundle-runner.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
    let pending = 0, peak = 0, started = false;
    const base = Date.now();
    Date.now = () => base + (started && pending === 0 ? 550_000 : 0);
    globalThis.fetch = async (url) => {
      if (!String(url).includes('/get/')) return Response.json({ result: 'OK' });
      started = true; peak = Math.max(peak, ++pending);
      await new Promise(resolve => setTimeout(resolve, 10));
      pending--;
      return Response.json({ result: null });
    };
    const { runBundle } = await import(${JSON.stringify(runner)});
    const sections = Array.from({ length: ${macro.length} }, (_, i) => ({
      label: 'NeverSeeded-' + i, script: 'not-admitted.mjs', seedMetaKey: 'fixture-' + i,
      intervalMs: 86400000, timeoutMs: 115000,
    }));
    await runBundle('macro-fixture', sections, {
      maxBundleMs: 550000, prefetchFreshness: true,
      onTerminalComplete: async () => console.log('ACK pending=' + pending + ' peak=' + peak),
    });
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1, result.stderr); // Exhausted tick stays non-zero, but acknowledges its turn.
  assert.match(result.stdout, new RegExp(`ACK pending=0 peak=${macro.length}`));
  assert.match(result.stdout, new RegExp(`ran:0 skipped:0 deferred:${macro.length}`));
});
