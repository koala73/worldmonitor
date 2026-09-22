// Jev runs in SHADOW beside the relay's LLM classifier: it is asked about the
// same headlines, its answer is recorded next to the LLM's, and it decides
// nothing. These tests pin "decides nothing" as much as the recording.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  createShadowObserver,
  fetchJevLabel,
  SHADOW_LOG_KEY,
  SHADOW_LOG_MAX,
} = require('../scripts/lib/jev-classify-relay.cjs');

const KEYED = { TYPESAFE_API_KEY: 'k' };
const answer = (l, pAlert = l === 'high' || l === 'critical' ? 0.9 : 0.05) => ({ l, levelConf: 0.8, pAlert });

function harness({ env = KEYED, labels = {}, now = () => 1_000 } = {}) {
  const asked = [];
  const recorded = [];
  const warnings = [];
  const observe = createShadowObserver({
    env,
    now,
    warn: (m) => warnings.push(m),
    fetchJevLabel: async (title) => {
      asked.push(title);
      const v = labels[title];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    record: async (row) => { recorded.push(row); return true; },
  });
  return { observe, asked, recorded, warnings };
}

describe('Jev shadow observer', () => {
  it('does nothing at all without TYPESAFE_API_KEY', async () => {
    for (const env of [{}, { TYPESAFE_API_KEY: '' }, { TYPESAFE_API_KEY: '   ' }]) {
      const h = harness({ env, labels: { 'A strike': answer('high') } });
      assert.equal(await h.observe('full', [{ title: 'A strike', level: 'low' }]), null);
      assert.deepEqual(h.asked, []);
      assert.deepEqual(h.recorded, []);
    }
  });

  it('records only disagreements, and marks the ones that flip the alert decision', async () => {
    const h = harness({
      labels: { 'Same': answer('medium'), 'Flip': answer('high', 0.93), 'Drift': answer('low') },
    });
    const tally = await h.observe('full', [
      { title: 'Same', level: 'medium' },
      { title: 'Flip', level: 'medium' },
      { title: 'Drift', level: 'info' },
    ]);
    assert.deepEqual(tally, { asked: 3, answered: 3, agreed: 1, alertFlips: 1 });
    assert.deepEqual(h.recorded, [
      { at: 1_000, variant: 'full', title: 'Flip', llm: 'medium', jev: 'high', pAlert: 0.93, alertFlip: true },
      { at: 1_000, variant: 'full', title: 'Drift', llm: 'info', jev: 'low', pAlert: 0.05, alertFlip: false },
    ]);
  });

  it('never asks Jev about non-Latin-script headlines', async () => {
    const h = harness({ labels: { 'Flood in Nepal': answer('high') } });
    const tally = await h.observe('full', [
      { title: 'غارة جوية على الميناء', level: 'high' },
      { title: 'Flood in Nepal', level: 'high' },
    ]);
    assert.deepEqual(h.asked, ['Flood in Nepal']);
    assert.equal(tally.asked, 1);
  });

  it('cannot throw into the classify loop: a rejecting Jev call or record is swallowed', async () => {
    const h = harness({ labels: { Boom: new Error('network'), Fine: answer('high') } });
    const observe = createShadowObserver({
      env: KEYED,
      fetchJevLabel: async (t) => { if (t === 'Boom') throw new Error('network'); return answer('high'); },
      record: async () => { throw new Error('redis down'); },
      warn: () => {},
    });
    const tally = await observe('full', [{ title: 'Boom', level: 'low' }, { title: 'Fine', level: 'low' }]);
    assert.deepEqual(tally, { asked: 2, answered: 1, agreed: 0, alertFlips: 1 });
    assert.equal(h.recorded.length, 0);
  });

  it('pauses after Jev answers nothing, so an outage costs one slow chunk, not every chunk', async () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    const chunk = Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, level: 'low' }));
    await h.observe('full', chunk);
    assert.equal(h.asked.length, 5);
    assert.match(h.warnings[0], /Jev shadow answered none/);
    await h.observe('full', chunk);
    assert.equal(h.asked.length, 5, 'paused: no further requests');
    clock = 10 * 60 * 1000 + 1;
    await h.observe('full', chunk);
    assert.equal(h.asked.length, 10, 'resumes after the cooldown');
  });

  it('pauses during a brownout too: one answer in a chunk must not reset the count', async () => {
    // Counted per chunk, a single answer among 49 timeouts kept Jev "healthy"
    // forever, and every chunk paid the timeout waves.
    const h = harness({ labels: { T0: answer('low') } });
    const chunk = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, level: 'low' }));
    const tally = await h.observe('full', chunk);
    assert.equal(tally.answered, 1);
    assert.match(h.warnings[0] ?? '', /answered none of the last 5 titles in a row/);
    await h.observe('full', chunk);
    assert.equal(h.asked.length, 12, 'paused after the first chunk');
  });

  it('keeps at most 6 Jev requests in flight (TypeSafe allows 1,200/min)', async () => {
    let inFlight = 0;
    let peak = 0;
    const observe = createShadowObserver({
      env: KEYED,
      record: async () => true,
      fetchJevLabel: async () => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return answer('low');
      },
    });
    await observe('full', Array.from({ length: 40 }, (_, i) => ({ title: `T${i}`, level: 'low' })));
    assert.ok(peak <= 6, `peak ${peak}`);
  });
});

describe('fetchJevLabel', () => {
  const okBody = { answers: { l0: { type: 'choice', choice: 'high', confidence: 0.7, probabilities: { high: 0.6, critical: 0.2, medium: 0.2 } } } };
  const respond = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, headers: { get: (k) => headers[k] ?? null }, body: { cancel: async () => {} },
  });

  it('asks the level question only, authenticated, with a User-Agent', async () => {
    let seen;
    const label = await fetchJevLabel('Strike on port', 200, {
      apiKey: 'k', fetchFn: async (url, init) => { seen = { url, init }; return respond(200, okBody); },
    });
    assert.equal(label.l, 'high');
    assert.ok(Math.abs(label.pAlert - 0.8) < 1e-9);
    assert.equal(seen.init.headers.Authorization, 'Bearer k');
    assert.ok(seen.init.headers['User-Agent']);
    assert.deepEqual(Object.keys(JSON.parse(seen.init.body).questions), ['l0'], 'one question: 618 tokens, not 1,030');
  });

  it('returns null on a network error, a non-retryable status, and an unparseable body', async () => {
    assert.equal(await fetchJevLabel('t', 200, { apiKey: 'k', fetchFn: async () => { throw new Error('x'); } }), null);
    assert.equal(await fetchJevLabel('t', 200, { apiKey: 'k', fetchFn: async () => respond(401, {}) }), null);
    assert.equal(await fetchJevLabel('t', 200, { apiKey: 'k', fetchFn: async () => respond(200, { answers: {} }) }), null);
  });

  it('retries a 429 once, and not when Retry-After is longer than it will wait', async () => {
    let calls = 0;
    const label = await fetchJevLabel('t', 200, {
      apiKey: 'k', retryDelayMs: 1,
      fetchFn: async () => (++calls === 1 ? respond(429, {}) : respond(200, okBody)),
    });
    assert.equal(label.l, 'high');
    assert.equal(calls, 2);
    calls = 0;
    assert.equal(await fetchJevLabel('t', 200, {
      apiKey: 'k', retryDelayMs: 1, fetchFn: async () => { calls += 1; return respond(429, {}, { 'retry-after': '60' }); },
    }), null);
    assert.equal(calls, 1);
  });
});

describe('relay wiring: shadow mode decides nothing', () => {
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const main = (name) => relay.slice(relay.indexOf(`async function ${name}(`));

  it('observes AFTER the label is cached and the alert is published, and never feeds back', () => {
    const body = main('seedClassifyForVariant');
    const write = body.indexOf('upstashSet(classifyCacheKey(chunk[idx])');
    const publish = body.indexOf("eventType: 'rss_alert'");
    const observe = body.indexOf('observeJevShadow(');
    assert.ok(write > 0 && publish > write && observe > publish, 'order: cache write, alert publish, shadow observe');
    assert.doesNotMatch(body, /=\s*await observeJevShadow\([^)]*\);[\s\S]{0,400}upstashSet\(classifyCacheKey/, 'the tally must not reach a label write');
  });

  it('the cached row and the alert rule are exactly main\'s: no Jev field, no gate', () => {
    assert.match(relay, /upstashSet\(classifyCacheKey\(chunk\[idx\]\), \{ level, category, timestamp: Date\.now\(\) \}, CLASSIFY_CACHE_TTL\)/);
    assert.doesNotMatch(relay, /pAlert|jevGateAllowsAlert|shouldPublishClassifiedAlert/);
  });

  it('caps the shadow log so it cannot grow without bound', () => {
    assert.equal(SHADOW_LOG_KEY, 'classify:jev-shadow:v1');
    assert.ok(SHADOW_LOG_MAX > 0 && SHADOW_LOG_MAX <= 5000);
    assert.match(relay, /LTRIM/);
  });
});
