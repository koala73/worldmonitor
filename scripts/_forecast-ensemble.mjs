// 3-pass LLM ensemble for bet-engine Phase 2 (#5238 U10).
//
// Runs three diverse LLM passes in parallel (outside-view / inside-view /
// adversarial-refuter) and returns a calibrated probability via trimmed mean
// (= median for 3 values). All-fail falls back honestly to the provided
// base-rate — NEVER emits 0.5.
//
// Pure / injected: callForecastLLM is passed in by the caller so this module
// has no top-level side effects and no circular dependency on seed-forecasts.mjs.
// This mirrors the createLiveJudgeModels() pattern in seed-forecast-resolutions.mjs.
//
// Per-pass budget: 35s, maxRetries: 0 — a slow pass that loses the race is
// evidence of model pressure, not a reason to retry and inflate cost.
// All passes run concurrently via Promise.allSettled.

const PASS_BUDGET_MS = 35_000;

// The three pass personas, each with a distinct epistemic lens.
// Probabilities must be in [0, 1] — the JSON schema enforces this so a
// hallucinated >1 value is treated as a failed pass rather than silently clamped.
const PASSES = [
  {
    name: 'outside_view',
    systemPrompt: [
      'You forecast geopolitical and economic questions using reference-class reasoning.',
      'Start from the base rate for similar questions, then adjust for structural features.',
      'Do NOT anchor on recent headlines. Think in historical frequencies.',
      'Return JSON only: {"probability": <0-1 float>, "rationale": "<50 words>"}.',
    ].join('\n'),
  },
  {
    name: 'inside_view',
    systemPrompt: [
      'You forecast geopolitical and economic questions by analyzing specific causal mechanisms.',
      'Focus on the concrete factors driving this particular question right now.',
      'Consider recent data trends, policy actions, and near-term catalysts.',
      'Return JSON only: {"probability": <0-1 float>, "rationale": "<50 words>"}.',
    ].join('\n'),
  },
  {
    name: 'adversarial_refuter',
    systemPrompt: [
      'You forecast geopolitical and economic questions by steelmanning the OPPOSITE outcome.',
      'Identify the strongest reasons the expected outcome will NOT happen.',
      'Then assign a probability that accounts for those tail risks.',
      'Return JSON only: {"probability": <0-1 float>, "rationale": "<50 words>"}.',
    ].join('\n'),
  },
];

/**
 * Run the 3-pass ensemble for a single forecast question.
 *
 * @param {string} question   The YES/NO resolution question (from the bet spec).
 * @param {string} context    Brief factual context (feed snapshot summary, <=300 chars).
 * @param {Function} callForecastLLM  Injected from seed-forecasts.mjs.
 * @param {object} options
 * @param {number} [options.budgetMs=35000]      Per-pass timeout.
 * @param {string} [options.stage='ensemble']    LLM stage label for telemetry.
 * @param {string} [options.providerOrder]       Override provider order (e.g. ['openrouter']).
 * @param {object} [options.modelOverrides]      Override model per provider.
 * @param {number|null} [options.baseRateFallback=null]  Base-rate to return on all-fail.
 *   MUST be a finite number in [0,1]. null is rejected at runtime (caller must supply it).
 * @returns {Promise<EnsembleResult>}
 */
export async function runEnsemble(question, context, callForecastLLM, options = {}) {
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : PASS_BUDGET_MS;
  const stage = options.stage || 'forecast_ensemble';
  const baseRateFallback = options.baseRateFallback ?? null;

  const userPrompt = buildUserPrompt(question, context);

  // Run all 3 passes in parallel; allSettled so a single failure doesn't abort the others.
  const settled = await Promise.allSettled(
    PASSES.map((pass) => runOnePass(pass, userPrompt, callForecastLLM, { budgetMs, stage, ...options })),
  );

  const successful = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled' && result.value !== null) {
      successful.push({ ...result.value, pass: PASSES[i].name });
    }
  }

  if (successful.length === 0) {
    // All-fail: fall back to base-rate. Never emit 0.5 — the issue explicitly
    // forbids it ("all-fail → base-rate (never 0.5)").
    const fb = Number.isFinite(baseRateFallback) ? clamp01(baseRateFallback) : null;
    if (fb === null) {
      // Caller must supply a finite base-rate. Surface as a clear error.
      throw new Error('[ensemble] all passes failed and no finite baseRateFallback provided');
    }
    return {
      probability: fb,
      rationale: 'All LLM passes failed; using empirical base-rate fallback.',
      passes: PASSES.map((p) => ({ pass: p.name, probability: null, rationale: null, model: null, provider: null })),
      method: 'base_rate_fallback',
    };
  }

  // Trimmed mean: for 3 inputs this is the median (drop min + max, keep middle).
  // For < 3 successful passes it is the mean of what survived.
  const probability = trimmedMean(successful.map((p) => p.probability));

  return {
    probability,
    rationale: successful.map((p) => `[${p.pass}] ${p.rationale || ''}`).join(' | '),
    passes: PASSES.map((pass) => {
      const found = successful.find((s) => s.pass === pass.name);
      return {
        pass: pass.name,
        probability: found?.probability ?? null,
        rationale: found?.rationale ?? null,
        model: found?.model ?? null,
        provider: found?.provider ?? null,
      };
    }),
    method: 'ensemble',
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────

function buildUserPrompt(question, context) {
  const lines = [
    `Question: ${question}`,
  ];
  if (context && typeof context === 'string' && context.trim()) {
    lines.push(`Context: ${context.trim().slice(0, 400)}`);
  }
  return lines.join('\n');
}

/**
 * Run one LLM pass. Returns { probability, rationale, model, provider } or null on failure.
 * Never throws — a failed pass is a null result (Promise.allSettled handles it).
 */
async function runOnePass(pass, userPrompt, callForecastLLM, options) {
  const { budgetMs, stage, providerOrder, modelOverrides } = options;
  try {
    const result = await callForecastLLM(pass.systemPrompt, userPrompt, {
      stage: `${stage}:${pass.name}`,
      maxTokens: 120,
      temperature: 0.3,
      maxRetries: 0,
      returnFailureReason: true,
      stageBudgetMs: budgetMs,
      ...(providerOrder ? { providerOrder } : {}),
      ...(modelOverrides ? { modelOverrides } : {}),
    });

    if (!result?.text) return null;
    return parsePassResponse(result.text, result.model, result.provider);
  } catch {
    return null;
  }
}

/**
 * Parse a pass response JSON. Returns { probability, rationale, model, provider } or null.
 * Rejects probabilities outside [0, 1] — a hallucinated "50" (percent not decimal) would
 * otherwise corrupt the ensemble with a false certainty.
 */
function parsePassResponse(text, model, provider) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Try extracting the first {...} block
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rawProb = parsed.probability ?? parsed.prob ?? parsed.p;
  const probability = Number(rawProb);
  // Strict [0,1] validation — reject percent-scale answers (0-100) as corrupted.
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  const rationale = typeof parsed.rationale === 'string'
    ? parsed.rationale.slice(0, 200).replace(/\s+/g, ' ').trim()
    : '';
  return { probability, rationale, model: model || null, provider: provider || null };
}

/**
 * Trimmed mean: drops the min and max, returns the mean of the rest.
 * For N=1 or N=2, returns the plain mean (nothing to drop).
 * For N=3 this equals the median.
 */
export function trimmedMean(values) {
  if (!values || values.length === 0) return NaN;
  if (values.length <= 2) {
    return values.reduce((s, v) => s + v, 0) / values.length;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const inner = sorted.slice(1, -1);
  const result = inner.reduce((s, v) => s + v, 0) / inner.length;
  return round6(clamp01(result));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function round6(v) {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 1_000_000) / 1_000_000;
}

/**
 * @typedef {object} EnsembleResult
 * @property {number}      probability  Calibrated probability in [0,1].
 * @property {string}      rationale    Synthesized rationale from all passes.
 * @property {PassResult[]} passes      Per-pass results for audit (KTD1).
 * @property {'ensemble'|'base_rate_fallback'} method
 */

/**
 * @typedef {object} PassResult
 * @property {string}      pass        Pass name ('outside_view', 'inside_view', 'adversarial_refuter').
 * @property {number|null} probability Pass probability, or null if the pass failed.
 * @property {string|null} rationale   Pass rationale, or null if the pass failed.
 * @property {string|null} model       LLM model used.
 * @property {string|null} provider    LLM provider used.
 */
