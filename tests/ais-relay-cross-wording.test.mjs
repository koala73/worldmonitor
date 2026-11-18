// The relay's side of cross-wording corroboration (#10977): which labelled
// headlines are recorded, which are checked, and the per-cycle cap. Runs the
// real function from ais-relay.cjs against a stand-in module.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { reachesRealtimeRules } = require('../scripts/lib/news-story-key.cjs');
const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const start = relay.indexOf('const CROSS_WORDING_MAX_CHECKS');
const end = relay.indexOf('\nasync function seedClassifyForVariant(', start);

function harness({ module: loaded = true } = {}) {
  assert.ok(start > 0 && end > start);
  const recorded = [];
  const checked = [];
  const lines = [];
  const corroboration = {
    recordSightings: async (sightings) => { recorded.push(...sightings); },
    crossWordingFamilies: async (candidates) => {
      checked.push(...candidates);
      return new Map(candidates.map((c) => [c.title, { families: ['a', 'b', 'c', 'd', 'e'] }]));
    },
  };
  const context = {
    newsCorroborationPromise: Promise.resolve(loaded ? corroboration : null),
    shouldDropRelaySourceForTier: (_ready, source) => source === 'Dropped Source',
    RELAY_GATES_READY: true, RELAY_TIER4_SOURCES: new Set(), RELAY_RECENCY_MS: 15 * 60_000,
    // 73 for a lone copy and 3 more per publisher, as tier 4 scores.
    relayComputeImportanceScore: (_level, _source, count) => 70 + 3 * count,
    reachesRealtimeRules, console: { log: (line) => lines.push(line) }, Date, Map, Math, JSON,
  };
  vm.createContext(context);
  vm.runInContext(relay.slice(start, end), context);
  const run = (items, observed = new Map()) => {
    const chunk = items.map((item) => item.title);
    const levels = new Map(items.map((item, i) => [i, item.level]));
    const all = new Map(items.map((item) => [item.title, { source: 'Feed', publishedAt: Date.now(), corroborationCount: 1, ...item.meta }]));
    return vm.runInContext('crossWordingFamilies', context)(chunk, levels, all, observed);
  };
  return { run, recorded, checked, lines, refill: () => vm.runInContext('crossWordingChecksLeft = CROSS_WORDING_MAX_CHECKS', context) };
}

const titlesOf = (rows) => rows.map((row) => row.title);

describe('relay cross-wording corroboration (#10977)', () => {
  it('checks only critical copies under the realtime bar; high copies are recorded and never checked', async () => {
    const h = harness();
    const found = await h.run([
      { title: 'critical under the bar', level: 'critical' },
      { title: 'high copy', level: 'high' },
      { title: 'medium copy', level: 'medium' },
      { title: 'critical over the bar', level: 'critical', meta: { corroborationCount: 4 } },
      { title: 'critical with coverage', level: 'critical' },
    ], new Map([['critical with coverage', 4]]));
    assert.deepEqual(titlesOf(h.recorded), ['critical under the bar', 'high copy', 'critical over the bar', 'critical with coverage']);
    assert.deepEqual(h.recorded.map((s) => s.level), ['critical', 'high', 'critical', 'critical']);
    assert.deepEqual(titlesOf(h.checked), ['critical under the bar']);
    assert.deepEqual([...found.keys()], ['critical under the bar']);
  });

  it('leaves out X posts, and never checks a copy the relay gates will drop', async () => {
    const h = harness();
    await h.run([
      { title: 'x post', level: 'critical', meta: { fromX: true } },
      { title: 'dropped source', level: 'critical', meta: { source: 'Dropped Source' } },
      { title: 'too old', level: 'critical', meta: { publishedAt: Date.now() - 16 * 60_000 } },
    ]);
    assert.deepEqual(titlesOf(h.recorded), ['dropped source', 'too old']);
    assert.deepEqual(h.checked, []);
  });

  it('checks at most the cycle cap, logs the rest, and checks again after a refill', async () => {
    const h = harness();
    const batch = (prefix) => Array.from({ length: 6 }, (_, i) => ({ title: `${prefix} ${i}`, level: 'critical' }));
    assert.equal((await h.run(batch('first'))).size, 6);
    const second = await h.run(batch('second'));
    assert.deepEqual([...second.keys()], ['second 0', 'second 1']);
    assert.match(h.lines.join('\n'), /\[news-corroboration\] \{"unchecked":4,"reason":"budget"\}/);
    assert.equal((await h.run(batch('third'))).size, 0);
    assert.equal(h.checked.length, 8);
    h.refill();
    assert.equal((await h.run(batch('fourth'))).size, 6);
  });

  it('adds nothing when the module failed to load', async () => {
    const h = harness({ module: false });
    assert.equal((await h.run([{ title: 'critical under the bar', level: 'critical' }])).size, 0);
  });
});
