export const RESILIENCE_INTERVAL_KEY_PREFIX = 'resilience:intervals:v6:';
export const RESILIENCE_INTERVAL_METHODOLOGY = 'weight-perturbation-sensitivity-v3';
export const DRAWS = 100;

export const DOMAIN_WEIGHTS = {
  economic: 0.17,
  infrastructure: 0.15,
  energy: 0.11,
  'social-governance': 0.19,
  'health-food': 0.13,
  recovery: 0.25,
};

export const DOMAIN_ORDER = [
  'economic',
  'infrastructure',
  'energy',
  'social-governance',
  'health-food',
  'recovery',
];

export const PILLAR_WEIGHTS = {
  'structural-readiness': 0.40,
  'live-shock-exposure': 0.35,
  'recovery-capacity': 0.25,
};

export const PILLAR_ORDER = [
  'structural-readiness',
  'live-shock-exposure',
  'recovery-capacity',
];

export const PENALTY_ALPHA = 0.50;

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function roundInterval(value) {
  return Math.round(value * 10) / 10;
}

function floorInterval(value) {
  return Math.floor(value * 10) / 10;
}

function ceilInterval(value) {
  return Math.ceil(value * 10) / 10;
}

export function createIntervalDiagnostics() {
  return {
    activeScoreClampCount: 0,
    activeScoreClampMaxDelta: 0,
    activeScoreClampSamples: [],
    formulaSkipCount: 0,
    formulaSkipSamples: [],
    missingScorePayloadCount: 0,
    missingScorePayloadSamples: [],
    staleScorePayloadCount: 0,
    staleScorePayloadSamples: [],
    invalidScorePayloadCount: 0,
    invalidScorePayloadSamples: [],
    malformedScorePayloadCount: 0,
    malformedScorePayloadSamples: [],
    intervalPayloadSkipCount: 0,
    intervalPayloadSkipSamples: [],
  };
}

function normalizeFormula(value) {
  return value === 'pc' || value === 'd6' ? value : null;
}

function recordActiveScoreClamp(options, before, after, activeScore) {
  if (before.p05 === after.p05 && before.p95 === after.p95) return;
  const diagnostics = options?.diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return;

  const delta = activeScore < before.p05
    ? before.p05 - activeScore
    : activeScore > before.p95
      ? activeScore - before.p95
      : 0;
  diagnostics.activeScoreClampCount = (Number(diagnostics.activeScoreClampCount) || 0) + 1;
  diagnostics.activeScoreClampMaxDelta = Math.max(Number(diagnostics.activeScoreClampMaxDelta) || 0, round(delta, 4));
  if (Array.isArray(diagnostics.activeScoreClampSamples) && diagnostics.activeScoreClampSamples.length < 5) {
    diagnostics.activeScoreClampSamples.push({
      countryCode: typeof options.countryCode === 'string' ? options.countryCode : undefined,
      formula: normalizeFormula(options.formula) ?? undefined,
      activeScore: round(activeScore, 4),
      before,
      after,
      delta: round(delta, 4),
    });
  }
}

function recordFormulaSkip(options, reason, scoreData) {
  const diagnostics = options?.diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return;

  diagnostics.formulaSkipCount = (Number(diagnostics.formulaSkipCount) || 0) + 1;
  if (Array.isArray(diagnostics.formulaSkipSamples) && diagnostics.formulaSkipSamples.length < 5) {
    diagnostics.formulaSkipSamples.push({
      countryCode: typeof scoreData?.countryCode === 'string' ? scoreData.countryCode : undefined,
      formula: typeof scoreData?._formula === 'string' ? scoreData._formula : undefined,
      reason,
    });
  }
}

function clampToActiveScore(interval, activeScore, options = {}) {
  if (!Number.isFinite(activeScore)) return interval;
  const before = { ...interval };
  let { p05, p95 } = before;
  if (activeScore < p05) p05 = floorInterval(activeScore);
  if (activeScore > p95) p95 = ceilInterval(activeScore);
  const after = { p05, p95 };
  recordActiveScoreClamp(options, before, after, activeScore);
  return after;
}

function percentile(samples, quantile) {
  if (samples.length === 0) return 0;
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * quantile) - 1));
  return samples[index];
}

function jitterWeights(weights, rng) {
  const jittered = weights.map((w) => w * (0.9 + rng() * 0.2));
  const sum = jittered.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum <= 0) return weights;
  return jittered.map((w) => w / sum);
}

export function computeIntervals(domainScores, domainWeights, draws = DRAWS, options = {}) {
  const rng = options.rng ?? Math.random;
  const activeScore = Number(options.activeScore);
  const samples = [];
  const count = Math.max(1, Math.floor(Number(draws) || DRAWS));
  for (let i = 0; i < count; i++) {
    const normalized = jitterWeights(domainWeights, rng);
    const score = domainScores.reduce((sum, value, index) => sum + value * normalized[index], 0);
    samples.push(score);
  }
  samples.sort((a, b) => a - b);
  return clampToActiveScore({
    p05: roundInterval(percentile(samples, 0.05)),
    p95: roundInterval(percentile(samples, 0.95)),
  }, activeScore, options);
}

export function penalizedPillarScore(pillars) {
  if (!pillars.length) return 0;
  const weighted = pillars.reduce((sum, p) => sum + p.score * p.weight, 0);
  const minScore = Math.min(...pillars.map((p) => p.score));
  const penalty = 1 - PENALTY_ALPHA * (1 - minScore / 100);
  return round(weighted * penalty);
}

export function computePillarIntervals(pillars, draws = DRAWS, options = {}) {
  const rng = options.rng ?? Math.random;
  const activeScore = Number(options.activeScore);
  const scores = pillars.map((pillar) => Number(pillar.score));
  const weights = pillars.map((pillar) => Number(pillar.weight));
  const samples = [];
  const count = Math.max(1, Math.floor(Number(draws) || DRAWS));
  for (let i = 0; i < count; i++) {
    const normalized = jitterWeights(weights, rng);
    samples.push(penalizedPillarScore(scores.map((score, index) => ({ score, weight: normalized[index] }))));
  }
  samples.sort((a, b) => a - b);
  return clampToActiveScore({
    p05: roundInterval(percentile(samples, 0.05)),
    p95: roundInterval(percentile(samples, 0.95)),
  }, activeScore, options);
}

function extractDomains(scoreData) {
  const domains = Array.isArray(scoreData?.domains) ? scoreData.domains : [];
  return DOMAIN_ORDER.map((id) => {
    const domain = domains.find((entry) => entry?.id === id);
    const score = Number(domain?.score);
    const weight = Number(domain?.weight ?? DOMAIN_WEIGHTS[id]);
    if (!Number.isFinite(score) || !Number.isFinite(weight)) return null;
    return { id, score, weight };
  }).filter(Boolean);
}

function extractPillars(scoreData) {
  const pillars = Array.isArray(scoreData?.pillars) ? scoreData.pillars : [];
  return PILLAR_ORDER.map((id) => {
    const pillar = pillars.find((entry) => entry?.id === id);
    const score = Number(pillar?.score);
    const weight = Number(pillar?.weight ?? PILLAR_WEIGHTS[id]);
    if (!Number.isFinite(score) || !Number.isFinite(weight)) return null;
    return { id, score, weight };
  }).filter(Boolean);
}

export function domainAggregate(domains) {
  if (!domains.length) return null;
  return round(domains.reduce((sum, domain) => sum + domain.score * domain.weight, 0));
}

export function inferScoreFormula(scoreData, options = {}) {
  const cached = normalizeFormula(scoreData?._formula);
  if (cached) return cached;

  const overallScore = Number(scoreData?.overallScore);
  if (!Number.isFinite(overallScore)) return null;

  const domains = options.domains ?? extractDomains(scoreData);
  const pillars = options.pillars ?? extractPillars(scoreData);
  const d6Score = domainAggregate(domains);
  const pcScore = pillars.length > 0 ? penalizedPillarScore(pillars) : null;
  const d6Diff = d6Score == null ? Number.POSITIVE_INFINITY : Math.abs(overallScore - d6Score);
  const pcDiff = pcScore == null ? Number.POSITIVE_INFINITY : Math.abs(overallScore - pcScore);
  const tolerance = Number(options.tolerance ?? 0.2);

  if (pcDiff <= tolerance && d6Diff > tolerance) return 'pc';
  if (d6Diff <= tolerance && pcDiff > tolerance) return 'd6';
  if (Number.isFinite(pcDiff) || Number.isFinite(d6Diff)) {
    if (pcDiff + 0.05 < d6Diff) return 'pc';
    if (d6Diff + 0.05 < pcDiff) return 'd6';
  }
  return null;
}

export function buildScoreIntervalPayload(scoreData, options = {}) {
  const draws = Math.max(1, Math.floor(Number(options.draws) || DRAWS));
  const overallScore = Number(scoreData?.overallScore);
  if (!Number.isFinite(overallScore)) return null;

  const domains = extractDomains(scoreData);
  const pillars = extractPillars(scoreData);
  const taggedFormula = normalizeFormula(scoreData?._formula);
  const hasFormulaTag = scoreData != null && Object.prototype.hasOwnProperty.call(scoreData, '_formula');
  const formula = taggedFormula
    ?? (!hasFormulaTag && options.allowLegacyFormulaInference
        ? inferScoreFormula(scoreData, { ...options, domains, pillars })
        : null);
  if (!formula) {
    const reason = hasFormulaTag
      ? 'invalid_formula'
      : options.allowLegacyFormulaInference
        ? 'legacy_formula_unresolved'
        : 'missing_formula';
    recordFormulaSkip(options, reason, scoreData);
    return null;
  }

  const interval = formula === 'pc'
    ? (pillars.length > 0
        ? computePillarIntervals(pillars, draws, {
            rng: options.rng,
            activeScore: overallScore,
            diagnostics: options.diagnostics,
            countryCode: scoreData?.countryCode,
            formula,
          })
        : null)
    : (domains.length > 0
        ? computeIntervals(
            domains.map((domain) => domain.score),
            domains.map((domain) => domain.weight),
            draws,
            {
              rng: options.rng,
              activeScore: overallScore,
              diagnostics: options.diagnostics,
              countryCode: scoreData?.countryCode,
              formula,
            },
          )
        : null);
  if (!interval) return null;

  return {
    p05: interval.p05,
    p95: interval.p95,
    _formula: formula,
    draws,
    computedAt: options.computedAt ?? new Date().toISOString(),
    methodology: RESILIENCE_INTERVAL_METHODOLOGY,
  };
}
