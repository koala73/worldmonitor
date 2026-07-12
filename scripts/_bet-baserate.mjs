// Base-rate probability for bet-engine forecasts (Phase 1 / #5233 re-engine).
//
// An honest, non-50%-default placeholder probability computed from how often a
// metric has historically moved across the bet's threshold, before the LLM
// ensemble (Phase 2) takes over. Pure: caller supplies the historical series.
//
// The bet asks "will the metric satisfy operator(threshold) at the horizon,
// starting from baselineValue?". We estimate P from the empirical frequency of
// single-period moves large enough to cross the threshold, Laplace-smoothed
// toward a neutral prior so thin samples never emit a hard 0/1 (or a lazy 0.5).

const PRIOR_ALPHA = 1; // Laplace pseudo-count for "crosses"
const PRIOR_BETA = 1;  // Laplace pseudo-count for "does not cross"
const NEUTRAL_PRIOR = 0.5;

export function baseRateProbability(series, spec, options = {}) {
  const values = (Array.isArray(series) ? series : [])
    .map(Number)
    .filter((v) => Number.isFinite(v));
  const baseline = Number(spec?.baselineValue ?? values[values.length - 1]);
  const threshold = Number(spec?.threshold);

  if (!Number.isFinite(threshold) || !Number.isFinite(baseline)) {
    return { probability: NEUTRAL_PRIOR, method: 'prior', n: 0, crossed: 0 };
  }

  // Required signed move from baseline to reach the threshold. Direction is
  // carried by its sign (the resolver's 'crosses' operator is direction-aware
  // via baseline-vs-threshold), so we never depend on an operator string.
  const requiredDelta = threshold - baseline;
  const wantDown = requiredDelta < 0;

  // Period-over-period deltas from the historical series.
  const deltas = [];
  for (let i = 1; i < values.length; i += 1) deltas.push(values[i] - values[i - 1]);

  if (deltas.length === 0) {
    // No history — soft directional prior (bets ask for a move away from
    // baseline, so lean slightly against by default) without a hard 0.5.
    return { probability: 0.4, method: 'prior_directional', n: 0, crossed: 0 };
  }

  let crossed = 0;
  for (const delta of deltas) {
    if (wantDown) {
      if (delta <= requiredDelta) crossed += 1; // requiredDelta is negative for a downward bet
    } else {
      if (delta >= requiredDelta) crossed += 1;
    }
  }

  const smoothed = (crossed + PRIOR_ALPHA) / (deltas.length + PRIOR_ALPHA + PRIOR_BETA);
  return {
    probability: round(clamp01(smoothed)),
    method: 'empirical_move_frequency',
    n: deltas.length,
    crossed,
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1_000_000) / 1_000_000;
}
