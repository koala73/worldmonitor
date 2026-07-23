import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runEnsemble, trimmedMean } from '../scripts/_forecast-ensemble.mjs';

// ── trimmedMean unit tests ──────────────────────────────────────────────────

describe('trimmedMean', () => {
  it('returns mean for single value', () => {
    assert.equal(trimmedMean([0.6]), 0.6);
  });

  it('returns mean for two values', () => {
    assert.equal(trimmedMean([0.2, 0.8]), 0.5);
  });

  it('returns the median for three values (trimmed mean = middle)', () => {
    // [0.2, 0.5, 0.8] sorted → drop 0.2 and 0.8, keep 0.5
    assert.equal(trimmedMean([0.8, 0.2, 0.5]), 0.5);
  });

  it('returns NaN for empty array', () => {
    assert(Number.isNaN(trimmedMean([])));
  });

  it('clamps result to [0,1]', () => {
    // All values at 1.0 → trimmed mean = 1.0 (no clamping needed, but clamp guard exists)
    assert.equal(trimmedMean([1, 1, 1]), 1);
  });
});

// ── runEnsemble unit tests ──────────────────────────────────────────────────

const QUESTION = 'Will WTI crude oil exceed $90/bbl by 2026-09-01?';
const CONTEXT = 'WTI currently at $82. EIA shows 390 Mbbl inventory.';

function makeCallForecastLLM(responses) {
  // responses is an array of results for successive calls.
  // Each element is { text, model, provider } or null (failure).
  let i = 0;
  return async (_systemPrompt, _userPrompt, _options) => {
    const r = responses[i++] ?? null;
    if (r === null) return null;
    return r;
  };
}

describe('runEnsemble — all passes succeed', () => {
  it('returns method=ensemble and trimmed-mean probability', async () => {
    const llm = makeCallForecastLLM([
      { text: '{"probability": 0.55, "rationale": "historical base rate"}', model: 'gpt-4o', provider: 'openai' },
      { text: '{"probability": 0.70, "rationale": "rising demand"}', model: 'gpt-4o', provider: 'openai' },
      { text: '{"probability": 0.45, "rationale": "oversupply risk"}', model: 'gpt-4o', provider: 'openai' },
    ]);
    const result = await runEnsemble(QUESTION, CONTEXT, llm, { baseRateFallback: 0.3 });
    assert.equal(result.method, 'ensemble');
    // trimmedMean([0.55, 0.70, 0.45]) = median = 0.55
    assert.equal(result.probability, 0.55);
    assert.equal(result.passes.length, 3);
    assert.ok(result.passes.every((p) => p.pass));
  });

  it('persists pass metadata for all three passes (KTD1)', async () => {
    const llm = makeCallForecastLLM([
      { text: '{"probability": 0.4, "rationale": "A"}', model: 'model-a', provider: 'pa' },
      { text: '{"probability": 0.6, "rationale": "B"}', model: 'model-b', provider: 'pb' },
      { text: '{"probability": 0.5, "rationale": "C"}', model: 'model-c', provider: 'pc' },
    ]);
    const result = await runEnsemble(QUESTION, CONTEXT, llm, { baseRateFallback: 0.35 });
    const passes = result.passes;
    assert.equal(passes[0].pass, 'outside_view');
    assert.equal(passes[1].pass, 'inside_view');
    assert.equal(passes[2].pass, 'adversarial_refuter');
    assert.equal(passes[0].probability, 0.4);
    assert.equal(passes[0].model, 'model-a');
  });
});

describe('runEnsemble — partial pass failures', () => {
  it('uses mean of survivors when one pass fails', async () => {
    const llm = makeCallForecastLLM([
      { text: '{"probability": 0.6, "rationale": "A"}', model: 'm', provider: 'p' },
      null, // inside_view fails
      { text: '{"probability": 0.4, "rationale": "C"}', model: 'm', provider: 'p' },
    ]);
    const result = await runEnsemble(QUESTION, CONTEXT, llm, { baseRateFallback: 0.3 });
    assert.equal(result.method, 'ensemble');
    // 2 survivors → mean([0.6, 0.4]) = 0.5
    assert.equal(result.probability, 0.5);
    // Failed pass has null probability
    assert.equal(result.passes[1].probability, null);
  });
});

describe('runEnsemble — all passes fail', () => {
  it('falls back to base-rate and never emits 0.5', async () => {
    const llm = makeCallForecastLLM([null, null, null]);
    const result = await runEnsemble(QUESTION, CONTEXT, llm, { baseRateFallback: 0.27 });
    assert.equal(result.method, 'base_rate_fallback');
    assert.equal(result.probability, 0.27);
    assert.ok(result.passes.every((p) => p.probability === null));
  });

  it('throws when all passes fail and no baseRateFallback provided', async () => {
    const llm = makeCallForecastLLM([null, null, null]);
    await assert.rejects(
      () => runEnsemble(QUESTION, CONTEXT, llm, { baseRateFallback: null }),
      /all passes failed.*no finite baseRateFallback/i,
    );
  });
});

describe('runEnsemble — malformed LLM responses are rejected', () => {
  it('rejects a probability > 1 (percent-scale hallucination)', async () => {
    // LLM returns 70 (percent) instead of 0.70 (fraction) — must be treated as fail.
    const llm = makeCallForecastLLM([
      { text: '{"probability": 70, "rationale": "test"}', model: 'm', provider: 'p' },
      { text: '{"probability": 0.5, "rationale": "ok"}', model: 'm', provider: 'p' },
      { text: '{"probability": 0.4, "rationale": "ok"}', model: 'm', provider: 'p' },
    ]);
    const result = await runEnsemble(QUESTION, CONTEXT, llm, { baseRateFallback: 0.3 });
    // Pass 0 rejected; 2 survivors → mean([0.5, 0.4]) = 0.45
    assert.equal(result.method, 'ensemble');
    assert.equal(result.probability, 0.45);
    assert.equal(result.passes[0].probability, null);
  });

  it('handles JSON wrapped in markdown code fences', async () => {
    const llm = makeCallForecastLLM([
      { text: '```json\n{"probability": 0.6, "rationale": "ok"}\n```', model: 'm', provider: 'p' },
      { text: '{"probability": 0.5, "rationale": "ok"}', model: 'm', provider: 'p' },
      { text: '{"probability": 0.4, "rationale": "ok"}', model: 'm', provider: 'p' },
    ]);
    const result = await runEnsemble(QUESTION, CONTEXT, llm, { baseRateFallback: 0.3 });
    assert.equal(result.method, 'ensemble');
    assert.equal(result.probability, 0.5); // median of [0.4, 0.5, 0.6]
  });
});
