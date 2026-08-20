import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { callLLM, __setInsightsLlmTransportForTests } from '../scripts/seed-insights.mjs';

const LONG_BRIEF = 'Insights brief succeeded with more than enough narrative content to pass.';

const originalEnv = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OLLAMA_API_URL: process.env.OLLAMA_API_URL,
};

afterEach(() => {
  __setInsightsLlmTransportForTests(null);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function okResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ model: 'deepseek/deepseek-v4-flash', choices: [{ message: { content } }] }),
  };
}

describe('seed-insights callLLM retry/budget', () => {
  it('honors a 429 Retry-After on the same provider before falling through', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    delete process.env.OLLAMA_API_URL;
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    const calls = [];
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setInsightsLlmTransportForTests({
        fetch: async (url) => {
          calls.push(String(url));
          if (calls.length <= 2) {
            return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '2' : null) } };
          }
          return okResponse(LONG_BRIEF);
        },
      });

      const result = await callLLM('Some breaking headline', { retryDelayMs: 0 });

      assert.deepEqual(waits, [2000, 2000]);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((u) => u.includes('openrouter.ai')));
      assert.equal(result?.provider, 'openrouter');
      assert.equal(result?.text, LONG_BRIEF);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('caps an oversized Retry-After hint before retrying', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    delete process.env.OLLAMA_API_URL;
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    let calls = 0;
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setInsightsLlmTransportForTests({
        fetch: async () => {
          calls += 1;
          if (calls === 1) return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '30' : null) } };
          return okResponse(LONG_BRIEF);
        },
      });

      const result = await callLLM('Some breaking headline', { retryDelayMs: 0 });

      assert.deepEqual(waits, [10000]);
      assert.equal(calls, 2);
      assert.equal(result?.provider, 'openrouter');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  // Budget stop: createLlmBudgetError ends the whole chain rather than burning
  // the next provider's timeout. After the #6110 equality fix (`>=`), two equal
  // 6s sleeps against 12s usable can no longer exhaust the clock — the second
  // sleep is fail-fast (hint == rem) and would fall through. Drive the stop by
  // letting withRetry's wait overshoot remaining after one under-budget sleep:
  //   usable 12s (callBudget 17s − 5s guard), hint 3s, retryDelayMs 8s
  //   wait0 = max(8s, 3s) = 8s → rem 4s
  //   wait1 = max(16s, 3s) = 16s (3s < 4s so still slept) → rem < 0
  //   attempt2: usable <= 0 → createLlmBudgetError (no groq)
  it('stops at the call budget without falling through to the next provider', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    delete process.env.OLLAMA_API_URL;
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    let now = 1_000;
    let calls = 0;
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); now += ms; fn(...args); return 0; };

    try {
      __setInsightsLlmTransportForTests({
        fetch: async (url) => {
          calls += 1;
          assert.ok(String(url).includes('openrouter.ai'), 'budget stop must not fall through to groq');
          return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '3' : null) } };
        },
      });

      const result = await callLLM('Some breaking headline', { retryDelayMs: 8_000, callBudgetMs: 17_000 });

      assert.equal(result, null);
      assert.equal(calls, 2);
      assert.deepEqual(waits, [8000, 16000], 'backoff overshoots remaining after the first under-budget sleep');
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('falls through to the next provider after a non-retryable 402', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    delete process.env.OLLAMA_API_URL;
    const providers = [];

    __setInsightsLlmTransportForTests({
      fetch: async (url) => {
        const href = String(url);
        providers.push(href.includes('api.groq.com') ? 'groq' : 'openrouter');
        if (href.includes('openrouter.ai')) return { ok: false, status: 402, headers: { get: () => null } };
        return okResponse(LONG_BRIEF);
      },
    });

    const result = await callLLM('Some breaking headline', { retryDelayMs: 0 });

    assert.deepEqual(providers, ['openrouter', 'openrouter', 'openrouter', 'groq']);
    assert.equal(result?.provider, 'groq');
  });
});

// #6110: the exact production shape from seed-insights 2026-08-03 12:10Z and
// 12:20Z. openrouter answered but the composer gates rejected it, the chain
// fell through to groq, and groq returned 429 with
//   "tokens per day (TPD): Limit 100000, Used 100000 ... try again in 20m13.92s"
// The 1213s hint was clamped to the 10s ceiling and retried TWICE — 20s of a
// 60s LLM budget and a 120s seed lock spent on a daily quota that could not
// reset for another 20 minutes. Both cycles ran 30-36s vs 7-17s for healthy
// ones and still published nothing.
//
// The unit test in seed-utils-with-retry covers the helper; this one exists
// because the symptom was in the CHAIN — the assertion that matters is that no
// sleep happens at all, and it can only be observed here.
describe('seed-insights callLLM does not sleep on an unreachable Retry-After (#6110)', () => {
  it('fails groq over immediately when its hint outruns the run budget', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    const calls = [];
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setInsightsLlmTransportForTests({
        fetch: async (url) => {
          const target = String(url);
          calls.push(target);
          if (target.includes('openrouter')) return okResponse(`${LONG_BRIEF} REJECT_ME`);
          // groq: daily token quota exhausted, ~20 minutes out.
          return {
            ok: false,
            status: 429,
            headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '1213' : null) },
          };
        },
      });

      const result = await callLLM(null, {
        systemPrompt: 'sys',
        userPrompt: 'user',
        accept: (text) => (text.includes('REJECT_ME') ? null : { composed: true }),
      });

      assert.deepEqual(waits, [], 'a hint 20 minutes out must not be slept on at all');
      assert.equal(
        calls.filter((u) => u.includes('groq')).length,
        1,
        'groq must be attempted once and abandoned, not retried against a wall',
      );
      // The rejected openrouter candidate still comes back so the caller can
      // classify the failure as GATE rather than mislabel it a provider outage.
      assert.ok(result, 'the gate-rejected candidate must still be returned');
      assert.match(result.text, /REJECT_ME/);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('still honors a short hint that fits inside the budget', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      let attempts = 0;
      __setInsightsLlmTransportForTests({
        fetch: async () => {
          attempts += 1;
          if (attempts === 1) {
            return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '2' : null) } };
          }
          return okResponse(LONG_BRIEF);
        },
      });

      const result = await callLLM('Some breaking headline', { retryDelayMs: 0 });

      assert.deepEqual(waits, [2000], 'a 2s hint is reachable and must still be honored');
      assert.equal(result?.text, LONG_BRIEF);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('fails over with no sleep when the hint exactly equals usable budget', async () => {
    // callBudgetMs 7000 − 5s guard = 2000ms usable at t≈0. A 2s Retry-After
    // equals that remainder. Sleeping it would spend the whole budget and the
    // next withRetry attempt would throw createLlmBudgetError, aborting every
    // later provider. `>=` keeps the budget for fallthrough instead.
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    const originalSetTimeout = globalThis.setTimeout;
    const originalDateNow = Date.now;
    const waits = [];
    const providers = [];
    const frozen = 1_700_000_000_000;
    Date.now = () => frozen;
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setInsightsLlmTransportForTests({
        fetch: async (url) => {
          const href = String(url);
          providers.push(href.includes('api.groq.com') ? 'groq' : 'openrouter');
          if (href.includes('openrouter.ai')) {
            return {
              ok: false,
              status: 429,
              headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '2' : null) },
            };
          }
          return okResponse(LONG_BRIEF);
        },
      });

      const result = await callLLM('Some breaking headline', {
        retryDelayMs: 0,
        callBudgetMs: 7_000,
      });

      assert.deepEqual(waits, [], 'equality must fail-fast, not sleep the full remainder');
      assert.deepEqual(providers, ['openrouter', 'openrouter', 'openrouter', 'groq'], 'saved budget must reach the next provider');
      assert.equal(result?.provider, 'groq');
      assert.equal(result?.text, LONG_BRIEF);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      Date.now = originalDateNow;
    }
  });
});

// #6001/#5947: the chain fell through on TRANSPORT errors only. When the
// primary model returned well-formed text that the brief composer then
// rejected on its editorial gates, seed-insights gave up and published
// degraded — never trying a fallback model that would have passed. Measured
// against a live digest: openrouter composed 2/6, groq 6/6, yet production
// only ever asked openrouter.
describe('seed-insights callLLM output acceptance (#6001)', () => {
  it('falls through to the next provider when the caller rejects the output', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    const seen = [];
    __setInsightsLlmTransportForTests({
      fetch: async (url) => {
        seen.push(String(url));
        return okResponse(String(url).includes('openrouter') ? `${LONG_BRIEF} REJECT_ME` : LONG_BRIEF);
      },
    });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: (text) => (text.includes('REJECT_ME') ? null : { composed: true }),
    });

    assert.ok(result, 'an accepted provider result must be returned');
    assert.equal(result.provider, 'groq');
    assert.equal(result.text, LONG_BRIEF);

    // #6001's guarantee, unchanged: a gate rejection must not strand the run on
    // the primary — the chain still reaches a provider that composes.
    assert.ok(
      seen.some((url) => url.includes('groq')),
      'the chain must still advance past a provider whose output the gates reject',
    );

    // Added later: it advances only AFTER resampling the same provider once. A
    // gate rejection says the SAMPLE was unusable, not that the provider is
    // unhealthy, and demoting on the first one shipped the weaker writer —
    // measured on 2026-08-20, 5 of 14 published briefs came from the free model
    // while only 2 of 9 demotions actually rescued the run.
    //
    // Asserted as a SHAPE, not a count: each rejecting provider is sampled
    // twice consecutively, the accepting one exactly once. A bare length check
    // would pass just as happily if the retries landed on the wrong provider.
    const providerOf = (url) => (url.includes('groq') ? 'groq' : 'openrouter');
    const attempts = seen.map(providerOf);
    assert.equal(attempts.at(-1), 'groq', 'the accepting provider ends the walk');
    assert.equal(
      attempts.filter((p) => p === 'groq').length,
      1,
      'a provider that passes on its first sample is never resampled',
    );
    assert.equal(
      attempts.filter((p) => p === 'openrouter').length,
      6,
      'each of the three rejecting openrouter providers is sampled exactly twice',
    );
    assert.equal(seen.length, 7);

    // The resample must be the SAME endpoint, back to back — a retry that
    // silently moved to the next model would satisfy the counts above.
    const rejecting = seen.slice(0, 6);
    for (let i = 0; i < rejecting.length; i += 2) {
      assert.equal(
        rejecting[i], rejecting[i + 1],
        `resample ${i / 2 + 1} must re-ask the same provider, not the next one`,
      );
    }
  });

  it('returns the last attempt when every provider is rejected, so the failure stays classifiable', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    __setInsightsLlmTransportForTests({ fetch: async () => okResponse(`${LONG_BRIEF} REJECT_ME`) });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: (text) => (text.includes('REJECT_ME') ? null : { composed: true }),
    });

    // Not null: a null here would classify as PROVIDER (transport) failure and
    // hide that the model DID answer and the composer rejected it.
    assert.ok(result, 'a rejected-but-present response must still be returned');
    assert.match(result.text, /REJECT_ME/);
  });

  it('keeps the first provider when no acceptor is supplied', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    const seen = [];
    __setInsightsLlmTransportForTests({
      fetch: async (url) => { seen.push(String(url)); return okResponse(LONG_BRIEF); },
    });

    const result = await callLLM(null, { systemPrompt: 'sys', userPrompt: 'user' });
    assert.equal(result.provider, 'openrouter');
    assert.equal(seen.length, 1, 'legacy path must not probe extra providers');
  });

  // Narrow claim: callLLM itself does not propagate an acceptor fault. It does
  // NOT prove the surrounding run survives — the caller's own compose is what
  // must be fault-tolerant, and seed-insights makes composeFromText defensive.
  it('does not propagate an acceptor fault out of callLLM', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    __setInsightsLlmTransportForTests({ fetch: async () => okResponse(LONG_BRIEF) });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: () => { throw new Error('composer blew up'); },
    });
    assert.ok(result, 'an acceptor fault must not lose an otherwise usable response');
  });

  it('prefers a cleanly-rejected response over one whose acceptor threw', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    __setInsightsLlmTransportForTests({
      fetch: async (url) => okResponse(String(url).includes('openrouter') ? `${LONG_BRIEF} CLEAN` : `${LONG_BRIEF} POISON`),
    });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: (text) => { if (text.includes('POISON')) throw new Error('boom'); return null; },
    });

    // Returning the poison candidate would hand the caller text its own
    // composer is known to choke on.
    assert.match(result.text, /CLEAN/, 'a faulted candidate must not outrank a clean rejection');
  });

  it('reports the FIRST rejection so the failure code names the primary model stage', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    __setInsightsLlmTransportForTests({
      fetch: async (url) => okResponse(String(url).includes('openrouter') ? `${LONG_BRIEF} PRIMARY` : `${LONG_BRIEF} FALLBACK`),
    });

    const result = await callLLM(null, { systemPrompt: 'sys', userPrompt: 'user', accept: () => null });
    assert.match(result.text, /PRIMARY/, 'the last provider would misattribute the failure stage');
  });
});
