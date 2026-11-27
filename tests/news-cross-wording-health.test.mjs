// The cross-wording matcher's health (#11426). On 2026-11-23 the OpenRouter
// account ran out of credit; a cross-wording check failed on an embedding 402
// (tests/fixtures/alert-replays.json) and the matcher added nothing without
// leaving a trace. Each check that reaches a
// provider now records its outcome, the relay keeps the last hour of classify
// cycles, and /api/health warns when most of those checks failed.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EmbeddingProviderError, EmbeddingTimeoutError } from '../scripts/lib/brief-embedding.mjs';
import {
  JUDGE_DIRECT_MODEL,
  MATCHER_ACTIVATION_KEY,
  MATCHER_HEALTH_KEY,
  MATCHER_HEALTH_META_KEY,
  MATCHER_HEALTH_TTL_SECONDS,
  SIGHTINGS_KEY,
  crossWordingFamilies,
  matcherHealth,
  recordSightings,
} from '../scripts/lib/news-corroboration.mjs';
import { REWRITE_JUDGE_DIRECT_MODEL } from '../scripts/lib/news-alert-coverage.mjs';
import { __testing__ } from '../api/health.js';

const NOW = Date.parse('2026-11-23T06:00:00Z');
const MIN = 60_000;

function memoryPipeline() {
  const rows = [];
  const pipeline = async (commands) => commands.map(([cmd, key, ...args]) => {
    if (cmd === 'ZADD' && key === SIGHTINGS_KEY) {
      for (let i = 0; i < args.length; i += 2) rows.push({ at: Number(args[i]), member: args[i + 1] });
      return { result: args.length / 2 };
    }
    if (cmd === 'ZRANGEBYSCORE') {
      const min = Number(String(args[0]).replace('(', ''));
      return { result: rows.filter(r => r.at > min && r.at <= Number(args[1])).flatMap(r => [r.member, String(r.at)]) };
    }
    return { result: 0 };
  });
  return { pipeline };
}

const embed = async (titles) => titles.map(() => [1, 0]);
const http402 = async () => { throw new EmbeddingProviderError('embedBatch: OpenRouter returned HTTP 402', { status: 402 }); };

async function seeded() {
  const { pipeline } = memoryPipeline();
  await recordSightings([{ title: 'Drone strikes LPG tanker in Gulf of Oman', source: 'Reuters', level: 'critical' }], { now: NOW - MIN, pipeline });
  return pipeline;
}

const candidate = { title: 'Tanker struck by drone off Oman', source: 'Gulf News' };

describe('cross-wording matcher outcomes (#11426)', () => {
  it('records an embedding 402 as a failed check with its status', async () => {
    const outcomes = [];
    const found = await crossWordingFamilies([candidate], { now: NOW, pipeline: await seeded(), embed: http402, judge: async () => '{"same":true}', outcomes, log: () => {} });
    assert.equal(found.size, 0);
    assert.deepEqual(outcomes, [{ result: 'failed', error: 'EMBED_HTTP_402' }]);
  });

  it('records matched, unmatched, timeout, unreadable and deadline checks', async () => {
    const pipeline = await seeded();
    const run = async (opts) => {
      const outcomes = [];
      await crossWordingFamilies([candidate], { now: NOW, pipeline, embed, judge: async () => '{"same":true}', outcomes, log: () => {}, ...opts });
      return outcomes;
    };
    assert.deepEqual(await run({}), [{ result: 'matched' }]);
    assert.deepEqual(await run({ judge: async () => '{"same":false}' }), [{ result: 'unmatched' }]);
    assert.deepEqual(await run({ embed: async () => { throw new EmbeddingTimeoutError(); } }), [{ result: 'failed', error: 'EMBED_TIMEOUT' }]);
    assert.deepEqual(await run({ judge: async () => 'yes' }), [{ result: 'failed', error: 'JUDGE_UNREADABLE' }]);
    const slow = () => new Promise(done => setTimeout(() => done('{"same":true}'), 200));
    assert.deepEqual(await run({ judge: slow, deadlineMs: 20 }), [{ result: 'failed', error: 'DEADLINE' }]);
    assert.deepEqual(await run({ pipeline: async () => null }), [{ result: 'unread', error: 'SIGHTINGS_READ' }]);
  });

  it('counts the deadline against the check in flight, not the candidates it never started', async () => {
    const outcomes = [];
    const lines = [];
    const slow = () => new Promise(done => setTimeout(() => done('{"same":true}'), 200));
    const second = { title: 'Drone hits tanker near Fujairah', source: 'The National' };
    await crossWordingFamilies([candidate, second], { now: NOW, pipeline: await seeded(), embed, judge: slow, deadlineMs: 20, outcomes, log: (line) => lines.push(line) });
    assert.deepEqual(outcomes, [{ result: 'failed', error: 'DEADLINE' }]);
    assert.ok(lines.some(line => line.includes(second.title)), 'the unstarted candidate is still logged as unchecked');
  });

  it('counts no deadline when the expired step never reached a provider', async () => {
    const outcomes = [];
    await crossWordingFamilies([candidate], { now: NOW, pipeline: () => new Promise(() => {}), embed, judge: async () => '{"same":true}', deadlineMs: 20, outcomes, log: () => {} });
    assert.deepEqual(outcomes, []);
  });

  it('records one failed sightings read for the whole call, not one per candidate', async () => {
    const outcomes = [];
    const second = { title: 'Drone hits tanker near Fujairah', source: 'The National' };
    await crossWordingFamilies([candidate, second], { now: NOW, pipeline: async () => null, embed, judge: async () => '{"same":true}', outcomes, log: () => {} });
    assert.deepEqual(outcomes, [{ result: 'unread', error: 'SIGHTINGS_READ' }]);
  });

  it('records nothing for a candidate with nothing to compare against', async () => {
    const outcomes = [];
    const { pipeline } = memoryPipeline();
    await crossWordingFamilies([candidate], { now: NOW, pipeline, embed: http402, judge: async () => '{"same":true}', outcomes, log: () => {} });
    assert.deepEqual(outcomes, [], 'no provider was asked');
  });
});

describe('cross-wording judge falls back to the Anthropic API (#11426)', () => {
  let originalFetch, originalOpenRouter, originalAnthropic, calls;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalOpenRouter = process.env.OPENROUTER_API_KEY;
    originalAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.OPENROUTER_API_KEY = 'stub-openrouter';
    process.env.ANTHROPIC_API_KEY = 'stub-anthropic';
    calls = { openrouter: 0, anthropic: [] };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouter;
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
  });

  const stubFetch = ({ anthropicStatus = 200, text = '{"same": true}' } = {}) => {
    globalThis.fetch = async (url, opts = {}) => {
      const { hostname, pathname } = new URL(String(url));
      if (hostname === 'openrouter.ai' && pathname.endsWith('/chat/completions')) {
        calls.openrouter += 1;
        return { ok: false, status: 402, json: async () => ({}) };
      }
      if (hostname === 'api.anthropic.com') {
        const body = JSON.parse(String(opts.body));
        calls.anthropic.push(body);
        if (anthropicStatus !== 200) {
          return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'down' } }), { status: anthropicStatus, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 40, output_tokens: 6 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
  };

  it('asks the rewrite judge\'s direct model', () => {
    assert.equal(JUDGE_DIRECT_MODEL, REWRITE_JUDGE_DIRECT_MODEL);
  });

  it('matches through the Anthropic API when OpenRouter answers 402', async () => {
    stubFetch();
    const outcomes = [];
    const found = await crossWordingFamilies([candidate], { now: NOW, pipeline: await seeded(), embed, outcomes, log: () => {} });
    assert.ok(found.get(candidate.title), 'the direct reply counts');
    assert.equal(calls.openrouter, 1);
    assert.equal(calls.anthropic.length, 1);
    assert.equal(calls.anthropic[0].model, REWRITE_JUDGE_DIRECT_MODEL);
    assert.equal(calls.anthropic[0].output_config.format.type, 'json_schema', 'the reply is held to bare JSON');
    assert.deepEqual(outcomes, [{ result: 'matched' }]);
  });

  it('records the OpenRouter status when both routes fail', async () => {
    stubFetch({ anthropicStatus: 500 });
    const outcomes = [];
    const found = await crossWordingFamilies([candidate], { now: NOW, pipeline: await seeded(), embed, outcomes, log: () => {} });
    assert.equal(found.size, 0);
    assert.deepEqual(outcomes, [{ result: 'failed', error: 'JUDGE_HTTP_402' }]);
  });
});

const failed402 = { result: 'failed', error: 'EMBED_HTTP_402' };
const matched = { result: 'matched' };
const unmatched = { result: 'unmatched' };

// One classify cycle every 15 minutes, each with the given outcomes.
function cycles(perCycle, { start = NOW - 45 * MIN, configured = true } = {}) {
  let previous = null;
  let last = null;
  perCycle.forEach((outcomes, i) => {
    last = matcherHealth(previous, outcomes, { now: start + i * 15 * MIN, configured });
    previous = last.payload;
  });
  return last;
}

describe('cross-wording matcher window (#11426)', () => {
  it('is healthy when most checks in the last hour worked', () => {
    const { payload, meta } = cycles([[matched, unmatched], [failed402], [unmatched], [matched]]);
    assert.equal(meta.sourceState, 'ok');
    assert.equal(meta.recordCount, 4);
    assert.equal(meta.fetchedAt, NOW);
    assert.equal(meta.errorCode, undefined);
    assert.deepEqual({ checked: payload.checked, failed: payload.failed, matched: payload.matched }, { checked: 5, failed: 1, matched: 2 });
    assert.deepEqual(payload.errors, { EMBED_HTTP_402: 1 });
  });

  it('is degraded when most checks in the last hour failed, naming the commonest failure', () => {
    const { payload, meta } = cycles([[matched], [failed402, failed402], [{ result: 'failed', error: 'JUDGE_HTTP_402' }], [failed402]]);
    assert.equal(meta.sourceState, 'degraded');
    assert.equal(meta.errorCode, 'EMBED_HTTP_402');
    assert.equal(payload.degraded, true);
  });

  it('is healthy through an hour with no candidates', () => {
    const { payload, meta } = cycles([[], [], [], []]);
    assert.equal(meta.sourceState, 'ok');
    assert.equal(meta.recordCount, 4, 'every cycle counts, so a quiet hour is not empty');
    assert.equal(payload.checked, 0);
  });

  it('counts a failed sightings read once per cycle, apart from the provider checks', () => {
    const unread = { result: 'unread', error: 'SIGHTINGS_READ' };
    const { payload, meta } = cycles([[unread, unread], [unread], [unread], [unread, matched]]);
    assert.equal(meta.sourceState, 'ok', 'no provider was asked, so the provider rule does not fire');
    assert.equal(meta.errorCode, undefined);
    assert.equal(payload.checked, 1);
    assert.equal(payload.failed, 0);
    assert.deepEqual(payload.errors, {});
    assert.deepEqual(payload.readErrors, { SIGHTINGS_READ: 4 });
    assert.deepEqual(payload.cycles[0].readErrors, { SIGHTINGS_READ: 1 });
  });

  it('fires on two failed checks in a sparse hour, never on one', () => {
    assert.equal(cycles([[], [failed402], [], []]).meta.sourceState, 'ok');
    assert.equal(cycles([[], [failed402, failed402], [], []]).meta.sourceState, 'degraded');
    assert.equal(cycles([[failed402], [], [], [failed402]]).meta.sourceState, 'degraded');
  });

  it('drops cycles older than an hour', () => {
    const { payload, meta } = cycles([[failed402, failed402, failed402], [], [], [], [], [matched]]);
    assert.equal(meta.sourceState, 'ok');
    assert.equal(payload.cycles.length, 4);
    assert.ok(payload.cycles.every(c => c.at > NOW + 30 * MIN - 60 * MIN));
  });

  it('ignores a malformed previous payload', () => {
    const { meta } = matcherHealth({ cycles: 'x' }, [failed402], { now: NOW, configured: true });
    assert.equal(meta.recordCount, 1);
    assert.equal(matcherHealth({ cycles: [{ at: 'x' }, null] }, [], { now: NOW, configured: true }).meta.recordCount, 1);
  });

  it('reports a relay without an OpenRouter key as not configured', () => {
    assert.equal(cycles([[failed402, failed402]], { configured: false }).meta.sourceState, 'unavailable');
  });
});

describe('/api/health newsCrossWordingMatcher (#11426)', () => {
  const { classifyKey, STANDALONE_KEYS, SEED_META, ON_DEMAND_KEYS, ACTIVATION_MARKERS, collectFailureLogProblems } = __testing__;
  const name = 'newsCrossWordingMatcher';
  const HEALTH_NOW = NOW + MIN;

  const classify = ({ meta, data = true, activated = true } = {}) => classifyKey(name, STANDALONE_KEYS[name], { allowOnDemand: true }, {
    containmentEvidenceByName: new Map(),
    keyStrens: new Map(data ? [[STANDALONE_KEYS[name], 512]] : []),
    keyErrors: new Map(),
    keyMetaValues: new Map(meta ? [[SEED_META[name].key, JSON.stringify(meta)]] : []),
    keyMetaErrors: new Map(),
    activationStates: new Map([[name, activated]]),
    now: HEALTH_NOW,
  });

  it('is registered against the keys the relay writes', () => {
    assert.equal(STANDALONE_KEYS[name], MATCHER_HEALTH_KEY);
    assert.equal(SEED_META[name].key, MATCHER_HEALTH_META_KEY);
    assert.equal(SEED_META[name].maxStaleMin, 60);
    assert.equal(SEED_META[name].cutover.issue, 11426);
    assert.equal(ACTIVATION_MARKERS[name], MATCHER_ACTIVATION_KEY);
    assert.ok(ON_DEMAND_KEYS.has(name));
  });

  it('reads healthy, quiet, degraded, not-configured and stopped relays', () => {
    assert.equal(classify({ meta: cycles([[matched], [failed402], [unmatched], [matched]]).meta }).status, 'OK');
    assert.equal(classify({ meta: cycles([[], [], [], []]).meta }).status, 'OK');
    const degraded = classify({ meta: cycles([[failed402], [failed402], [failed402], [failed402]]).meta });
    assert.equal(degraded.status, 'SEED_ERROR');
    assert.equal(degraded.errorCode, 'EMBED_HTTP_402');
    assert.ok(collectFailureLogProblems({ [name]: degraded }, HEALTH_NOW).sigKeys.length > 0, 'a degraded matcher is an operational problem');
    assert.equal(classify({ meta: cycles([[failed402, failed402]], { configured: false }).meta }).status, 'NOT_CONFIGURED');
    const keyless = cycles([[]], { configured: false }).meta;
    assert.equal(classify({ meta: { ...keyless, fetchedAt: HEALTH_NOW - 59 * MIN } }).status, 'NOT_CONFIGURED');
    assert.equal(classify({ meta: { ...keyless, fetchedAt: HEALTH_NOW - 61 * MIN } }).status, 'STALE_SEED', 'a keyless relay that stopped reads stopped');
    assert.equal(classify({ meta: { ...cycles([[]]).meta, fetchedAt: HEALTH_NOW - 61 * MIN } }).status, 'STALE_SEED');
  });

  it('reads a relay that stopped while degraded as stale, not as a current failure', () => {
    const degraded = cycles([[failed402, failed402]]).meta;
    assert.equal(classify({ meta: { ...degraded, fetchedAt: HEALTH_NOW - 59 * MIN } }).status, 'SEED_ERROR');
    assert.equal(classify({ meta: { ...degraded, fetchedAt: HEALTH_NOW - 61 * MIN } }).status, 'STALE_SEED');
  });

  it('never contains a degraded matcher behind its own diagnostics', () => {
    const evidence = new Map();
    const entry = classifyKey(name, STANDALONE_KEYS[name], { allowOnDemand: true }, {
      containmentEvidenceByName: evidence,
      keyStrens: new Map([[STANDALONE_KEYS[name], 512]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[SEED_META[name].key, JSON.stringify(cycles([[failed402, failed402]]).meta)]]),
      keyMetaErrors: new Map(),
      activationStates: new Map([[name, true]]),
      now: HEALTH_NOW,
    });
    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(__testing__.isContainedHealthWarning(entry, evidence.get(name), HEALTH_NOW), false);
  });

  it('moves the overall /api/health verdict when the matcher degrades', async (t) => {
    const { default: handler } = await import('../api/health.js');
    const realEnv = { ...process.env };
    Object.assign(process.env, { UPSTASH_REDIS_REST_URL: 'https://mock-upstash.test', UPSTASH_REDIS_REST_TOKEN: 'mock-token' });
    t.after(() => {
      for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
        if (realEnv[key] === undefined) delete process.env[key]; else process.env[key] = realEnv[key];
      }
    });
    t.mock.method(Date, 'now', () => HEALTH_NOW);
    let matcherMeta = null;
    t.mock.method(globalThis, 'fetch', async (_url, init) => new Response(JSON.stringify(JSON.parse(init.body).map(([op, key]) => {
      if (op === 'STRLEN') return { result: 256 };
      if (op === 'GET' && key === MATCHER_HEALTH_META_KEY) return { result: JSON.stringify(matcherMeta) };
      if (op === 'GET' && key.startsWith('seed-meta:')) return { result: JSON.stringify({ fetchedAt: HEALTH_NOW, recordCount: 1 }) };
      if (op === 'GET') return { result: null };
      if (op === 'LLEN') return { result: 1 };
      return { result: 'OK' };
    }))));
    const read = async () => (await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'))).json();
    matcherMeta = cycles([[matched], [matched]]).meta;
    const healthy = await read();
    assert.equal(healthy.problems?.[name], undefined);
    matcherMeta = cycles([[failed402, failed402]]).meta;
    const degraded = await read();
    assert.equal(degraded.problems[name].status, 'SEED_ERROR');
    assert.equal(degraded.summary.warn, healthy.summary.warn + 1);
    assert.equal(degraded.summary.containedWarn, healthy.summary.containedWarn, 'the warning counts against availability');
    const { computeOverallStatus } = __testing__;
    const zero = { warn: 0, containedWarn: 0, onDemandWarn: 0, crit: 0 };
    assert.equal(computeOverallStatus(zero, degraded.summary.total).overall, 'HEALTHY');
    assert.equal(computeOverallStatus({ ...zero, warn: 1 }, degraded.summary.total).overall, 'WARNING',
      'alone, an uncontained matcher warning turns a healthy platform WARNING');
  });

  it('keeps a relay stopped for hours a warning, not a critical', () => {
    const stoppedAt = HEALTH_NOW - 6 * 60 * MIN;
    const payloadAlive = MATCHER_HEALTH_TTL_SECONDS * 1_000 > HEALTH_NOW - stoppedAt;
    assert.equal(classify({ data: payloadAlive, meta: { ...cycles([[]]).meta, fetchedAt: stoppedAt } }).status, 'STALE_SEED');
  });

  it('waits for the first write before alarming on absence', () => {
    assert.equal(classify({ data: false, activated: false }).status, 'EMPTY_ON_DEMAND');
    assert.equal(classify({ data: false, activated: true }).status, 'EMPTY');
  });
});
