// Cross-wording matcher health (#11426). On 2026-11-23 the OpenRouter account
// ran out of credit, every embedding and judge call returned 402, and the
// matcher failed every check without a trace. Each call now reports what its
// checks did; the relay turns the last hour of reports into a health key, and
// the judge asks the Anthropic API when OpenRouter refuses it.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingProviderError, EmbeddingTimeoutError } from '../scripts/lib/brief-embedding.mjs';
import {
  CROSS_WORDING_HEALTH_WINDOW_MS,
  SIGHTINGS_KEY,
  crossWordingFamilies,
  recordSightings,
  summarizeCrossWordingHealth,
} from '../scripts/lib/news-corroboration.mjs';

const NOW = Date.parse('2026-11-23T06:00:00Z');

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
  return { rows, pipeline };
}

const embed = async (titles) => titles.map(t => (/tanker|vessel|ship/i.test(t) ? [1, 0.1] : [0, 1]));
const yes = async () => '{"same":true}';
const quiet = () => {};

async function seeded() {
  const store = memoryPipeline();
  await recordSightings([
    { title: 'Drone strikes LPG tanker in Gulf of Oman', source: 'Reuters', level: 'critical' },
  ], { now: NOW - 60_000, pipeline: store.pipeline });
  return store;
}

const TWO = [
  { title: 'Tanker struck by drone off Oman', source: 'Gulf News' },
  { title: 'LPG vessel hit near Oman coast', source: 'The National' },
];

async function reportOf(candidates, opts) {
  let report = null;
  const found = await crossWordingFamilies(candidates, { now: NOW, log: quiet, ...opts, report: (r) => { report = r; } });
  return { found, report };
}

describe('cross-wording matcher outcomes (#11426)', () => {
  it('reports each refused embedding by its HTTP status', async () => {
    const { pipeline } = await seeded();
    const refused = async () => { throw new EmbeddingProviderError('embedBatch: OpenRouter returned HTTP 402', { status: 402 }); };
    const { report } = await reportOf(TWO, { pipeline, embed: refused, judge: yes });
    assert.deepEqual(report, { checks: 2, matches: 0, failures: { EMBED_HTTP_402: 2 }, unchecked: 0 });
  });

  it('names an embedding timeout and an embedding error without a status', async () => {
    const { pipeline } = await seeded();
    const timeout = async () => { throw new EmbeddingTimeoutError(); };
    assert.deepEqual((await reportOf(TWO.slice(0, 1), { pipeline, embed: timeout, judge: yes })).report.failures, { EMBED_TIMEOUT: 1 });
    const malformed = async () => { throw new EmbeddingProviderError('embedBatch: malformed response'); };
    assert.deepEqual((await reportOf(TWO.slice(0, 1), { pipeline, embed: malformed, judge: yes })).report.failures, { EMBED_ERROR: 1 });
  });

  it('counts a check that reached the provider, matched or not', async () => {
    const { pipeline } = await seeded();
    const { report } = await reportOf([
      ...TWO.slice(0, 1),
      // Embedded, but nothing close enough to judge.
      { title: 'Parliament passes budget after long debate', source: 'BBC' },
    ], { pipeline, embed, judge: yes });
    assert.deepEqual(report, { checks: 2, matches: 1, failures: {}, unchecked: 0 });
  });

  it('does not count a candidate with nothing to compare against', async () => {
    const { pipeline } = memoryPipeline();
    let embedded = false;
    const { report } = await reportOf(TWO, { pipeline, embed: async (t) => { embedded = true; return embed(t); }, judge: yes });
    assert.equal(embedded, false);
    assert.deepEqual(report, { checks: 0, matches: 0, failures: {}, unchecked: 0 });
  });

  it('reports an empty call', async () => {
    const { report } = await reportOf([], { pipeline: memoryPipeline().pipeline, embed, judge: yes });
    assert.deepEqual(report, { checks: 0, matches: 0, failures: {}, unchecked: 0 });
  });

  it('counts an unreadable verdict', async () => {
    const { pipeline } = await seeded();
    const { report } = await reportOf(TWO.slice(0, 1), { pipeline, embed, judge: async () => 'yes' });
    assert.deepEqual(report.failures, { JUDGE_UNREADABLE: 1 });
  });

  it('fails only the check the deadline cut short; candidates it never reached are unchecked', async () => {
    const { pipeline } = await seeded();
    const slow = () => new Promise(done => setTimeout(() => done('{"same":true}'), 200));
    const { report } = await reportOf(TWO, { pipeline, embed, judge: slow, deadlineMs: 20 });
    assert.deepEqual(report, { checks: 1, matches: 0, failures: { DEADLINE: 1 }, unchecked: 1 });
  });

  it('counts a failed sightings read once per call', async () => {
    const { report } = await reportOf(TWO, { pipeline: async () => null, embed, judge: yes });
    assert.deepEqual(report, { checks: 1, matches: 0, failures: { SIGHTINGS_READ: 1 }, unchecked: 0 });
  });
});

describe('cross-wording judge fallback (#11426)', () => {
  let saved;
  let calls;
  let state;
  beforeEach(() => {
    saved = { fetch: globalThis.fetch, openrouter: process.env.OPENROUTER_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, warn: console.warn, log: console.log };
    process.env.OPENROUTER_API_KEY = 'stub-openrouter';
    process.env.ANTHROPIC_API_KEY = 'stub-anthropic';
    console.warn = () => {};
    console.log = () => {};
    calls = { openrouter: [], anthropic: [] };
    state = { openrouterStatus: 402, anthropicStatus: 200, anthropicText: '{"same":true}' };
    globalThis.fetch = async (url, opts = {}) => {
      const { host } = new URL(typeof url === 'string' ? url : url.url);
      if (host === 'openrouter.ai') {
        calls.openrouter.push(JSON.parse(opts.body));
        if (state.openrouterStatus !== 200) return new Response('{}', { status: state.openrouterStatus });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"same":true}' }, finish_reason: 'stop' }] }), { status: 200 });
      }
      if (host === 'api.anthropic.com') {
        const body = JSON.parse(String(opts.body));
        calls.anthropic.push(body);
        if (state.anthropicStatus !== 200) {
          return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'down' } }), { status: state.anthropicStatus, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: state.anthropicText }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 40, output_tokens: 6 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    };
  });
  afterEach(() => {
    globalThis.fetch = saved.fetch;
    console.warn = saved.warn;
    console.log = saved.log;
    for (const [name, value] of [['OPENROUTER_API_KEY', saved.openrouter], ['ANTHROPIC_API_KEY', saved.anthropic]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('asks Claude directly when OpenRouter refuses the judge', async () => {
    const { pipeline } = await seeded();
    const { found, report } = await reportOf(TWO.slice(0, 1), { pipeline, embed });
    assert.equal(calls.openrouter.length, 1, 'OpenRouter is still tried first');
    assert.equal(calls.openrouter[0].model, 'google/gemini-2.5-flash', 'the OpenRouter request is unchanged');
    assert.equal(calls.openrouter[0].response_format, undefined);
    assert.equal(calls.anthropic.length, 1);
    assert.equal(calls.anthropic[0].model, 'claude-sonnet-5-5');
    assert.deepEqual(calls.anthropic[0].output_config, {
      effort: 'low',
      format: { type: 'json_schema', schema: { type: 'object', properties: { same: { type: 'boolean' } }, required: ['same'], additionalProperties: false } },
    });
    assert.ok(found.get(TWO[0].title), 'the direct verdict corroborates');
    assert.deepEqual(report, { checks: 1, matches: 1, failures: {}, unchecked: 0 });
  });

  it('reports the OpenRouter refusal when the direct route fails too', async () => {
    state.anthropicStatus = 500;
    const { pipeline } = await seeded();
    const { found, report } = await reportOf(TWO.slice(0, 1), { pipeline, embed });
    assert.equal(found.size, 0);
    assert.deepEqual(report.failures, { JUDGE_HTTP_402: 1 });
  });

  it('reports the OpenRouter refusal when the relay has no Anthropic key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { pipeline } = await seeded();
    const { report } = await reportOf(TWO.slice(0, 1), { pipeline, embed });
    assert.equal(calls.anthropic.length, 0);
    assert.deepEqual(report.failures, { JUDGE_HTTP_402: 1 });
  });
});

describe('cross-wording matcher health summary (#11426)', () => {
  const at = (minutesAgo, outcome) => ({ at: NOW - minutesAgo * 60_000, checks: 0, matches: 0, failures: {}, unchecked: 0, ...outcome });

  it('alarms with the most frequent code when most checks of the hour failed', () => {
    const { payload, meta } = summarizeCrossWordingHealth([
      at(50, { checks: 2, failures: { EMBED_HTTP_402: 2 } }),
      at(20, { checks: 2, matches: 1, failures: { JUDGE_HTTP_402: 1 } }),
    ], { now: NOW, configured: true });
    assert.deepEqual(meta, { fetchedAt: NOW, recordCount: 4, sourceState: 'degraded', errorCode: 'EMBED_HTTP_402' });
    assert.equal(payload.checks, 4);
    assert.equal(payload.failed, 3);
    assert.equal(payload.matches, 1);
    assert.deepEqual(payload.failures, { EMBED_HTTP_402: 2, JUDGE_HTTP_402: 1 });
    assert.equal(payload.windowMinutes, 60);
  });

  it('stays OK at exactly half of the checks failing', () => {
    const { meta } = summarizeCrossWordingHealth([
      at(30, { checks: 4, failures: { EMBED_HTTP_402: 2 } }),
    ], { now: NOW, configured: true });
    assert.equal(meta.sourceState, 'ok');
    assert.equal(meta.errorCode, undefined);
  });

  it('stays OK for a single failed check in an hour', () => {
    const { meta } = summarizeCrossWordingHealth([at(10, { checks: 1, failures: { EMBED_TIMEOUT: 1 } })], { now: NOW, configured: true });
    assert.equal(meta.sourceState, 'ok');
  });

  it('stays OK with no checks, and for candidates the budget left unchecked', () => {
    const { payload, meta } = summarizeCrossWordingHealth([at(10, { unchecked: 12 }), at(5, {})], { now: NOW, configured: true });
    assert.deepEqual(meta, { fetchedAt: NOW, recordCount: 0, sourceState: 'ok' });
    assert.equal(payload.unchecked, 12);
  });

  it('forgets cycles older than the hour', () => {
    const { meta } = summarizeCrossWordingHealth([
      at(CROSS_WORDING_HEALTH_WINDOW_MS / 60_000 + 1, { checks: 5, failures: { EMBED_HTTP_402: 5 } }),
      at(5, { checks: 1 }),
    ], { now: NOW, configured: true });
    assert.deepEqual(meta, { fetchedAt: NOW, recordCount: 1, sourceState: 'ok' });
  });

  it('breaks a tie between codes by name, so the code is stable', () => {
    const { meta } = summarizeCrossWordingHealth([
      at(5, { checks: 2, failures: { JUDGE_HTTP_402: 1, EMBED_HTTP_402: 1 } }),
    ], { now: NOW, configured: true });
    assert.equal(meta.errorCode, 'EMBED_HTTP_402');
  });

  it('reads unavailable without an OpenRouter key', () => {
    const { payload, meta } = summarizeCrossWordingHealth([], { now: NOW, configured: false });
    assert.equal(meta.sourceState, 'unavailable');
    assert.equal(payload.configured, false);
  });
});

describe('newsCrossWordingMatcher health probe (#11426)', async () => {
  const { __testing__: health } = await import('../api/health.js');
  const {
    CROSS_WORDING_HEALTH_ACTIVATION_KEY, CROSS_WORDING_HEALTH_KEY, CROSS_WORDING_HEALTH_META_KEY,
  } = await import('../scripts/lib/news-corroboration.mjs');

  function classify({ payload = true, meta, activated = true, now = NOW }) {
    const entry = health.classifyKey('newsCrossWordingMatcher', CROSS_WORDING_HEALTH_KEY, { allowOnDemand: true }, {
      keyStrens: new Map([[CROSS_WORDING_HEALTH_KEY, payload ? 200 : 0]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[CROSS_WORDING_HEALTH_META_KEY, meta == null ? null : JSON.stringify(meta)]]),
      keyMetaErrors: new Map(),
      activationStates: new Map([['newsCrossWordingMatcher', activated]]),
      now,
    });
    return { ...entry, bucket: health.healthStatusBucket(entry, now) };
  }
  const metaOf = (reports, opts = {}) => summarizeCrossWordingHealth(reports, { now: NOW, configured: true, ...opts }).meta;

  it('is registered as a standalone, activation-marked probe the relay writes', () => {
    assert.equal(health.STANDALONE_KEYS.newsCrossWordingMatcher, CROSS_WORDING_HEALTH_KEY);
    assert.deepEqual(health.SEED_META.newsCrossWordingMatcher, {
      key: CROSS_WORDING_HEALTH_META_KEY, maxStaleMin: 60,
      activationKey: CROSS_WORDING_HEALTH_ACTIVATION_KEY,
      cutover: { mode: 'activation-marker', fromKey: null, issue: 11426, activationKey: CROSS_WORDING_HEALTH_ACTIVATION_KEY },
    });
    assert.equal(health.ON_DEMAND_KEYS.has('newsCrossWordingMatcher'), true);
    assert.equal(health.ACTIVATION_MARKERS.newsCrossWordingMatcher, CROSS_WORDING_HEALTH_ACTIVATION_KEY);
  });

  it('reads OK for an hour with no checks', () => {
    assert.equal(classify({ meta: metaOf([]) }).status, 'OK');
  });

  it('reads OK when half of the checks failed', () => {
    assert.equal(classify({ meta: metaOf([{ at: NOW - 60_000, checks: 4, matches: 0, failures: { EMBED_HTTP_402: 2 }, unchecked: 0 }]) }).status, 'OK');
  });

  it('warns SEED_ERROR with the failure code when most checks failed', () => {
    const entry = classify({ meta: metaOf([{ at: NOW - 60_000, checks: 3, matches: 0, failures: { EMBED_HTTP_402: 3 }, unchecked: 0 }]) });
    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(entry.errorCode, 'EMBED_HTTP_402');
    assert.equal(entry.bucket, 'warn');
  });

  it('reads NOT_CONFIGURED on a relay without an OpenRouter key', () => {
    const entry = classify({ meta: metaOf([], { configured: false }) });
    assert.equal(entry.status, 'NOT_CONFIGURED');
    assert.equal(entry.bucket, 'ok');
  });

  it('reads STALE_SEED once the relay stops writing for an hour', () => {
    const entry = classify({ meta: metaOf([]), now: NOW + 61 * 60_000 });
    assert.equal(entry.status, 'STALE_SEED');
    assert.equal(entry.bucket, 'warn');
  });

  it('does not alarm before the relay first writes', () => {
    assert.notEqual(classify({ payload: false, meta: null, activated: false }).bucket, 'crit');
  });
});

describe('cross-wording results are unchanged by the reports (#11426)', () => {
  it('returns nothing for a candidate with two publishers when no wording is close enough', async () => {
    const { pipeline } = await seeded();
    const { found, report } = await reportOf(
      [{ title: 'Parliament passes budget after long debate', source: 'BBC', families: ['bbc', 'reuters-x'] }],
      { pipeline, embed, judge: yes },
    );
    assert.equal(found.size, 0);
    assert.deepEqual(report, { checks: 1, matches: 0, failures: {}, unchecked: 0 });
  });
});
