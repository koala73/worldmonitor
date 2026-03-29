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

/** @param {string|undefined} name @returns {string} */
function normalizeCountry(name) {
  return (name ?? '').trim().toLowerCase();
}

/**
 * @param {number[]} window
 * @returns {{ mean: number, stddev: number }}
 */
export function computeWindowStats(window) {
  if (window.length === 0) return { mean: 0, stddev: 0 };

  const mean = window.reduce((s, v) => s + v, 0) / window.length;

  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  const stddev = Math.sqrt(variance);

  return { mean, stddev };
}

/**
 * @param {Map<string,any>} priorWindows
 * @param {any[]} acledEvents  — each has event_date: 'YYYY-MM-DD'
 * @param {any[]} ucdpEvents   — each has date_start: 'YYYY-MM-DD' and country/country_name
 * @param {number} [nowMs]
 * @returns {Map<string, WindowState>}
 */
export function computeEmaWindows(priorWindows, acledEvents, ucdpEvents, nowMs = Date.now()) {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;

  /** @type {Map<string, number>} */
  const counts24h = new Map();

  const safeAcled = Array.isArray(acledEvents) ? acledEvents : [];
  const safeUcdp = Array.isArray(ucdpEvents) ? ucdpEvents : [];

  for (const ev of safeAcled) {
    const country = normalizeCountry(ev?.country);
    if (!country) continue;
    const ts = Date.parse(ev.event_date);
    if (Number.isFinite(ts) && ts >= cutoff) {
      counts24h.set(country, (counts24h.get(country) ?? 0) + 1);
    }
  }

  for (const ev of safeUcdp) {
    const country = normalizeCountry(ev?.country ?? ev?.country_name);
    if (!country) continue;
    const ts = Date.parse(ev.date_start);
    if (Number.isFinite(ts) && ts >= cutoff) {
      counts24h.set(country, (counts24h.get(country) ?? 0) + 1);
    }
  }

  const safePrior = priorWindows instanceof Map ? priorWindows : new Map();
  const allCountries = new Set([...safePrior.keys(), ...counts24h.keys()]);

  /** @type {Map<string, WindowState>} */
  const updated = new Map();

  for (const country of allCountries) {
    const count = counts24h.get(country) ?? 0;
    const prior = safePrior.get(country) ?? null;
    const ws = updateWindow(country, count, prior);
    updated.set(country, ws);
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

    const zscore = state.stddev > 0 ? (state.ema - state.mean) / state.stddev : 0;
    const risk24h = Math.min(100, Math.max(0, Math.round(50 + zscore * 20)));
    const velocitySpike = risk24h >= 75;

    result.set(country, { risk24h, zscore, velocitySpike, region: country });
  }

  return result;
}
