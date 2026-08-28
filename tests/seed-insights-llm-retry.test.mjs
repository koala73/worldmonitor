import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { callLLM, createSynthesisAcceptor, __setInsightsLlmTransportForTests } from '../scripts/seed-insights.mjs';

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

  it('a gate-rejected sample raises the temperature and appends the rejection feedback', async () => {
    // 2026-08-28: 25 consecutive identical LEAD_PROPER_NOUN rejections over four
    // hours. temperature was pinned at 0.1 and the retry got the identical
    // prompt, so #6995's resample-once was the same draft twice. The resample is
    // only real if the second sample differs: hotter, and told what was wrong.
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    const bodies = [];
    __setInsightsLlmTransportForTests({
      fetch: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return okResponse(String(url).includes('openrouter') ? `${LONG_BRIEF} REJECT_ME` : LONG_BRIEF);
      },
    });

    const FEEDBACK = 'Correction: your previous draft was rejected because "strait of hormuz" does not appear in any story its sentence cited.';
    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: (text) => (text.includes('REJECT_ME') ? null : { composed: true }),
      rejectionFeedback: () => FEEDBACK,
    });
    assert.ok(result, 'the chain still lands on an accepting provider');

    // First sample: cold and unannotated — the baseline behaviour is untouched.
    assert.equal(bodies[0].temperature, 0.1, 'the first sample stays at the base temperature');
    assert.equal(bodies[0].messages[1].content, 'user', 'the first sample carries no correction');

    // Every sample after the first rejection: hot, and corrected.
    for (let i = 1; i < bodies.length; i += 1) {
      assert.equal(bodies[i].temperature, 0.7, `sample ${i} after a rejection must actually vary`);
      assert.ok(
        bodies[i].messages[1].content.endsWith(FEEDBACK),
        `sample ${i} must carry the gate's correction appended to the user prompt`,
      );
      assert.ok(
        bodies[i].messages[1].content.startsWith('user'),
        'the correction is appended, never a replacement for the prompt',
      );
    }
  });

  it('an accepted first sample never raises the temperature or consults the feedback hook', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    delete process.env.GROQ_API_KEY;
    delete process.env.OLLAMA_API_URL;

    const bodies = [];
    let feedbackCalls = 0;
    __setInsightsLlmTransportForTests({
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return okResponse(LONG_BRIEF);
      },
    });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: () => ({ composed: true }),
      rejectionFeedback: () => { feedbackCalls += 1; return 'never'; },
    });
    assert.ok(result);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].temperature, 0.1);
    assert.equal(bodies[0].messages[1].content, 'user');
    assert.equal(feedbackCalls, 0, 'the feedback hook is rejection-only');
  });

  it('an acceptor FAULT never heats the sampler, consults feedback, or resamples', async () => {
    // #7248 review: the composer contains its own exceptions and reports a
    // sentinel rejection, which rode the ordinary-rejection path — heating the
    // sampler and appending a generic correction for a bug in OUR gate. The
    // caller now re-throws on the sentinel; this pins callLLM's side of the
    // contract for any throwing acceptor.
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    const bodies = [];
    let feedbackCalls = 0;
    __setInsightsLlmTransportForTests({
      fetch: async (url, init) => {
        bodies.push({ url: String(url), body: JSON.parse(init.body) });
        return okResponse(LONG_BRIEF);
      },
    });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: () => {
        // Fault only for openrouter-family attempts; groq's sample is accepted.
        if (bodies.at(-1).url.includes('openrouter')) throw new Error('composer fault: composer-threw');
        return { composed: true };
      },
      rejectionFeedback: () => { feedbackCalls += 1; return 'never'; },
    });

    assert.ok(result, 'the chain still lands on the provider whose sample is accepted');
    assert.equal(result.provider, 'groq');
    // No resample: each faulting provider is asked exactly once. Three
    // openrouter-family providers + groq = 4 calls, not 7.
    assert.equal(bodies.length, 4, 'a faulted acceptor never earns a resample');
    for (const { body } of bodies) {
      assert.equal(body.temperature, 0.1, 'a fault in our own gate must not heat the sampler');
      assert.equal(body.messages[1].content, 'user', 'no correction is appended for our own fault');
    }
    assert.equal(feedbackCalls, 0, 'the feedback hook is for editorial rejections only');
  });

  it('telemetry records the size of the corrected prompt, not the base one', async () => {
    // #7248 review: promptChars was computed once from the base prompts, so
    // every corrected resample recorded an undersized event.
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'axiom-test-token';
    delete process.env.OLLAMA_API_URL;
    const originalFetch = globalThis.fetch;

    try {
      const telemetryBatches = [];
      // Provider calls go through the transport hook; the Axiom POST uses the
      // global fetch, so the two streams are separable.
      globalThis.fetch = async (_url, init) => {
        telemetryBatches.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({}) };
      };
      __setInsightsLlmTransportForTests({
        fetch: async (url) => okResponse(String(url).includes('openrouter') ? `${LONG_BRIEF} REJECT_ME` : LONG_BRIEF),
      });

      const FEEDBACK = 'Correction: drop the ungrounded phrase.';
      await callLLM(null, {
        systemPrompt: 'sys',
        userPrompt: 'user',
        accept: (text) => (text.includes('REJECT_ME') ? null : { composed: true }),
        rejectionFeedback: () => FEEDBACK,
      });
      // emitLlmEvents is fire-and-forget; give the microtask queue a beat.
      await new Promise((resolve) => setImmediate(resolve));

      const events = telemetryBatches.flat();
      assert.ok(events.length >= 2, 'the walk must emit one event per attempt');
      const base = 'sys'.length + 'user'.length;
      const corrected = 'sys'.length + `user\n\n${FEEDBACK}`.length;
      assert.equal(events[0].prompt_chars, base, 'the first attempt sends the base prompt');
      for (const event of events.slice(1)) {
        assert.equal(
          event.prompt_chars,
          corrected,
          'every attempt after the rejection records the corrected prompt it actually sent',
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.USAGE_TELEMETRY;
      delete process.env.AXIOM_API_TOKEN;
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


describe('createSynthesisAcceptor (composer-fault contract, #7248 review)', () => {
  const STORY = {
    primaryTitle: 'Regional apple prices rose sharply in Chile last quarter, growers say',
    primarySource: 'Reuters',
    primaryLink: 'http://apple',
    sources: ['Reuters', 'AP News'],
    memberTitles: ['Regional apple prices rose sharply in Chile last quarter, growers say'],
  };
  const RAW = JSON.stringify({
    lead: 'Prices rose sharply in Chile last quarter [1].',
    lines: [{ n: 1, text: 'Regional apple prices rose sharply in Chile [1]' }],
  });

  it('THROWS on a contained composer fault instead of reporting a rejection', () => {
    // sanitizeTitle throwing makes the composer itself fault; the composer
    // contains it and reports the sentinel. The acceptor must convert that
    // back into a throw so callLLM takes its faulted path — no temperature
    // bump, no correction, no resample — rather than treating our own bug as
    // an editorial verdict on the sample.
    const { accept, lastRejection } = createSynthesisAcceptor([STORY], {
      validatorMode: 'enforce',
      briefCluster: STORY,
      sanitizeTitle: () => { throw new Error('composer bug'); },
    });
    assert.throws(() => accept(RAW), /composer fault/);
    assert.equal(lastRejection(), null, 'a fault is not a rejection the feedback path may quote');
  });

  it('returns null and records the code on an editorial rejection', () => {
    const { accept, lastRejection } = createSynthesisAcceptor([STORY], {
      validatorMode: 'enforce',
      briefCluster: STORY,
    });
    const bad = JSON.stringify({
      lead: 'Prices rose sharply in Venezuela last quarter [1].',
      lines: [{ n: 1, text: 'Regional apple prices rose sharply in Chile [1]' }],
    });
    assert.equal(accept(bad), null);
    assert.equal(lastRejection().code, 'lead-proper-noun');
    assert.match(lastRejection().detail, /venezuela/);
  });

  it('returns the brief and clears the rejection on success', () => {
    const { accept, lastRejection } = createSynthesisAcceptor([STORY], {
      validatorMode: 'enforce',
      briefCluster: STORY,
    });
    const brief = accept(RAW);
    assert.ok(brief);
    assert.match(brief.lead, /Chile/);
    assert.equal(lastRejection(), null);
  });
});
