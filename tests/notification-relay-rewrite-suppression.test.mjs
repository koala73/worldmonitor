/**
 * #10916: a deliverable news alert that rewords one a user already received is
 * skipped for that user. Drives the real processEvent from
 * scripts/notification-relay.cjs with an in-memory Upstash, stubbed OpenRouter
 * embeddings and a stubbed same-development judge.
 *
 * Run: node --test tests/notification-relay-rewrite-suppression.test.mjs
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
  return originalLoad.call(this, request, parent, ...rest);
};

const { newsPublisherCoverageKey } = require('../scripts/shared/story-identity.js');

const CNN = 'Exclusive: US intel indicates Iran developing plans to potentially detonate a dirty bomb in Washington, sources say - CNN';
const SUN = 'Iran plots dirty bomb or chemical attack on US capital —report - SunOnline International';
const NDTV = "Iran Plans To Detonate 'Dirty Bomb' In Washington, Warns US Intel: Report";
const KYIV = 'Russian missiles hit two major Kyiv bridges, mayor says';

// One topic per vector; a headline about the dirty bomb lands on axis 0.
function vectorFor(text) {
  const v = new Array(512).fill(0);
  v[/dirty bomb/i.test(text) ? 0 : 1] = 1;
  return v;
}

let relay;
let originalFetch;
let originalKey;
let originalAnthropicKey;
let seq = 0;

before(() => {
  relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalKey = process.env.OPENROUTER_API_KEY;
  originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.OPENROUTER_API_KEY = 'stub-openrouter';
  // Each test that wants the direct route sets it; a developer's own key must
  // not reach a stubbed fetch.
  delete process.env.ANTHROPIC_API_KEY;
  relay.__resetBlockedLinkCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
});

function alert(title) {
  return {
    eventType: 'rss_alert',
    severity: 'critical',
    variant: 'full',
    publishedAt: Date.now(),
    // A per-run suffix keeps the relay's per-user title dedup from matching
    // across tests, which all share one stub Upstash.
    payload: { title, source: 'Test Wire', importanceScore: 83, corroborationCount: 1, link: `https://example.com/${++seq}` },
  };
}

function installHarness({ users = ['user-1'], verdict = '{"same": 1}', judgeStatus = 200, anthropicVerdict = null, anthropicStatus = 200, embedStatus = 200, coverage = {} } = {}) {
  const zsets = new Map();
  // Publisher history per exact headline, as the digest writes it.
  for (const [title, families] of Object.entries(coverage)) {
    zsets.set(newsPublisherCoverageKey(title), new Map(families.map(f => [f, Date.now() - 60_000])));
  }
  const sets = new Map();
  const calls = { sends: [], judge: [], judgeBodies: [], anthropicBodies: [], embed: 0, anchorWrites: [] };
  const state = { users, verdict, judgeStatus, anthropicVerdict, anthropicStatus, embedStatus };
  const logs = [];
  const orig = { log: console.log, warn: console.warn, info: console.info, error: console.error };
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  console.info = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));

  const run = ([cmd, key, ...args]) => {
    switch (cmd) {
      case 'ZREVRANGEBYSCORE': {
        const max = Number(args[0]);
        const min = Number(String(args[1]).replace('(', ''));
        const z = zsets.get(key) ?? new Map();
        const hits = [...z].filter(([, s]) => s <= max && s > min).sort((a, b) => b[1] - a[1]);
        return args.includes('WITHSCORES') ? hits.flatMap(([m, s]) => [m, String(s)]) : hits.map(([m]) => m);
      }
      case 'ZUNIONSTORE': {
        const [, a, b] = args;
        const merged = new Map(zsets.get(a) ?? []);
        for (const [m, sc] of zsets.get(b) ?? []) merged.set(m, Math.max(sc, merged.get(m) ?? -Infinity));
        zsets.set(key, merged);
        return merged.size;
      }
      case 'ZADD': {
        const z = zsets.get(key) ?? new Map();
        zsets.set(key, z);
        const nx = args[0] === 'NX';
        const pairs = nx ? args.slice(1) : args;
        let added = 0;
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          const [score, member] = [Number(pairs[i]), pairs[i + 1]];
          if (key.startsWith('news:alert-anchors:')) calls.anchorWrites.push(JSON.parse(member).title);
          if (!z.has(member)) added += 1;
          if (!nx || !z.has(member)) z.set(member, score);
        }
        return added;
      }
      case 'ZMSCORE': {
        const z = zsets.get(key) ?? new Map();
        return args.map(m => (z.has(m) ? String(z.get(m)) : null));
      }
      case 'SADD': {
        const s = sets.get(key) ?? new Set();
        sets.set(key, s);
        args.forEach(a => s.add(a));
        return args.length;
      }
      case 'SMISMEMBER': {
        const s = sets.get(key) ?? new Set();
        return args.map(a => (s.has(a) ? 1 : 0));
      }
      case 'ZRANGEBYSCORE': {
        const min = Number(String(args[0]).replace('(', ''));
        return [...(zsets.get(key) ?? [])].filter(([, sc]) => sc > min && sc <= Number(args[1])).map(([m]) => m);
      }
      case 'GET': return null;
      default: return 1;
    }
  };

  globalThis.fetch = async (url, opts = {}) => {
    const parsed = new URL(String(url));
    const host = parsed.hostname;
    const path = parsed.pathname;
    if (path.includes('/relay/enabled-rules')) {
      return { ok: true, json: async () => state.users.map(userId => ({ userId, digestMode: 'realtime', eventTypes: [], sensitivity: 'all', countries: [], tickers: [], channels: ['telegram'], variant: 'full' })) };
    }
    if (path.includes('/relay/entitlement')) return { ok: true, json: async () => ({ tier: 1 }) };
    if (path.includes('/relay/channels')) {
      const { userId } = JSON.parse(opts.body);
      return { ok: true, json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: `chat-${userId}` }] };
    }
    if (host === 'api.telegram.org') {
      calls.sends.push(JSON.parse(opts.body));
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    }
    if (host === 'openrouter.ai' && path.endsWith('/embeddings')) {
      calls.embed++;
      if (state.embedStatus !== 200) return { ok: false, status: state.embedStatus, json: async () => ({}) };
      const { input } = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ data: input.map((t, index) => ({ index, embedding: vectorFor(t) })) }) };
    }
    if (host === 'openrouter.ai' && path.endsWith('/chat/completions')) {
      const body = JSON.parse(opts.body);
      calls.judge.push(body.messages[1].content);
      calls.judgeBodies.push(body);
      if (state.judgeStatus !== 200) return { ok: false, status: state.judgeStatus, json: async () => ({}) };
      // An array gives each judge call its own reply, in order.
      const content = Array.isArray(state.verdict) ? state.verdict.shift() : state.verdict;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
    }
    if (host === 'api.anthropic.com') {
      const body = JSON.parse(String(opts.body));
      calls.anthropicBodies.push(body);
      if (state.anthropicStatus !== 200) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'down' } }), { status: state.anthropicStatus, headers: { 'content-type': 'application/json' } });
      }
      const text = Array.isArray(state.anthropicVerdict) ? state.anthropicVerdict.shift() : state.anthropicVerdict;
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 40, output_tokens: 6 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/pipeline') {
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => body.map(c => ({ result: run(c) })) };
    }
    if (path.includes('/SET/')) return { ok: true, json: async () => ({ result: 'OK' }) };
    return { ok: true, json: async () => ({ result: null }) };
  };

  return {
    calls, logs, state, zsets,
    sentTo: () => calls.sends.map(s => s.chat_id),
    record: () => {
      const line = logs.filter(l => l.startsWith('[news-alert-rewrite] {')).at(-1);
      return line ? JSON.parse(line.slice('[news-alert-rewrite] '.length)) : null;
    },
    restore() { Object.assign(console, orig); },
  };
}

describe('reworded news alerts (#10916)', () => {
  it('skips a reworded alert for a user who already had the story', async () => {
    const h = installHarness();
    try {
      await relay.processEvent(alert(CNN));
      assert.deepEqual(h.sentTo(), ['chat-user-1']);
      await relay.processEvent(alert(SUN));
      assert.deepEqual(h.sentTo(), ['chat-user-1'], 'the rewrite must not alert again');
      assert.equal(h.calls.judge.length, 2, 'one check asks the judge twice');
      assert.equal(h.calls.judge[0], h.calls.judge[1]);
      assert.match(h.calls.judge[0], /EARLIER:\n1\. \(under an hour earlier\) Exclusive: US intel/);
      assert.match(h.calls.judge[0], /NEW:\nIran plots dirty bomb/);
      const record = h.record();
      assert.equal(record.skippedUsers, 1);
      assert.equal(record.reachedUsers, 0);
      assert.ok(record.anchor && record.anchor.score > 0.99);
    } finally { h.restore(); }
  });

  // Gemini 2.5 Flash on a one-token answer called 10 of 21 rewrites of the
  // 2026-11-20 Russia-Poland strike new developments (10 emails for one
  // incident). The judge reasons now, so it needs a reasoning model, room to
  // reason and a schema that keeps the reply a bare {"same": N}: a reply cut at
  // the token limit is dropped by the chain, which keeps every alert.
  it('asks a reasoning model for a schema-bound verdict with room to reason', async () => {
    const { REWRITE_JUDGE_MODEL } = await import('../scripts/lib/news-alert-coverage.mjs');
    const h = installHarness();
    try {
      await relay.processEvent(alert(CNN));
      await relay.processEvent(alert(SUN));
      assert.equal(h.calls.judgeBodies.length, 2);
      const body = h.calls.judgeBodies[0];
      assert.equal(body.model, REWRITE_JUDGE_MODEL);
      assert.equal(body.model, 'anthropic/claude-sonnet-5.5');
      assert.deepEqual(body.reasoning, { effort: 'low' });
      assert.equal(body.response_format?.type, 'json_schema');
      assert.deepEqual(body.response_format.json_schema.schema, {
        type: 'object', properties: { same: { type: 'integer' } }, required: ['same'], additionalProperties: false,
      });
      assert.ok(body.max_tokens >= 1000, `max_tokens ${body.max_tokens} leaves no room to reason`);
      assert.equal(h.record().judgeModel, REWRITE_JUDGE_MODEL);
    } finally { h.restore(); }
  });

  it('still sends the rewrite to users the first alert never reached', async () => {
    const h = installHarness({ users: ['user-1'] });
    try {
      await relay.processEvent(alert(CNN));
      h.state.users = ['user-1', 'user-2'];
      await relay.processEvent(alert(SUN));
      assert.deepEqual(h.sentTo(), ['chat-user-1', 'chat-user-2']);
      assert.equal(h.record().skippedUsers, 1);
    } finally { h.restore(); }
  });

  for (const verdict of ['{"same": 1}', '{"same": 2}', ['{"same": 1}', '{"same": 2}'], ['{"same": 2}', '{"same": 1}']]) {
    it(`a third wording skips everyone who had either earlier one (verdict ${verdict})`, async () => {
      const h = installHarness({ users: ['user-1'] });
      try {
        await relay.processEvent(alert(CNN));
        h.state.users = ['user-1', 'user-2'];
        await relay.processEvent(alert(SUN));
        assert.deepEqual(h.sentTo(), ['chat-user-1', 'chat-user-2']);
        // Both earlier wordings are anchors now; whichever the judge names,
        // each user already had the story once.
        h.state.verdict = Array.isArray(verdict) ? [...verdict] : verdict;
        await relay.processEvent(alert(NDTV));
        assert.deepEqual(h.sentTo(), ['chat-user-1', 'chat-user-2']);
        assert.equal(h.record().skippedUsers, 2);
      } finally { h.restore(); }
    });
  }

  for (const verdict of [['{"same": 1}', '{"same": 2}'], ['{"same": 2}', '{"same": 1}']]) {
    it(`replies naming two separate earlier alerts skip only users who had both (verdict ${verdict.join(' / ')})`, async () => {
      const h = installHarness({ users: ['user-1'] });
      try {
        await relay.processEvent(alert(CNN));
        // Judged a separate development, so SUN is its own anchor and reached
        // only user-2: the two anchors keep separate recipients.
        h.state.users = ['user-2'];
        h.state.verdict = '{"same": 0}';
        await relay.processEvent(alert(SUN));
        assert.deepEqual(h.sentTo(), ['chat-user-1', 'chat-user-2']);
        h.state.users = ['user-1', 'user-2'];
        h.state.verdict = [...verdict];
        await relay.processEvent(alert(NDTV));
        // Each reply vouches for a different earlier alert; nobody had both.
        assert.deepEqual(h.sentTo(), ['chat-user-1', 'chat-user-2', 'chat-user-1', 'chat-user-2']);
        assert.equal(h.record().skippedUsers, 0);
        // Neither earlier alert is treated as the match, so no receipt crosses
        // from one to the other and no publisher history is merged.
        const recipients = title => [...(h.zsets.get(`news:alert-anchor-recipients:v1:full:${newsPublisherCoverageKey(title).split(':').pop()}`) ?? new Map()).keys()].sort();
        assert.deepEqual(recipients(CNN), ['user-1']);
        assert.deepEqual(recipients(SUN), ['user-2']);
        assert.equal(h.record().coverageMerged, false);
      } finally { h.restore(); }
    });
  }

  it('sends the rewrite to a user whose copy of the story is over 48 hours old', async () => {
    const h = installHarness();
    try {
      await relay.processEvent(alert(CNN));
      // user-1's receipt ages past the window while the anchor itself is kept
      // alive (here: re-sent to someone else, which refreshes the key's TTL).
      const anchorId = `full:${newsPublisherCoverageKey(CNN).split(':').pop()}`;
      const receipts = h.zsets.get(`news:alert-anchor-recipients:v1:${anchorId}`);
      assert.ok(receipts, 'receipts are kept per user with a time');
      receipts.set('user-1', Date.now() - 49 * 3_600_000);
      await relay.processEvent(alert(SUN));
      assert.deepEqual(h.sentTo(), ['chat-user-1', 'chat-user-1']);
      assert.equal(h.record().skippedUsers, 0);
    } finally { h.restore(); }
  });

  it('does not judge a headline the prompt would cut', async () => {
    const h = installHarness();
    try {
      await relay.processEvent(alert(CNN));
      await relay.processEvent(alert(`${SUN} ${'and more detail '.repeat(20)}then Iran fires missiles at the carrier`));
      assert.equal(h.calls.sends.length, 2);
      assert.equal(h.calls.judge.length, 0);
    } finally { h.restore(); }
  });

  it('counts the publishers of both wordings on the rewrite a new user receives', async () => {
    const h = installHarness({ coverage: { [CNN]: ['cnn', 'egypt-independent'], [SUN]: ['sun'] } });
    try {
      await relay.processEvent(alert(CNN));
      h.state.users = ['user-1', 'user-2'];
      await relay.processEvent(alert(SUN));
      assert.deepEqual(h.sentTo(), ['chat-user-1', 'chat-user-2']);
      assert.match(h.calls.sends[0].text, /Coverage: 2 independent publishers/);
      assert.match(h.calls.sends[1].text, /Coverage: 3 independent publishers/);
      const record = h.record();
      assert.equal(record.coverageMerged, true);
      assert.equal(record.judged, true);
      assert.equal(record.verdict, '{"same": 1} | {"same": 1}');
      assert.match(record.title, /^Iran plots dirty bomb/);
      assert.match(record.anchor.title, /^Exclusive: US intel/);
    } finally { h.restore(); }
  });

  it('a suppressed rewrite never becomes an anchor', async () => {
    const h = installHarness();
    try {
      await relay.processEvent(alert(CNN));
      await relay.processEvent(alert(SUN));
      await relay.processEvent(alert(NDTV));
      assert.deepEqual(h.calls.anchorWrites, [CNN]);
      assert.match(h.calls.judge[2], /EARLIER:\n1\. \(under an hour earlier\) Exclusive: US intel[^\n]*\n\nNEW:\nIran Plans To Detonate/);
      assert.deepEqual(h.sentTo(), ['chat-user-1']);
    } finally { h.restore(); }
  });

  // Sonnet merged Tusk's confirmation of the Poland strike into the earlier
  // "likely crossed into Poland" report in 1 of 8 runs. A skip needs both
  // replies to name the same earlier headline.
  for (const verdicts of [['{"same": 1}', '{"same": 0}'], ['{"same": 0}', '{"same": 1}'], ['{"same": 1}', 'They look similar.']]) {
    it(`sends when the two judge replies disagree (${verdicts.join(' / ')})`, async () => {
      const h = installHarness();
      try {
        await relay.processEvent(alert(CNN));
        h.state.verdict = [...verdicts];
        await relay.processEvent(alert(SUN));
        assert.equal(h.calls.judge.length, 2);
        assert.equal(h.calls.sends.length, 2, 'a split verdict keeps the alert');
        const record = h.record();
        assert.equal(record.anchor, null);
        assert.equal(record.skippedUsers, 0);
        assert.match(record.verdict, /\|/);
      } finally { h.restore(); }
    });
  }

  it('sends when the judge calls it a different development', async () => {
    const h = installHarness({ verdict: '{"same": 0}' });
    try {
      await relay.processEvent(alert(CNN));
      await relay.processEvent(alert(SUN));
      assert.equal(h.calls.sends.length, 2);
      assert.equal(h.record().anchor, null);
    } finally { h.restore(); }
  });

  it('does not ask the judge about an unrelated story', async () => {
    const h = installHarness();
    try {
      await relay.processEvent(alert(CNN));
      await relay.processEvent(alert(KYIV));
      assert.equal(h.calls.sends.length, 2);
      assert.equal(h.calls.judge.length, 0);
      assert.equal(h.record().candidates, 1);
    } finally { h.restore(); }
  });

  for (const [name, options] of [
    ['the judge fails', { judgeStatus: 500 }],
    ['the judge replies with something unreadable', { verdict: 'They look similar.' }],
    ['the judge names a headline it was not shown', { verdict: '{"same": 4}' }],
    ['the judge adds text around its answer', { verdict: '{"same": 1} because both cover the plot' }],
    ['the judge gives a fraction', { verdict: '{"same": 1.5}' }],
  ]) {
    it(`sends when ${name}`, async () => {
      const h = installHarness(options);
      try {
        await relay.processEvent(alert(CNN));
        await relay.processEvent(alert(SUN));
        assert.equal(h.calls.sends.length, 2);
      } finally { h.restore(); }
    });
  }

  // 2026-11-23 05:46Z: the OpenRouter account ran out of credit, every judge
  // call returned 402, and every rewrite went out again for the rest of the
  // morning (a 0.99 match on the Sudan drone strikes among them).
  it('asks Claude directly when OpenRouter refuses the judge', async () => {
    const h = installHarness({ judgeStatus: 402, anthropicVerdict: '{"same": 1}' });
    process.env.ANTHROPIC_API_KEY = 'stub-anthropic';
    try {
      await relay.processEvent(alert(CNN));
      await relay.processEvent(alert(SUN));
      assert.deepEqual(h.sentTo(), ['chat-user-1'], 'the rewrite must not alert again');
      assert.equal(h.calls.judgeBodies.length, 2, 'OpenRouter is still tried first');
      assert.equal(h.calls.anthropicBodies.length, 2, 'both replies come from the direct route');
      const body = h.calls.anthropicBodies[0];
      assert.equal(body.model, 'claude-sonnet-5-5');
      assert.deepEqual(body.output_config, {
        effort: 'low',
        format: { type: 'json_schema', schema: { type: 'object', properties: { same: { type: 'integer' } }, required: ['same'], additionalProperties: false } },
      });
      assert.equal(h.record().skippedUsers, 1);
      assert.equal(h.record().error, null);
    } finally { h.restore(); }
  });

  it('sends when OpenRouter and the direct route both fail', async () => {
    const h = installHarness({ judgeStatus: 402, anthropicStatus: 500 });
    process.env.ANTHROPIC_API_KEY = 'stub-anthropic';
    try {
      await relay.processEvent(alert(CNN));
      await relay.processEvent(alert(SUN));
      assert.equal(h.calls.sends.length, 2);
      assert.equal(h.record().error, 'judge returned nothing');
    } finally { h.restore(); }
  });

  // 2026-11-24: embeddings failed for two checks 50 minutes apart, so neither
  // wording of the Gaza security chief's killing was compared with anything
  // and both reached every subscriber. On 2026-11-23 the same failure sent 42.
  // Headlines that share words still go to the judge, which has its own
  // fallback to the Anthropic API.
  const GAZA = 'Israel kills Hamas internal security chief in Gaza';
  const BERNAMA = 'Gaza Internal Security Chief Killed In Israeli Air Strike – Interior Ministry - bernama';
  it('still judges a rewrite when embeddings fail, using shared words', async () => {
    const h = installHarness({ embedStatus: 502 });
    try {
      await relay.processEvent(alert(KYIV));
      await relay.processEvent(alert(GAZA));
      await relay.processEvent(alert(BERNAMA));
      assert.equal(h.calls.sends.length, 2, 'the second Gaza wording must not alert again');
      assert.match(h.calls.judge.at(-1), /EARLIER:\n1\. \(under an hour earlier\) Israel kills Hamas internal security chief in Gaza/);
      assert.doesNotMatch(h.calls.judge.at(-1), /Kyiv/, 'a headline that shares no words is not shown');
      const record = h.record();
      assert.equal(record.retrieval, 'words');
      assert.equal(record.embedError, 'EmbeddingProviderError: embedBatch: OpenRouter returned HTTP 502');
      assert.equal(record.error, null);
      assert.equal(record.skippedUsers, 1);
    } finally { h.restore(); }
  });

  it('reaches the direct judge when OpenRouter refuses both embeddings and the judge', async () => {
    process.env.ANTHROPIC_API_KEY = 'stub-anthropic';
    const h = installHarness({ embedStatus: 402, judgeStatus: 402, anthropicVerdict: '{"same": 1}' });
    try {
      await relay.processEvent(alert(GAZA));
      await relay.processEvent(alert(BERNAMA));
      assert.equal(h.calls.sends.length, 1);
      assert.equal(h.calls.anthropicBodies.length, 2);
      assert.equal(h.record().retrieval, 'words');
    } finally { h.restore(); }
  });

  it('does not ask the judge when embeddings fail and no earlier headline shares a word', async () => {
    const h = installHarness({ embedStatus: 502 });
    try {
      await relay.processEvent(alert(KYIV));
      await relay.processEvent(alert(GAZA));
      assert.equal(h.calls.sends.length, 2);
      assert.equal(h.calls.judge.length, 0);
      assert.equal(h.record().judged, false);
    } finally { h.restore(); }
  });

  it('sends every alert, and asks nothing, without the OpenRouter key', async () => {
    const h = installHarness();
    delete process.env.OPENROUTER_API_KEY;
    try {
      await relay.processEvent(alert(CNN));
      await relay.processEvent(alert(SUN));
      assert.equal(h.calls.sends.length, 2);
      assert.equal(h.calls.embed, 0);
      assert.equal(h.calls.judge.length, 0);
    } finally { h.restore(); }
  });

  it('leaves alerts below the realtime bar out of the check', async () => {
    const h = installHarness();
    try {
      await relay.processEvent(alert(CNN));
      const high = alert(SUN);
      high.severity = 'high';
      await relay.processEvent(high);
      assert.equal(h.calls.judge.length, 0);
      assert.equal(h.calls.embed, 0, 'an anchored story must not be embedded for a sighting nobody realtime gets');
    } finally { h.restore(); }
  });
});

// #11156: the Dymer strike near Kyiv on 2026-11-22 reached every subscriber
// six times. Each later wording's nearest earlier alert scored 0.53 to 0.58,
// under the 0.60 floor, so the judge never saw them.
describe('retrieval floor (#11156)', () => {
  const RESCUERS = 'Rescuers Race To Find Survivors Of Russian Attack On Apartment Near Kyiv; At Least 2 Killed';
  const DYMER = 'Death toll from Russian attack in Dymer rises to four – Zelensky';
  // Unit vectors whose cosine with the new headline's is the given score.
  const at = score => { const v = new Array(512).fill(0); v[0] = score; v[1] = Math.sqrt(1 - score * score); return v; };

  async function check(title, earlier, judge = async () => '{"same": 1}') {
    const lib = await import('../scripts/lib/news-alert-coverage.mjs');
    const now = Date.now();
    const raw = Object.keys(earlier).flatMap((t, i) => [JSON.stringify({ id: `full:earlier-${i}`, title: t }), String(now - (i + 1) * 3_600_000)]);
    const pipeline = async () => [{ result: raw }];
    const scores = [1, ...Object.values(earlier)];
    const embed = async titles => titles.map((_, i) => at(scores[i]));
    const prompts = [];
    const decision = await lib.findRewriteAnchor(alert(title), {
      now, pipeline, embed, judge: async (system, user, opts) => { prompts.push(user); return judge(system, user, opts); },
    });
    return { decision, prompts };
  }

  it('judges a rewording whose nearest earlier alert scores under 0.60', async () => {
    const { decision, prompts } = await check(DYMER, { [RESCUERS]: 0.53, 'Gaza death toll rises to 74,736': 0.3 });
    assert.equal(decision.judged, true);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /EARLIER:\n1\. \(1 hour earlier\) Rescuers Race/);
    assert.doesNotMatch(prompts[0], /Gaza/, 'a headline under 0.45 is not shown');
    assert.equal(decision.anchor?.title, RESCUERS);
  });

  it('does not show lower-scoring headlines when one clears 0.60', async () => {
    // A longer list of weaker wordings makes the judge readier to merge: at a
    // flat 0.45 floor it hid Putin's "painful response" threat (0.67).
    const { decision, prompts } = await check(DYMER, { 'Two killed as Russian attack destroys apartment building near Kyiv': 0.65, [RESCUERS]: 0.53 });
    assert.equal(decision.judged, true);
    assert.doesNotMatch(prompts[0], /Rescuers Race/);
    assert.match(prompts[0], /EARLIER:\n1\. .*Two killed/);
  });

  it('includes both floors themselves', async () => {
    const low = await check(DYMER, { [RESCUERS]: 0.45 });
    assert.equal(low.decision.judged, true, 'a score of exactly 0.45 is judged');
    const high = await check(DYMER, { 'Two killed as Russian attack destroys apartment building near Kyiv': 0.6, [RESCUERS]: 0.55 });
    assert.match(high.prompts[0], /Two killed/, 'a score of exactly 0.60 is shown');
    assert.doesNotMatch(high.prompts[0], /Rescuers Race/, 'a 0.60 candidate keeps the fallback off');
  });

  it('does not ask the judge when the nearest earlier alert scores under 0.45', async () => {
    const { decision, prompts } = await check(DYMER, { 'Israel steps up strikes across Middle East': 0.44 });
    assert.equal(decision.judged, false);
    assert.equal(prompts.length, 0);
    assert.equal(decision.best.score.toFixed(2), '0.44');
    assert.equal(decision.anchor, null);
  });

  // With the lower floor the judge saw "Russia fires about 100 missiles at
  // Ukraine, with one likely crossing into Poland" next to the mass attack it
  // belongs to, and called it a repeat in 13 of 16 runs.
  it('tells the judge that an attack reaching another country is a development', async () => {
    const { REWRITE_JUDGE_SYSTEM_PROMPT } = await import('../scripts/lib/news-alert-coverage.mjs');
    const newList = REWRITE_JUDGE_SYSTEM_PROMPT.split('It is a new development when')[1];
    assert.match(newList, /reaching another country/);
  });
});

describe('rewrite judge deadline', () => {
  // A reply after the check's deadline cannot change delivery, so the direct
  // route must not start once the check has given up.
  it('does not ask Claude directly after the check has expired', async () => {
    const lib = await import('../scripts/lib/news-alert-coverage.mjs');
    process.env.ANTHROPIC_API_KEY = 'stub-anthropic';
    const hosts = [];
    const aborted = [];
    globalThis.fetch = async (url, opts = {}) => {
      const host = new URL(String(url)).hostname;
      hosts.push(host);
      if (host === 'openrouter.ai') {
        opts.signal?.addEventListener('abort', () => aborted.push(host));
        // Hangs until the per-provider timeout aborts it.
        return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(opts.signal.reason)));
      }
      return new Response('{}', { status: 500 });
    };
    const now = Date.now();
    const anchor = JSON.stringify({ id: 'full:earlier', title: SUN });
    const pipeline = async () => [{ result: [anchor, String(now - 60_000)] }];
    const embed = async titles => titles.map(() => vectorFor('dirty bomb'));
    const orig = { log: console.log, warn: console.warn };
    console.log = () => {}; console.warn = () => {};
    try {
      const decision = await lib.findRewriteAnchor(alert(CNN), { now, pipeline, embed, deadlineMs: 300 });
      assert.equal(decision.error, 'deadline');
      // The OpenRouter attempts are cut at the check's deadline, not at their
      // own 8 s timeout, and the chain then starts nothing more.
      await new Promise(done => setTimeout(done, 1_000));
      assert.equal(aborted.length, 2, 'both OpenRouter attempts end at the deadline');
      assert.equal(hosts.includes('api.anthropic.com'), false, `hosts: ${hosts.join(',')}`);
    } finally { Object.assign(console, orig); }
  });

  // The judge's calls abort at deadlineAt, the instant the check's own timer
  // fires, so either can finish first. Empty replies that come back at or past
  // the deadline are the deadline's doing; earlier ones are the judge's. The
  // timer here is far off and the judge moves the clock, so neither case
  // depends on timer order.
  it('labels empty replies by the clock: deadline once it has passed, the judge before it', async () => {
    const lib = await import('../scripts/lib/news-alert-coverage.mjs');
    const realNow = Date.now;
    const now = realNow();
    const anchor = JSON.stringify({ id: 'full:earlier', title: SUN });
    const pipeline = async () => [{ result: [anchor, String(now - 60_000)] }];
    const embed = async titles => titles.map(() => vectorFor('dirty bomb'));
    const orig = { log: console.log, warn: console.warn };
    console.log = () => {}; console.warn = () => {};
    try {
      const deadlineMs = 60_000;
      const late = await lib.findRewriteAnchor(alert(CNN), {
        now, pipeline, embed, deadlineMs,
        judge: async (_system, _user, { deadlineAt }) => { Date.now = () => deadlineAt; return null; },
      });
      Date.now = realNow;
      assert.equal(late.error, 'deadline');
      assert.equal(late.judged, true);

      const early = await lib.findRewriteAnchor(alert(CNN), { now, pipeline, embed, deadlineMs, judge: async () => null });
      assert.equal(early.error, 'judge returned nothing');
    } finally {
      Date.now = realNow;
      Object.assign(console, orig);
    }
  });
});
