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
let seq = 0;

before(() => {
  relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'stub-openrouter';
  relay.__resetBlockedLinkCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
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

function installHarness({ users = ['user-1'], verdict = '{"same": 1}', judgeStatus = 200, coverage = {} } = {}) {
  const zsets = new Map();
  // Publisher history per exact headline, as the digest writes it.
  for (const [title, families] of Object.entries(coverage)) {
    zsets.set(newsPublisherCoverageKey(title), new Map(families.map(f => [f, Date.now() - 60_000])));
  }
  const sets = new Map();
  const calls = { sends: [], judge: [], judgeBodies: [], embed: 0, anchorWrites: [] };
  const state = { users, verdict, judgeStatus };
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

  it('sends the rewrite to a user whose copy of the story is over 24 hours old', async () => {
    const h = installHarness();
    try {
      await relay.processEvent(alert(CNN));
      // user-1's receipt ages past the window while the anchor itself is kept
      // alive (here: re-sent to someone else, which refreshes the key's TTL).
      const anchorId = `full:${newsPublisherCoverageKey(CNN).split(':').pop()}`;
      const receipts = h.zsets.get(`news:alert-anchor-recipients:v1:${anchorId}`);
      assert.ok(receipts, 'receipts are kept per user with a time');
      receipts.set('user-1', Date.now() - 25 * 3_600_000);
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
