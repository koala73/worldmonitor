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
    crossWordingFamilies: async (candidates, { outcomes } = {}) => {
      checked.push(...candidates);
      outcomes?.push(...candidates.map(() => ({ result: 'matched' })));
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
    outcomes: () => vm.runInContext('crossWordingOutcomes', context),
  };
}

const titlesOf = (rows) => rows.map((row) => row.title);
const relayConstant = (name) => Number(relay.match(new RegExp(`const ${name} = (\\d+);`))[1]);

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

  it('collects every check outcome until the cycle writes them (#11426)', async () => {
    const h = harness();
    await h.run([{ title: 'first', level: 'critical' }]);
    await h.run([{ title: 'second', level: 'critical' }, { title: 'third', level: 'critical' }]);
    assert.equal(h.outcomes().length, 3);
  });

  it('writes the cycle health payload, then its seed-meta, then the activation marker (#11426)', async () => {
    const corroboration = await import('../scripts/lib/news-corroboration.mjs');
    const writeStart = relay.indexOf('async function writeCrossWordingHealth()');
    const writeEnd = relay.indexOf('\nasync function seedClassify()', writeStart);
    assert.ok(writeStart > 0 && writeEnd > writeStart);
    const writes = [];
    const load = ({ setOk = true, readFails = false, previous = null } = {}) => {
      const context = {
        newsCorroborationPromise: Promise.resolve(corroboration),
        crossWordingOutcomes: [{ result: 'failed', error: 'EMBED_HTTP_402' }, { result: 'failed', error: 'EMBED_HTTP_402' }],
        upstashGet: async (_key, onFailure) => { if (readFails) { onFailure('timeout'); return null; } return previous; },
        upstashSet: async (key, value, ttl) => { writes.push(['SET', key, value, ttl]); return setOk; },
        upstashPipeline: async (commands) => { writes.push(...commands); return commands.map(() => ({ result: 'OK' })); },
        process: { env: { OPENROUTER_API_KEY: 'stub' } }, console: { warn: () => {} }, Date, JSON, Math,
        CROSS_WORDING_OUTCOMES_MAX: relayConstant('CROSS_WORDING_OUTCOMES_MAX'),
      };
      vm.createContext(context);
      vm.runInContext(relay.slice(writeStart, writeEnd), context);
      return context;
    };
    const ctx = load();
    await vm.runInContext('writeCrossWordingHealth()', ctx);
    assert.deepEqual(writes.map((w) => w[1]), [corroboration.MATCHER_HEALTH_KEY, corroboration.MATCHER_HEALTH_META_KEY, corroboration.MATCHER_ACTIVATION_KEY]);
    assert.equal(writes[0][3], corroboration.MATCHER_HEALTH_TTL_SECONDS);
    assert.equal(writes[1][2].sourceState, 'degraded');
    assert.equal(writes[1][2].errorCode, 'EMBED_HTTP_402');
    assert.equal(ctx.crossWordingOutcomes.length, 0, 'each outcome counts in one cycle');
    for (const opts of [{ setOk: false }, { readFails: true }]) {
      writes.length = 0;
      const failed = load(opts);
      await vm.runInContext('writeCrossWordingHealth()', failed);
      assert.ok(!writes.some((w) => w[1] === corroboration.MATCHER_HEALTH_META_KEY), `no seed-meta without its payload: ${JSON.stringify(opts)}`);
      assert.equal(failed.crossWordingOutcomes.length, 2, `outcomes wait for a confirmed write: ${JSON.stringify(opts)}`);
      writes.length = 0;
      failed.upstashGet = async () => null;
      failed.upstashSet = async (key, value, ttl) => { writes.push(['SET', key, value, ttl]); return true; };
      await vm.runInContext('writeCrossWordingHealth()', failed);
      assert.equal(writes[0][2].failed, 2, `the retry counts each outcome once: ${JSON.stringify(opts)}`);
      assert.equal(failed.crossWordingOutcomes.length, 0);
    }
    const outage = load({ setOk: false });
    outage.crossWordingOutcomes = Array.from({ length: 100 }, (_, i) => ({ result: 'unmatched', i }));
    await vm.runInContext('writeCrossWordingHealth()', outage);
    assert.equal(outage.crossWordingOutcomes.length, relayConstant('CROSS_WORDING_OUTCOMES_MAX'), 'a long outage keeps a bounded queue');
    assert.equal(outage.crossWordingOutcomes.at(-1).i, 99, 'the newest outcomes stay');
  });

  it('keeps outcomes a build pass adds while the health write is in flight (#11426)', async () => {
    const corroboration = await import('../scripts/lib/news-corroboration.mjs');
    const writeStart = relay.indexOf('async function writeCrossWordingHealth()');
    const writeEnd = relay.indexOf('\nasync function seedClassify()', writeStart);
    const context = {
      newsCorroborationPromise: Promise.resolve(corroboration),
      crossWordingOutcomes: [{ result: 'matched' }],
      upstashGet: async () => null,
      upstashSet: async (key) => {
        if (key === corroboration.MATCHER_HEALTH_KEY) context.crossWordingOutcomes.push({ result: 'unmatched' });
        return true;
      },
      upstashPipeline: async (commands) => commands.map(() => ({ result: 'OK' })),
      process: { env: { OPENROUTER_API_KEY: 'stub' } }, console: { warn: () => {} }, Date, JSON, Math,
        CROSS_WORDING_OUTCOMES_MAX: relayConstant('CROSS_WORDING_OUTCOMES_MAX'),
    };
    vm.createContext(context);
    vm.runInContext(relay.slice(writeStart, writeEnd), context);
    await vm.runInContext('writeCrossWordingHealth()', context);
    assert.deepEqual(context.crossWordingOutcomes, [{ result: 'unmatched' }]);
  });

  it('writes the matcher health on a cycle with no classify provider (#11426)', async () => {
    const classifyStart = relay.indexOf('async function seedClassify()');
    const classifyEnd = relay.indexOf('\n}\n', classifyStart) + 3;
    assert.ok(classifyStart > 0 && classifyEnd > classifyStart);
    let writes = 0;
    const context = {
      classifyInFlight: false, CROSS_WORDING_MAX_CHECKS: 8, crossWordingChecksLeft: 0,
      CLASSIFY_LLM_PROVIDERS: [{ envKey: 'OPENROUTER_API_KEY' }], process: { env: {} },
      writeCrossWordingHealth: async () => { writes++; },
      console: { log: () => {}, warn: () => {} }, Date,
    };
    vm.createContext(context);
    vm.runInContext(relay.slice(classifyStart, classifyEnd), context);
    await vm.runInContext('seedClassify()', context);
    assert.equal(writes, 1, 'a keyless relay still reports NOT_CONFIGURED, not a silent probe');
    assert.equal(context.classifyInFlight, false);
  });

  it('adds nothing when the module failed to load', async () => {
    const h = harness({ module: false });
    assert.equal((await h.run([{ title: 'critical under the bar', level: 'critical' }])).size, 0);
  });
});
