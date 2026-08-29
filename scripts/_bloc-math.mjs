// Bloc-alignment maths for the AALICE:OpenEYE USA-vs-CHINA monitor (fork-side,
// AMD-003). Pure functions, no I/O — the seeder supplies bars, the client only
// renders the published result.
//
// The signal answers "which bloc's market is this country's market coupled to".
// Each country's daily log returns are regressed on BOTH bloc legs at once:
//
//     r_country = alpha + beta_us * r_usLeg + beta_cn * r_cnLeg + e
//
// Two legs in one regression, deliberately: run two separate single-leg
// regressions and almost every country looks US-correlated, because US tech
// drives global risk appetite and that common factor lands in both slopes. The
// joint fit makes each coefficient conditional on the other, which is what
// makes Taiwan separate from Singapore instead of both reading "US".

/** Daily log returns keyed by bar timestamp. Non-positive prices are dropped. */
export function logReturns(timestamps, closes) {
  const out = new Map();
  for (let i = 1; i < timestamps.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (typeof prev !== 'number' || typeof cur !== 'number') continue;
    if (!(prev > 0) || !(cur > 0)) continue;
    out.set(timestamps[i], Math.log(cur / prev));
  }
  return out;
}

/**
 * Inner-join return maps on their shared timestamps.
 * Trading calendars differ (holidays), so an inner join is the only honest
 * alignment — padding a missing session with zero would fabricate a return.
 */
export function alignReturns(maps) {
  if (maps.length === 0) return { keys: [], series: [] };
  let keys = [...maps[0].keys()];
  for (let i = 1; i < maps.length; i++) {
    const m = maps[i];
    keys = keys.filter((k) => m.has(k));
  }
  keys.sort((a, b) => a - b);
  return { keys, series: maps.map((m) => keys.map((k) => m.get(k))) };
}

/**
 * OLS of y on two regressors, via the demeaned 2x2 normal equations.
 * Returns null when the system is singular (a leg with no variance, or two
 * perfectly collinear legs) or when there are too few observations to trust.
 */
export function fitTwoLeg(y, x1, x2, minObs = 60) {
  const n = y.length;
  if (n < minObs || x1.length !== n || x2.length !== n) return null;

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const my = mean(y), m1 = mean(x1), m2 = mean(x2);

  let s11 = 0, s22 = 0, s12 = 0, s1y = 0, s2y = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const d1 = x1[i] - m1, d2 = x2[i] - m2, dy = y[i] - my;
    s11 += d1 * d1; s22 += d2 * d2; s12 += d1 * d2;
    s1y += d1 * dy; s2y += d2 * dy; syy += dy * dy;
  }

  // Multicollinearity guard, scale-relative rather than an absolute epsilon:
  // det / (s11*s22) is exactly 1 - corr(x1,x2)^2, so this rejects legs that are
  // near-duplicates of each other regardless of how big the returns are. An
  // absolute threshold silently passes tiny-but-degenerate systems and hands
  // back betas of ±1e3 that would paint the map at random.
  const det = s11 * s22 - s12 * s12;
  const scale = s11 * s22;
  if (!(scale > 0) || !(det / scale > 1e-8) || !(syy > 0)) return null;

  const betaUs = (s22 * s1y - s12 * s2y) / det;
  const betaCn = (s11 * s2y - s12 * s1y) / det;
  const alpha = my - betaUs * m1 - betaCn * m2;
  const explained = betaUs * s1y + betaCn * s2y;
  const r2 = Math.max(0, Math.min(1, explained / syy));

  return { alpha, betaUs, betaCn, r2, obs: n };
}

/**
 * Bloc tilt in [-1, +1]: -1 = purely US-coupled, +1 = purely China-coupled.
 * Scale-free, so a high-beta market like Korea and a low-beta one like France
 * are comparable — the map is colouring *direction of coupling*, not amplitude.
 */
export function computeLean(betaUs, betaCn) {
  const denom = Math.abs(betaUs) + Math.abs(betaCn);
  if (!(denom > 0)) return 0;
  return (betaCn - betaUs) / denom;
}

/**
 * Residual series: what the country's market did minus what its bloc betas
 * predicted it would do. This is the "how was this country actually affected"
 * number — a bloc event shows up as an abnormal return on the session after it.
 */
export function abnormalReturns(keys, y, x1, x2, fit) {
  const out = [];
  for (let i = 0; i < y.length; i++) {
    const predicted = fit.alpha + fit.betaUs * x1[i] + fit.betaCn * x2[i];
    out.push({ t: keys[i], ar: y[i] - predicted });
  }
  return out;
}

/** Population standard deviation of the abnormal returns — the AR alert scale. */
export function stdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const m = values.reduce((s, v) => s + v, 0) / n;
  // clamp: accumulated float error can leave the sum of squares fractionally
  // negative for a constant series, and Math.sqrt of that is NaN.
  const variance = Math.max(0, values.reduce((s, v) => s + (v - m) * (v - m), 0) / n);
  return Math.sqrt(variance);
}

/** Full per-country score from aligned return maps. Null if it cannot be fit. */
export function scoreCountry(countryReturns, usReturns, cnReturns, opts = {}) {
  const minObs = opts.minObs ?? 60;
  const arWindow = opts.arWindow ?? 30;
  const { keys, series } = alignReturns([countryReturns, usReturns, cnReturns]);
  const [y, x1, x2] = series;
  const fit = fitTwoLeg(y, x1, x2, minObs);
  if (!fit) return null;

  const ars = abnormalReturns(keys, y, x1, x2, fit);
  const sigma = stdev(ars.map((a) => a.ar));
  return {
    ...fit,
    lean: computeLean(fit.betaUs, fit.betaCn),
    arSigma: sigma,
    recentAr: ars.slice(-arWindow),
  };
}
