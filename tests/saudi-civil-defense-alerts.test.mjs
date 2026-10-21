import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { publishSaudiCivilDefenseAlerts } = require('../scripts/lib/saudi-civil-defense-alerts.cjs');
const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-15T10:00:00Z');
const post = (overrides = {}) => ({
  id: 'SaudiDCD:123', channel: 'SaudiDCD', channelTitle: 'Mutable title',
  ts: new Date(NOW - 60_000).toISOString(),
  text: 'تحذير عاجل: يجب إخلاء المنطقة المتضررة من السيول الآن.',
  ...overrides,
});
function harness(overrides = {}) {
  const cache = new Map();
  const events = [];
  const classified = [];
  const deps = {
    now: () => NOW,
    readCache: async (key) => cache.get(key),
    writeCache: async (key, value) => cache.set(key, value),
    classify: async (titles) => {
      classified.push(titles);
      return titles.map((_, i) => ({ i, l: 'high', c: 'disaster' }));
    },
    publish: async (event) => events.push(event),
    ...overrides,
  };
  return { deps, events, classified, cache };
}

describe('Saudi Civil Defense notification producer', () => {
  it('sends the full post to the provider while retaining the default RSS text limit', async () => {
    const start = relay.indexOf('function classifyFetchLlmSingle(');
    const end = relay.indexOf('\nasync function classifyFetchLlm(', start);
    const bodies = [];
    const transport = { request: (_url, _options, response) => ({
      on() {},
      end(body) {
        bodies.push(JSON.parse(body));
        response({ statusCode: 200, on(event, callback) {
          if (event === 'data') callback(JSON.stringify({ choices: [{ message: { content: '[{"i":0,"l":"info","c":"general"}]' } }] }));
          if (event === 'end') callback();
        } });
      },
    }) };
    const context = { URL, Buffer, http: transport, https: transport, CLASSIFY_SYSTEM_PROMPT: 'fixture' };
    vm.createContext(context);
    vm.runInContext(relay.slice(start, end), context);
    const text = 'x'.repeat(3000);
    await context.classifyFetchLlmSingle([text], '', 'https://provider.example', 'fixture', {}, {}, 1000, 4096);
    await context.classifyFetchLlmSingle([text], '', 'https://provider.example', 'fixture', {}, {}, 1000);
    assert.equal(bodies[0].messages[1].content, `0|${text}`);
    assert.equal(bodies[1].messages[1].content, `0|${text.slice(0, 200)}`);
  });

  it('retains complete Saudi posts at ingestion without changing other channels', () => {
    const start = relay.indexOf('function normalizeTelegramMessage(');
    const end = relay.indexOf('\nfunction sanitizeTelegramUsername(', start);
    const context = {
      SAUDI_CIVIL_DEFENSE: { handle: 'SaudiDCD' }, MAX_POST_CHARS: 4096,
      TELEGRAM_MAX_TEXT_CHARS: 800, sanitizeTelegramUsername: (handle) => handle,
    };
    vm.createContext(context);
    vm.runInContext(relay.slice(start, end), context);
    const msg = { id: 123, date: NOW / 1000, message: 'x'.repeat(3000) };
    const official = context.normalizeTelegramMessage(msg, { handle: 'SaudiDCD' });
    assert.equal(official.text.length, 3000);
    assert.equal(official.textTruncated, false);
    assert.equal(context.normalizeTelegramMessage({ ...msg, date: undefined }, { handle: 'SaudiDCD' }).ts, '');
    assert.equal(context.normalizeTelegramMessage(msg, { handle: 'Other' }).text.length, 800);
    assert.equal(context.normalizeTelegramMessage({ ...msg, message: 'x'.repeat(4097) }, { handle: 'SaudiDCD' }).textTruncated, true);
  });

  it('preserves Arabic text, canonical source, permalink and country scope', async () => {
    const h = harness();
    await publishSaudiCivilDefenseAlerts([post({ channel: 'saudidcd', url: 'https://untrusted.example/' })], h.deps);
    assert.equal(h.events.length, 1);
    assert.deepEqual(h.events[0], {
      eventType: 'rss_alert', severity: 'high', variant: 'full',
      payload: {
        title: post().text, source: 'Saudi Civil Defense', link: 'https://t.me/SaudiDCD/123',
        publishedAt: NOW - 60_000, countryCode: 'SA', corroborationCount: 1,
        coalesceKey: 'telegram:saudidcd:123',
      },
    });
  });

  it('rejects unregistered lookalikes, stale/future/invalid dates, media-only and truncated posts', async () => {
    const h = harness();
    await publishSaudiCivilDefenseAlerts([
      post({ channel: 'fake', channelTitle: 'Saudi Civil Defense' }),
      post({ ts: new Date(NOW - 900_001).toISOString() }),
      post({ ts: new Date(NOW + 1).toISOString() }), post({ ts: '' }),
      post({ text: ' ' }), post({ textTruncated: true }), post({ text: 'x'.repeat(4097) }),
      post({ id: 'fake:123' }), post({ id: 'SaudiDCD:0' }),
    ], h.deps);
    assert.equal(h.classified.length, 0);
    assert.equal(h.events.length, 0);
  });

  it('classifies complete long posts in one batch and emits only high/critical results', async () => {
    const titles = ['Routine notice ', 'Medium notice ', 'High notice ', 'Critical notice '].map((text) => text.repeat(70));
    const h = harness({ classify: async (texts) => {
      assert.deepEqual(texts, titles.map((text) => text.trim()));
      return ['info', 'medium', 'high', 'critical'].map((l, i) => ({ i, l, c: 'general' }));
    } });
    await publishSaudiCivilDefenseAlerts(titles.map((text, i) => post({ id: `SaudiDCD:${i + 1}`, text })), h.deps);
    assert.deepEqual(h.events.map((event) => event.severity), ['high', 'critical']);
    assert.ok(h.events.every((event) => event.payload.title.length === 500));
  });

  it('fails closed on missing, malformed, duplicate or invalid classification entries', async () => {
    for (const result of [null, {}, [], [{ i: 0, l: 'urgent' }], [{ i: 0.5, l: 'high' }], [{ i: 1, l: 'high' }], [{ i: 0, l: 'high' }, { i: 0, l: 'info' }]]) {
      const h = harness({ classify: async () => result });
      await publishSaudiCivilDefenseAlerts([post()], h.deps);
      assert.equal(h.events.length, 0);
    }
  });

  it('rechecks freshness after slow classification', async () => {
    let clock = NOW;
    const h = harness({ now: () => clock, classify: async () => {
      clock += 900_000;
      return [{ i: 0, l: 'critical' }];
    } });
    await publishSaudiCivilDefenseAlerts([post()], h.deps);
    assert.equal(h.events.length, 0);
  });

  it('deduplicates input and retries cached high classifications through the publisher', async () => {
    const h = harness();
    await publishSaudiCivilDefenseAlerts([post(), post()], h.deps);
    await publishSaudiCivilDefenseAlerts([post()], h.deps);
    assert.equal(h.classified.length, 1);
    assert.equal(h.events.length, 2);
    assert.equal(h.events[0].payload.coalesceKey, h.events[1].payload.coalesceKey);
  });

  it('retries a failed classification without storing an alert decision', async () => {
    const h = harness();
    await publishSaudiCivilDefenseAlerts([post()], { ...h.deps, classify: async () => null });
    assert.equal(h.cache.size, 0);
    await publishSaudiCivilDefenseAlerts([post()], h.deps);
    assert.equal(h.events.length, 1);
  });

  it('runs in the real classifier loop even when RSS digest fetches fail', async () => {
    const h = harness();
    const start = relay.indexOf('async function seedClassify()');
    const end = relay.indexOf('\nasync function startClassifySeedLoop()', start);
    assert.ok(start > 0 && end > start);
    const context = {
      classifyInFlight: false, CLASSIFY_LLM_PROVIDERS: [{ envKey: 'TEST_PROVIDER' }],
      process: { env: { TEST_PROVIDER: 'fixture' } }, Date: { now: () => NOW },
      console: { log() {}, warn() {} }, telegramState: { items: [post()] },
      publishSaudiCivilDefenseAlerts, upstashGet: h.deps.readCache, upstashSet: h.deps.writeCache,
      MAX_POST_CHARS: 4096,
      classifyFetchLlm: async (titles, limit) => { assert.equal(limit, 4096); return h.deps.classify(titles); },
      relayComputeImportanceScore: (severity, source) => {
        assert.equal(severity, 'high'); assert.equal(source, 'Saudi Civil Defense'); return 82;
      },
      publishNotificationEvent: h.deps.publish, CLASSIFY_VARIANTS: ['full'],
      seedClassifyForVariant: async () => ({ fetchFailed: true, total: 0, classified: 0, skipped: 0 }),
      shouldWriteClassifySeedMeta: () => false,
    };
    vm.createContext(context);
    await vm.runInContext(`${relay.slice(start, end)}\nseedClassify()`, context);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].payload.countryCode, 'SA');
    assert.equal(h.events[0].payload.importanceScore, 82);
    assert.equal(context.classifyInFlight, false);
  });
});
