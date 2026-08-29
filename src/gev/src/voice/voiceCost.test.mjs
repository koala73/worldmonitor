// src/voice/voiceCost.test.mjs
// The spend guard is the only thing standing between a hot mic and an
// open-ended bill, so its arithmetic, its threshold latches, and its
// unknown-tier fallback are all pinned here. The tier resolver is also a
// security boundary: it is what stops an arbitrary string reaching the
// OpenAI API as a model id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VOICE_TIER,
  VOICE_COST_LIMIT_OFF,
  VOICE_COST_LIMITS,
  VOICE_MODELS,
  VOICE_TIERS,
  createVoiceCostTracker,
  estimateUsageCostUsd,
  formatCostUsd,
  isKnownVoiceTier,
  mostExpensiveVoiceModel,
  normalizeCostLimits,
  resolveVoiceModel,
  resolveVoiceModelById,
  serializeCostLimits,
  splitUsageTokens,
} from './voiceCost.js';

/** A representative `response.done` usage payload with full modality detail. */
const FULL_USAGE = Object.freeze({
  total_tokens: 1500,
  input_tokens: 1000,
  output_tokens: 500,
  input_token_details: {
    cached_tokens: 200,
    text_tokens: 400,
    audio_tokens: 600,
    image_tokens: 0,
    cached_tokens_details: { text_tokens: 100, audio_tokens: 100, image_tokens: 0 },
  },
  output_token_details: { text_tokens: 100, audio_tokens: 400 },
});

/**
 * Usage worth exactly $`usd` on the STANDARD rate table: audio output is
 * $64/1M, so 15,625 audio-output tokens == $1.00 exactly.
 */
const dollarsOfUsage = (usd) => ({
  input_tokens: 0,
  output_tokens: 15625 * usd,
  output_token_details: { text_tokens: 0, audio_tokens: 15625 * usd },
});

/* -------------------------------------------------------------- *
 * model registry / tier resolution
 * -------------------------------------------------------------- */

test('registry exposes exactly the two tiers the UI offers', () => {
  assert.deepEqual([...VOICE_TIERS].sort(), ['mini', 'standard']);
  assert.equal(DEFAULT_VOICE_TIER, 'standard');
});

test('standard tier still points at the model vite.config.js defaults to', () => {
  // If this fails, the client cost estimate is being computed against a
  // different model than the session actually runs on.
  assert.equal(VOICE_MODELS.standard.id, 'gpt-realtime-2');
});

test('mini tier uses a published mini model id, not a guessed -2-mini variant', () => {
  assert.equal(VOICE_MODELS.mini.id, 'gpt-realtime-2.1-mini');
  assert.notEqual(VOICE_MODELS.mini.id, VOICE_MODELS.standard.id);
});

test('mini is cheaper than standard on every single rate', () => {
  const std = VOICE_MODELS.standard.rates;
  const mini = VOICE_MODELS.mini.rates;
  const keys = Object.keys(std);
  assert.ok(keys.length >= 8, 'rate table covers text/audio/image in+cached+out');
  for (const key of keys) {
    assert.ok(
      mini[key] < std[key],
      `mini.${key} (${mini[key]}) should undercut standard.${key} (${std[key]})`
    );
  }
});

test('resolveVoiceModel returns the requested tier', () => {
  assert.equal(resolveVoiceModel('mini').id, 'gpt-realtime-2.1-mini');
  assert.equal(resolveVoiceModel('standard').id, 'gpt-realtime-2');
});

test('resolveVoiceModel tolerates case and whitespace', () => {
  assert.equal(resolveVoiceModel('  MINI ').tier, 'mini');
  assert.equal(resolveVoiceModel('Standard').tier, 'standard');
});

test('unknown, empty, and hostile tiers fall back to standard rather than throwing', () => {
  // This is the guard that keeps an arbitrary querystring out of the OpenAI
  // model field. Every one of these must resolve, never throw.
  for (const bad of [
    undefined,
    null,
    '',
    '   ',
    'gpt-4o',
    'MINI; DROP',
    'constructor',
    'toString',
    '__proto__',
    42,
    {},
    [],
    true,
  ]) {
    const resolved = resolveVoiceModel(bad);
    assert.equal(resolved.tier, 'standard', `fallback for ${JSON.stringify(bad)}`);
    assert.equal(resolved.id, 'gpt-realtime-2');
  }
});

test('isKnownVoiceTier separates real tiers from fallbacks', () => {
  assert.equal(isKnownVoiceTier('mini'), true);
  assert.equal(isKnownVoiceTier('standard'), true);
  assert.equal(isKnownVoiceTier('__proto__'), false);
  assert.equal(isKnownVoiceTier('turbo'), false);
  assert.equal(isKnownVoiceTier(undefined), false);
});

/* -------------------------------------------------------------- *
 * usage splitting
 * -------------------------------------------------------------- */

test('cached tokens are subtracted out of their modality totals', () => {
  const t = splitUsageTokens(FULL_USAGE);
  assert.equal(t.textIn, 300); // 400 text - 100 cached text
  assert.equal(t.audioIn, 500); // 600 audio - 100 cached audio
  assert.equal(t.textCached, 100);
  assert.equal(t.audioCached, 100);
  assert.equal(t.textOut, 100);
  assert.equal(t.audioOut, 400);
});

test('uncached buckets never go negative when cached exceeds the modality total', () => {
  const t = splitUsageTokens({
    input_tokens: 100,
    input_token_details: {
      text_tokens: 50,
      audio_tokens: 50,
      cached_tokens_details: { text_tokens: 999, audio_tokens: 999 },
    },
  });
  assert.equal(t.textIn, 0);
  assert.equal(t.audioIn, 0);
});

test('missing input detail attributes input to audio (over-estimate, never under)', () => {
  // Safe failure direction: a cap should stop early, not bill past itself
  // because a payload field was absent.
  const t = splitUsageTokens({ input_tokens: 800, output_tokens: 200 });
  assert.equal(t.audioIn, 800);
  assert.equal(t.textIn, 0);
  assert.equal(t.audioOut, 200);
});

test('an aggregate cached_tokens without per-modality detail still earns the cache rate', () => {
  const t = splitUsageTokens({
    input_tokens: 1000,
    input_token_details: { cached_tokens: 300, text_tokens: 0, audio_tokens: 1000 },
  });
  assert.equal(t.audioCached, 300);
  assert.equal(t.audioIn, 700);
});

test('F2: a partial input detail attributes the unexplained residual to audio', () => {
  // input_tokens says 1000; the details only explain 100. The other 900 are
  // real and billed upstream — dropping them under-meters, which is the
  // direction that lets a cap be overrun.
  const t = splitUsageTokens({
    input_tokens: 1000,
    input_token_details: { text_tokens: 100 },
  });
  assert.equal(t.textIn, 100);
  assert.equal(t.audioIn, 900, 'residual billed at audio rates');
});

test('F2: a partial output detail attributes its residual to audio too', () => {
  const t = splitUsageTokens({
    output_tokens: 500,
    output_token_details: { text_tokens: 50 },
  });
  assert.equal(t.textOut, 50);
  assert.equal(t.audioOut, 450);
});

test('F2: a fully-explained payload gains no phantom residual', () => {
  const t = splitUsageTokens(FULL_USAGE);
  assert.equal(t.textIn + t.audioIn + t.imageIn + t.textCached + t.audioCached + t.imageCached, 1000);
  assert.equal(t.audioIn, 500, 'unchanged — nothing was unexplained');
});

test('F2: every billed token is accounted for across partial fixtures', () => {
  const fixtures = [
    { input_tokens: 1000, input_token_details: { text_tokens: 100 } },
    { input_tokens: 800, input_token_details: { audio_tokens: 200 } },
    { input_tokens: 640, input_token_details: { text_tokens: 40, image_tokens: 100 } },
    { input_tokens: 500, input_token_details: { cached_tokens: 100, text_tokens: 50 } },
    { output_tokens: 900, output_token_details: { text_tokens: 100 } },
    { input_tokens: 300, output_tokens: 200 },
  ];
  for (const usage of fixtures) {
    const t = splitUsageTokens(usage);
    const inputSum = t.textIn + t.audioIn + t.imageIn + t.textCached + t.audioCached + t.imageCached;
    const outputSum = t.textOut + t.audioOut;
    assert.ok(
      inputSum >= (usage.input_tokens || 0),
      `input accounted (${inputSum} >= ${usage.input_tokens || 0}) for ${JSON.stringify(usage)}`
    );
    assert.ok(
      outputSum >= (usage.output_tokens || 0),
      `output accounted (${outputSum} >= ${usage.output_tokens || 0}) for ${JSON.stringify(usage)}`
    );
  }
});

test('F2: a partial payload never costs LESS than the same tokens fully described', () => {
  // The stated policy is over-estimate-on-uncertainty. Compare a partial
  // payload against the cheapest honest reading of the same totals (all text).
  const rates = VOICE_MODELS.standard.rates;
  const partial = { input_tokens: 1000, input_token_details: { text_tokens: 100 } };
  const allTextTruth = {
    input_tokens: 1000,
    input_token_details: { text_tokens: 1000 },
  };
  assert.ok(
    estimateUsageCostUsd(partial, rates) >= estimateUsageCostUsd(allTextTruth, rates),
    'uncertainty resolves upward, never downward'
  );
});

test('splitUsageTokens survives junk without throwing', () => {
  for (const junk of [null, undefined, {}, { input_tokens: 'abc' }, { input_tokens: -5 }]) {
    const t = splitUsageTokens(junk);
    for (const value of Object.values(t)) {
      assert.ok(Number.isFinite(value) && value >= 0, `finite non-negative: ${value}`);
    }
  }
});

/* -------------------------------------------------------------- *
 * cost arithmetic
 * -------------------------------------------------------------- */

test('standard cost is the exact sum of tokens x per-1M rates', () => {
  // 300*4 + 100*0.4 + 100*24 + 500*32 + 100*0.4 + 400*64 = 45,280 / 1e6
  const usd = estimateUsageCostUsd(FULL_USAGE, VOICE_MODELS.standard.rates);
  assert.ok(Math.abs(usd - 0.04528) < 1e-9, `expected 0.04528, got ${usd}`);
});

test('mini cost is the exact sum on the mini table', () => {
  // 300*0.6 + 100*0.06 + 100*2.4 + 500*10 + 100*0.3 + 400*20 = 13,456 / 1e6
  const usd = estimateUsageCostUsd(FULL_USAGE, VOICE_MODELS.mini.rates);
  assert.ok(Math.abs(usd - 0.013456) < 1e-9, `expected 0.013456, got ${usd}`);
});

test('the same session costs materially less on mini', () => {
  const std = estimateUsageCostUsd(FULL_USAGE, VOICE_MODELS.standard.rates);
  const mini = estimateUsageCostUsd(FULL_USAGE, VOICE_MODELS.mini.rates);
  assert.ok(mini < std / 3, `mini ${mini} should be <1/3 of standard ${std}`);
});

test('image input tokens are billed', () => {
  // Viewport screenshots are the priciest recurring item; they must not be free.
  const withImage = {
    input_tokens: 1000,
    input_token_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 1000 },
  };
  const usd = estimateUsageCostUsd(withImage, VOICE_MODELS.standard.rates);
  assert.ok(Math.abs(usd - 0.005) < 1e-9, `1000 image tokens @ $5/1M = $0.005, got ${usd}`);
});

test('absent usage or rates cost nothing rather than NaN', () => {
  assert.equal(estimateUsageCostUsd(null, VOICE_MODELS.standard.rates), 0);
  assert.equal(estimateUsageCostUsd(FULL_USAGE, null), 0);
  assert.equal(estimateUsageCostUsd({}, VOICE_MODELS.standard.rates), 0);
});

test('the $1 test fixture really is $1 on standard rates', () => {
  const usd = estimateUsageCostUsd(dollarsOfUsage(1), VOICE_MODELS.standard.rates);
  assert.ok(Math.abs(usd - 1) < 1e-9, `expected 1, got ${usd}`);
});

/* -------------------------------------------------------------- *
 * display formatting
 * -------------------------------------------------------------- */

test('cost readout formats to two decimals with a tilde', () => {
  assert.equal(formatCostUsd(0), '~$0.00');
  assert.equal(formatCostUsd(0.42), '~$0.42');
  assert.equal(formatCostUsd(12.5), '~$12.50');
});

test('a nonzero but sub-cent cost never displays as $0.00', () => {
  // "$0.00" while tokens are burning reads as broken/free.
  assert.equal(formatCostUsd(0.0004), '~$0.01');
});

test('formatCostUsd clamps junk to zero', () => {
  assert.equal(formatCostUsd(NaN), '~$0.00');
  assert.equal(formatCostUsd(-3), '~$0.00');
  assert.equal(formatCostUsd(undefined), '~$0.00');
});

/* -------------------------------------------------------------- *
 * limits config
 * -------------------------------------------------------------- */

test('default limits are generous and ordered warn < cap', () => {
  assert.equal(VOICE_COST_LIMITS.warnUsd, 2);
  assert.equal(VOICE_COST_LIMITS.capUsd, 5);
  assert.ok(VOICE_COST_LIMITS.warnUsd < VOICE_COST_LIMITS.capUsd);
});

test('normalizeCostLimits fills gaps from the defaults', () => {
  assert.deepEqual(normalizeCostLimits({ warnUsd: 1 }), { warnUsd: 1, capUsd: 5 });
  assert.deepEqual(normalizeCostLimits({}), { warnUsd: 2, capUsd: 5 });
  assert.deepEqual(normalizeCostLimits(null), { warnUsd: 2, capUsd: 5 });
});

test('zero or negative thresholds mean "disabled", not "stop immediately"', () => {
  // A stored 0 must never brick the mic by capping at the first token.
  const limits = normalizeCostLimits({ warnUsd: 0, capUsd: -1 });
  assert.equal(limits.warnUsd, Infinity);
  assert.equal(limits.capUsd, Infinity);
  const tracker = createVoiceCostTracker({ limits });
  const state = tracker.record(dollarsOfUsage(100));
  assert.equal(state.capReached, false);
  assert.equal(state.level, 'ok');
});

test('unparseable thresholds fall back to defaults', () => {
  assert.deepEqual(normalizeCostLimits({ warnUsd: 'abc', capUsd: 'xyz' }), {
    warnUsd: 2,
    capUsd: 5,
  });
});

/* -------------------------------------------------------------- *
 * tracker state machine
 * -------------------------------------------------------------- */

test('a fresh tracker starts at zero and ok', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard' });
  const state = tracker.state();
  assert.equal(state.totalUsd, 0);
  assert.equal(state.level, 'ok');
  assert.equal(state.capReached, false);
  assert.equal(state.display, '~$0.00');
  assert.equal(state.responses, 0);
});

test('per-response usage accumulates across the session', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard' });
  tracker.record(dollarsOfUsage(1));
  const state = tracker.record(dollarsOfUsage(1));
  assert.ok(Math.abs(state.totalUsd - 2) < 1e-9);
  assert.equal(state.responses, 2);
});

test('the warning fires exactly once, on the crossing record', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard', limits: { warnUsd: 2, capUsd: 5 } });
  assert.equal(tracker.record(dollarsOfUsage(1)).warnCrossed, false); // $1
  const crossing = tracker.record(dollarsOfUsage(1)); // $2 — crosses
  assert.equal(crossing.warnCrossed, true);
  assert.equal(crossing.level, 'warn');
  assert.equal(tracker.record(dollarsOfUsage(1)).warnCrossed, false); // $3 — latched
});

test('the cap fires exactly once and latches capReached', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard', limits: { warnUsd: 2, capUsd: 5 } });
  for (let i = 0; i < 4; i += 1) {
    assert.equal(tracker.record(dollarsOfUsage(1)).capCrossed, false);
  }
  const crossing = tracker.record(dollarsOfUsage(1)); // $5 — crosses
  assert.equal(crossing.capCrossed, true);
  assert.equal(crossing.capReached, true);
  assert.equal(crossing.level, 'cap');
  // Usage keeps arriving while the session tears down; the stop must not
  // be requested a second time.
  const after = tracker.record(dollarsOfUsage(1));
  assert.equal(after.capCrossed, false);
  assert.equal(after.capReached, true);
  assert.equal(after.level, 'cap');
});

test('one huge response crosses both thresholds on the same record', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard', limits: { warnUsd: 2, capUsd: 5 } });
  const state = tracker.record(dollarsOfUsage(50));
  assert.equal(state.warnCrossed, true);
  assert.equal(state.capCrossed, true);
  assert.equal(state.level, 'cap');
});

test('level is monotonic — it never steps back down', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard', limits: { warnUsd: 2, capUsd: 5 } });
  tracker.record(dollarsOfUsage(6));
  assert.equal(tracker.state().level, 'cap');
  tracker.record({}); // a zero-cost response
  assert.equal(tracker.state().level, 'cap');
  assert.equal(tracker.state().capReached, true);
});

test('exact-threshold equality counts as crossed', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard', limits: { warnUsd: 1, capUsd: 2 } });
  assert.equal(tracker.record(dollarsOfUsage(1)).warnCrossed, true);
});

test('zero-cost responses do not advance the response counter', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard' });
  const state = tracker.record({});
  assert.equal(state.responses, 0);
  assert.equal(state.totalUsd, 0);
});

test('the mini tracker takes far longer to reach the same cap', () => {
  // Concrete statement of the feature's point: same traffic, same cap,
  // mini survives where standard trips.
  const heavy = FULL_USAGE;
  const std = createVoiceCostTracker({ tier: 'standard', limits: { warnUsd: 2, capUsd: 5 } });
  const mini = createVoiceCostTracker({ tier: 'mini', limits: { warnUsd: 2, capUsd: 5 } });
  let stdTurns = 0;
  let miniTurns = 0;
  while (!std.state().capReached && stdTurns < 100000) {
    std.record(heavy);
    stdTurns += 1;
  }
  while (!mini.state().capReached && miniTurns < 100000) {
    mini.record(heavy);
    miniTurns += 1;
  }
  assert.ok(miniTurns > stdTurns * 3, `mini ${miniTurns} turns vs standard ${stdTurns}`);
});

test('the tracker reports the model it is charging against', () => {
  const tracker = createVoiceCostTracker({ tier: 'mini' });
  const state = tracker.state();
  assert.equal(state.tier, 'mini');
  assert.equal(state.modelId, 'gpt-realtime-2.1-mini');
});

test('an unknown tier tracks at standard rates rather than free', () => {
  // Charging $0 for an unrecognised tier would silently disable the cap.
  const tracker = createVoiceCostTracker({ tier: 'nonsense' });
  assert.equal(tracker.state().tier, 'standard');
  assert.ok(tracker.record(FULL_USAGE).totalUsd > 0);
});

/* -------------------------------------------------------------- *
 * F3 — pricing by the model actually served, not the tier requested
 * -------------------------------------------------------------- */

test('F3: a known model id resolves to its own rate table', () => {
  assert.equal(resolveVoiceModelById('gpt-realtime-2').tier, 'standard');
  assert.equal(resolveVoiceModelById('gpt-realtime-2.1-mini').tier, 'mini');
  assert.equal(resolveVoiceModelById('gpt-realtime-2').recognized, true);
});

test('F3: an unrecognised model id bills at the most expensive known rates', () => {
  const resolved = resolveVoiceModelById('some-future-model');
  assert.equal(resolved.recognized, false);
  assert.deepEqual(resolved.rates, mostExpensiveVoiceModel().rates);
  // The real id is still reported, so diagnostics never claim the wrong model.
  assert.equal(resolved.id, 'some-future-model');
});

test('F3: empty/garbage model ids still produce a usable worst-case entry', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}]) {
    const resolved = resolveVoiceModelById(bad);
    assert.equal(resolved.recognized, false);
    assert.ok(resolved.rates.audioOutput > 0);
  }
});

test('F3: the most expensive model is derived from the registry, not hardcoded', () => {
  const worst = mostExpensiveVoiceModel();
  for (const entry of Object.values(VOICE_MODELS)) {
    assert.ok(entry.rates.audioOutput <= worst.rates.audioOutput);
  }
});

test('F3: modelId outranks tier when both are supplied', () => {
  // The env override case: tier says mini, the server actually served standard.
  const tracker = createVoiceCostTracker({ tier: 'mini', modelId: 'gpt-realtime-2' });
  assert.equal(tracker.state().modelId, 'gpt-realtime-2');
  assert.equal(tracker.state().tier, 'standard');
});

test('F3: pricing by tier alone would have under-metered an overridden session', () => {
  // Concrete statement of the bug: same usage, tier-priced vs actually-served.
  const byTier = createVoiceCostTracker({ tier: 'mini' });
  const byModel = createVoiceCostTracker({ tier: 'mini', modelId: 'gpt-realtime-2' });
  const tierCost = byTier.record(FULL_USAGE).totalUsd;
  const realCost = byModel.record(FULL_USAGE).totalUsd;
  assert.ok(realCost > tierCost * 3, `real ${realCost} vs tier-assumed ${tierCost}`);
});

/* -------------------------------------------------------------- *
 * F6 — disabled thresholds must survive serialization
 * -------------------------------------------------------------- */

test('F6: serializeCostLimits encodes a disabled threshold as a sentinel', () => {
  const encoded = serializeCostLimits({ warnUsd: 0, capUsd: 0 });
  assert.equal(encoded.warnUsd, VOICE_COST_LIMIT_OFF);
  assert.equal(encoded.capUsd, VOICE_COST_LIMIT_OFF);
  // The whole point: it must survive JSON, unlike Infinity -> null.
  assert.equal(JSON.parse(JSON.stringify(encoded)).capUsd, VOICE_COST_LIMIT_OFF);
});

test('F6: the sentinel normalizes back to a disabled threshold', () => {
  const limits = normalizeCostLimits({ warnUsd: 'off', capUsd: 'OFF' });
  assert.equal(limits.warnUsd, Infinity);
  assert.equal(limits.capUsd, Infinity);
});

test('F6: JSON round-trip preserves disabled, live, and mixed limits', () => {
  for (const input of [
    { warnUsd: 0, capUsd: 0 },
    { warnUsd: 2, capUsd: 5 },
    { warnUsd: 0, capUsd: 5 },
    { warnUsd: 1.5, capUsd: 0 },
  ]) {
    const expected = normalizeCostLimits(input);
    const restored = normalizeCostLimits(
      JSON.parse(JSON.stringify(serializeCostLimits(input)))
    );
    assert.deepEqual(restored, expected, `round-trip of ${JSON.stringify(input)}`);
  }
});

test('F6: a raw Infinity (pre-sentinel data) is still honoured on read', () => {
  assert.equal(normalizeCostLimits({ capUsd: Infinity }).capUsd, Infinity);
});

test('markIncomplete flags the accounting as partial, without a direction claim', () => {
  // A response torn down mid-flight never reports usage. We have no token
  // telemetry for it, so we mark the accounting incomplete rather than invent
  // a number for a user-visible dollar figure.
  const tracker = createVoiceCostTracker({ tier: 'standard' });
  tracker.record(dollarsOfUsage(1));
  assert.equal(tracker.state().incomplete, false);
  assert.equal(tracker.state().display, '~$1.00');
  assert.equal(tracker.state().note, null);

  tracker.markIncomplete();
  assert.equal(tracker.state().incomplete, true);
  assert.equal(tracker.state().display, '~$1.00*');
  assert.match(tracker.state().note, /incomplete/i);
});

test('the incomplete marker never claims the total is a minimum', () => {
  // The estimate can run HIGH too — residuals and unknown models bill at
  // worst-case rates, and sub-cent totals round up — so "at least"/floor
  // wording would overpromise. Pinned so the copy cannot regress to '+'.
  const tracker = createVoiceCostTracker({ tier: 'standard' });
  tracker.record(dollarsOfUsage(1));
  tracker.markIncomplete();
  const { display, note } = tracker.state();
  assert.ok(!display.includes('+'), `no floor marker in ${display}`);
  assert.doesNotMatch(note, /at least|lower bound|minimum|floor|no less than/i);
});

test('the over-estimate paths that make a floor claim wrong are real', () => {
  // Demonstrates the premise: worst-case rates for an unknown model exceed the
  // cheapest known model's, so the estimate is not bounded below by truth.
  const unknown = createVoiceCostTracker({ modelId: 'not-a-real-model' });
  const cheapest = createVoiceCostTracker({ modelId: VOICE_MODELS.mini.id });
  assert.ok(
    unknown.record(dollarsOfUsage(1)).totalUsd > cheapest.record(dollarsOfUsage(1)).totalUsd,
    'an unknown model is billed above the cheapest real one'
  );
  assert.equal(formatCostUsd(0.0001), '~$0.01', 'sub-cent totals round UP');
});

test('marking incomplete does not change the accrued total', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard' });
  tracker.record(dollarsOfUsage(2));
  tracker.markIncomplete();
  assert.ok(Math.abs(tracker.state().totalUsd - 2) < 1e-9);
});

test('an incomplete total still trips the cap on the tokens we did see', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard', limits: { warnUsd: 2, capUsd: 5 } });
  tracker.markIncomplete();
  const state = tracker.record(dollarsOfUsage(6));
  assert.equal(state.capReached, true);
  assert.equal(state.incomplete, true);
});

test('reset clears the incomplete marker for the next session', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard' });
  tracker.record(dollarsOfUsage(1));
  tracker.markIncomplete();
  const cleared = tracker.reset();
  assert.equal(cleared.incomplete, false);
  assert.equal(cleared.display, '~$0.00');
});

test('reset clears totals and re-arms both latches for a new session', () => {
  const tracker = createVoiceCostTracker({ tier: 'standard', limits: { warnUsd: 2, capUsd: 5 } });
  tracker.record(dollarsOfUsage(9));
  assert.equal(tracker.state().capReached, true);
  const cleared = tracker.reset();
  assert.equal(cleared.totalUsd, 0);
  assert.equal(cleared.level, 'ok');
  assert.equal(cleared.capReached, false);
  assert.equal(tracker.record(dollarsOfUsage(2)).warnCrossed, true);
});
