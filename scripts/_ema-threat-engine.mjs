// @ts-check
/**
 * EMA-based threat velocity engine for conflict data.
 * Pure functions — no Redis, no side effects.
 */

const ALPHA = 0.3;
const MIN_WINDOW = 6; // min points before z-score is meaningful

/**
 * @typedef {{ region: string, window: number[], ema: number, mean: number, stddev: number, updatedAt: number }} WindowState
 */

/**
 * @param {string} region
 * @param {number} count
 * @param {WindowState|null} prior - prior WindowState or null
 * @returns {WindowState}
 */
export function updateWindow(region, count, prior) {
  const prevWindow = Array.isArray(prior?.window) ? prior.window : [];
  const window = [...prevWindow, count].slice(-24);

  const prevEma = typeof prior?.ema === 'number' ? prior.ema : count;
  const ema = ALPHA * count + (1 - ALPHA) * prevEma;

  const { mean, stddev } = computeWindowStats(window);

  return { region, window, ema, mean, stddev, updatedAt: Date.now() };
}

/**
 * @param {number[]} window
 * @returns {{ ema: number, mean: number, stddev: number }}
 */
export function computeWindowStats(window) {
  if (window.length === 0) return { ema: 0, mean: 0, stddev: 0 };

  const mean = window.reduce((s, v) => s + v, 0) / window.length;

  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  const stddev = Math.sqrt(variance);

  const last = window[window.length - 1] ?? 0;
  let ema = window[0] ?? 0;
  for (let i = 1; i < window.length; i++) {
    ema = ALPHA * window[i] + (1 - ALPHA) * ema;
  }

  return { ema, mean, stddev };
}

/**
 * @param {Map<string,any>} priorWindows - prior state from Redis (null-safe)
 * @param {any[]} acledEvents - array of { country: string } ACLED events
 * @param {any[]} ucdpEvents - array of { country: string, country_name?: string } UCDP events
 * @returns {Map<string, WindowState>}
 */
export function computeEmaWindows(priorWindows, acledEvents, ucdpEvents) {
  /** @type {Map<string, number>} */
  const counts = new Map();

  const safeAcled = Array.isArray(acledEvents) ? acledEvents : [];
  const safeUcdp = Array.isArray(ucdpEvents) ? ucdpEvents : [];

  for (const e of safeAcled) {
    const country = (e?.country ?? '').toString().toLowerCase().trim();
    if (!country) continue;
    counts.set(country, (counts.get(country) ?? 0) + 1);
  }

  for (const e of safeUcdp) {
    const country = ((e?.country ?? e?.country_name ?? '')).toString().toLowerCase().trim();
    if (!country) continue;
    counts.set(country, (counts.get(country) ?? 0) + 1);
  }

  /** @type {Map<string, WindowState>} */
  const updated = new Map();

  for (const [country, count] of counts) {
    const prior = priorWindows instanceof Map ? (priorWindows.get(country) ?? null) : null;
    updated.set(country, updateWindow(country, count, prior));
  }

  return updated;
}

/**
 * @param {Map<string, WindowState>} windows
 * @returns {Map<string, { risk24h: number, zscore: number, velocitySpike: boolean, region: string }>}
 */
export function computeRisk24h(windows) {
  /** @type {Map<string, { risk24h: number, zscore: number, velocitySpike: boolean, region: string }>} */
  const result = new Map();

  for (const [country, state] of windows) {
    if (state.window.length < MIN_WINDOW) {
      result.set(country, { risk24h: 0, zscore: 0, velocitySpike: false, region: country });
      continue;
    }

    const currentCount = state.window[state.window.length - 1] ?? 0;
    const zscore = state.stddev === 0 ? 0 : (currentCount - state.mean) / state.stddev;
    const risk24h = Math.min(100, Math.max(0, Math.round(50 + zscore * 20)));
    const velocitySpike = risk24h >= 75;

    result.set(country, { risk24h, zscore, velocitySpike, region: country });
  }

  return result;
}
