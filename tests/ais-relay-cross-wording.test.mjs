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
    crossWordingFamilies: async (candidates, opts = {}) => {
      checked.push(...candidates);
      opts.report?.({ checks: candidates.length, matches: candidates.length, failures: {}, unchecked: 0 });
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
  return {
    run, recorded, checked, lines,
    refill: () => vm.runInContext('crossWordingChecksLeft = CROSS_WORDING_MAX_CHECKS', context),
    reports: () => JSON.parse(vm.runInContext('JSON.stringify(crossWordingReports)', context)),
  };
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
    ], new Map([['critical with coverage', ['a', 'b', 'c', 'd']]]));
    assert.deepEqual(titlesOf(h.recorded), ['critical under the bar', 'high copy', 'critical over the bar', 'critical with coverage']);
    assert.deepEqual(h.recorded.map((s) => s.level), ['critical', 'high', 'critical', 'critical']);
    assert.deepEqual(titlesOf(h.checked), ['critical under the bar']);
    assert.deepEqual([...found.keys()], ['critical under the bar']);
  });

  it('hands on the publishers the coverage history holds for each headline', async () => {
    const h = harness();
    await h.run([
      { title: 'critical under the bar', level: 'critical' },
      { title: 'high copy', level: 'high' },
      { title: 'no history', level: 'high' },
    ], new Map([['critical under the bar', ['label:oilprice.com']], ['high copy', ['reuters', 'label:arab times']]]));
    assert.deepEqual(h.recorded.map((s) => s.families), [['label:oilprice.com'], ['reuters', 'label:arab times'], undefined]);
    assert.deepEqual(h.checked.map((c) => c.families), [['label:oilprice.com']]);
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

  it('reports each call, with the copies the cycle budget left unchecked (#11426)', async () => {
    const h = harness();
    const batch = (prefix) => Array.from({ length: 6 }, (_, i) => ({ title: `${prefix} ${i}`, level: 'critical' }));
    await h.run(batch('first'));
    await h.run(batch('second'));
    await h.run(batch('third'));
    const reports = h.reports();
    assert.deepEqual(reports.map(({ checks, unchecked }) => ({ checks, unchecked })), [
      { checks: 6, unchecked: 0 }, { checks: 2, unchecked: 4 }, { checks: 0, unchecked: 6 },
    ]);
    assert.ok(reports.every((r) => Number.isFinite(r.at)));
  });

  it('adds nothing when the module failed to load', async () => {
    const h = harness({ module: false });
    assert.equal((await h.run([{ title: 'critical under the bar', level: 'critical' }])).size, 0);
  });
});

// The classify cycle's health write (#11426).
const writerStart = relay.indexOf('let crossWordingHealthResumed');
const writerEnd = relay.indexOf('\nasync function seedClassify(', writerStart);
const corroborationModule = await import('../scripts/lib/news-corroboration.mjs');

function writerHarness({ env = { OPENROUTER_API_KEY: 'key' }, stored = new Map(), setOk = true, reports = [], failReads = 0 } = {}) {
  const readFails = { count: failReads };
  assert.ok(writerStart > 0 && writerEnd > writerStart);
  const writes = [];
  const lines = [];
  const context = {
    newsCorroborationPromise: Promise.resolve(corroborationModule),
    crossWordingReports: reports,
    upstashGet: async (key, onFailure) => {
      if (readFails.count > 0) { readFails.count -= 1; onFailure?.('timeout'); return null; }
      return stored.get(key) ?? null;
    },
    upstashSet: async (key, value, ttl) => { writes.push({ key, value, ttl }); if (setOk) stored.set(key, value); return setOk; },
    upstashPipeline: async (commands) => { writes.push({ commands }); return commands.map(() => ({ result: 'OK' })); },
    process: { env }, console: { log: (l) => lines.push(l), warn: (...a) => lines.push(a.join(' ')) },
    Date, Number, Array, Boolean, JSON,
  };
  vm.createContext(context);
  vm.runInContext(relay.slice(writerStart, writerEnd), context);
  return { write: () => vm.runInContext('writeCrossWordingHealth()', context), writes, lines, stored, reports };
}

describe('relay cross-wording health write (#11426)', () => {
  it('writes the payload, then seed-meta, then the activation marker', async () => {
    const at = Date.now() - 60_000;
    const h = writerHarness({ reports: [{ at, checks: 3, matches: 0, failures: { EMBED_HTTP_402: 3 }, unchecked: 0 }] });
    await h.write();
    assert.deepEqual(h.writes.map((w) => w.key ?? w.commands[0].slice(0, 2).join(' ')), [
      'news:cross-wording-health:v1', 'seed-meta:news:cross-wording-health', 'SET seed-activated:news:cross-wording-health',
    ]);
    assert.equal(JSON.stringify(h.writes[2].commands), JSON.stringify([['SET', 'seed-activated:news:cross-wording-health', '1', 'NX']]));
    assert.equal(h.writes[0].ttl, 7 * 86_400);
    assert.equal(h.writes[1].ttl, 7 * 86_400);
    const meta = h.writes[1].value;
    assert.equal(meta.sourceState, 'degraded');
    assert.equal(meta.errorCode, 'EMBED_HTTP_402');
    assert.equal(meta.recordCount, 3);
    assert.match(h.lines.join('\n'), /\[news-corroboration\].*"health":"degraded".*EMBED_HTTP_402/);
  });

  it('reads unavailable on a relay without an OpenRouter key', async () => {
    const h = writerHarness({ env: {} });
    await h.write();
    assert.equal(h.writes[1].value.sourceState, 'unavailable');
  });

  it('keeps seed-meta and the marker when the payload write fails', async () => {
    const h = writerHarness({ setOk: false });
    await h.write();
    assert.deepEqual(h.writes.map((w) => w.key), ['news:cross-wording-health:v1']);
  });

  it('resumes the hour the previous process recorded, once', async () => {
    const earlier = Date.now() - 30 * 60_000;
    const stored = new Map([['news:cross-wording-health:v1', {
      reports: [{ at: earlier, checks: 2, matches: 0, failures: { JUDGE_HTTP_402: 2 }, unchecked: 0 }, 'junk'],
    }]]);
    const h = writerHarness({ stored, reports: [{ at: Date.now() - 60_000, checks: 1, matches: 0, failures: { JUDGE_HTTP_402: 1 }, unchecked: 0 }] });
    await h.write();
    assert.equal(h.writes[1].value.sourceState, 'degraded');
    assert.equal(h.writes[1].value.recordCount, 3);
    await h.write();
    assert.equal(h.reports.length, 2, 'the stored hour is read back only on the first write');
  });

  it('tries the resume again after a failed read', async () => {
    const stored = new Map([['news:cross-wording-health:v1', {
      reports: [{ at: Date.now() - 30 * 60_000, checks: 2, matches: 0, failures: { JUDGE_HTTP_402: 2 }, unchecked: 0 }],
    }]]);
    const h = writerHarness({ stored, failReads: 1 });
    await h.write();
    assert.equal(h.reports.length, 0);
    assert.deepEqual(h.writes, [], 'nothing overwrites the hour it could not read');
    await h.write();
    assert.equal(h.reports.length, 1, 'the second cycle resumes the stored hour');
    assert.equal(h.writes[1].value.sourceState, 'degraded', 'the saved failures still count');
  });

  it('is written from every exit of the classify cycle', () => {
    const start = relay.indexOf('async function seedClassify() {');
    const end = relay.indexOf('\n}\n', start);
    const body = relay.slice(start, end);
    const finallyAt = body.lastIndexOf('} finally {');
    assert.ok(finallyAt > 0, 'seedClassify has a finally block');
    assert.match(body.slice(finallyAt), /await writeCrossWordingHealth\(\);/);
    // The early exits sit inside the try, so they reach the finally.
    const tryAt = body.indexOf('try {');
    for (const exit of ['no LLM provider keys configured', 'not writing seed-meta:classify']) {
      const at = body.indexOf(exit);
      assert.ok(at > tryAt && at < finallyAt, exit);
    }
  });
});
