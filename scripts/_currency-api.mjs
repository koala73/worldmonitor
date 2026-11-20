// Second exchange-rate source for seed-fx-yoy, used only for a currency whose
// Yahoo quotes are unusable. The fawazahmed0 currency-api (CC0) publishes one
// dated snapshot of every currency against USD per day, so eleven requests
// give five sessions at each end of the window for all currencies at once. On
// 2026-11-13 it read the Qatari riyal and Bahraini dinar pegs as flat and
// agreed with Yahoo on the Egyptian pound to 0.03 points (6.30 against 6.27).
import { CHROME_UA } from './_seed-utils.mjs';

const DAY_MS = 86_400_000;
const CURRENCY_API_TIMEOUT_MS = 10_000;
const FALLBACK_MIN_SESSIONS = 3;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The project serves each day's tables from a dated subdomain of this host.
const CURRENCY_API_BASE = 'https://currency-api.pages.dev';

async function fetchCurrencyApiSnapshot(date) {
  const snapshotUrl = `${CURRENCY_API_BASE.replace('https://', `https://${date}.`)}/v1/currencies/usd.min.json`;
  const resp = await fetch(snapshotUrl, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(CURRENCY_API_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`currency-api ${date} HTTP ${resp.status}`);
  const usd = (await resp.json())?.usd;
  if (!usd || typeof usd !== 'object') throw new Error(`currency-api ${date} has no usd table`);
  return { date, usd };
}

/** Snapshots for the newest `points` days up to `nowMs` and the `points` days centred `windowDays` before the newest. */
export async function fetchFallbackWindows(nowMs = Date.now(), { windowDays = 90, points = 5, fetchSnapshot = fetchCurrencyApiSnapshot } = {}) {
  const collect = async (days) => (await Promise.allSettled(days.map((ms) => fetchSnapshot(isoDay(ms)))))
    .flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  // Today's snapshot may not be published yet, so look back one extra day and keep the newest.
  const late = (await collect(Array.from({ length: points + 1 }, (_, d) => nowMs - d * DAY_MS))).slice(0, points);
  if (late.length < FALLBACK_MIN_SESSIONS) return null;
  const centre = Date.parse(late[0].date) - windowDays * DAY_MS;
  const half = points >> 1;
  const early = await collect(Array.from({ length: points }, (_, i) => centre + (half - i) * DAY_MS));
  if (early.length < FALLBACK_MIN_SESSIONS) return null;
  return { late, early, anchorDate: isoDay(centre) };
}

/** The same shape as cleanDailyQuotes in seed-fx-yoy, from the second source. Null when it cannot cover the currency. */
export function fallbackDailyQuotes(currency, windows) {
  if (!windows) return null;
  const code = String(currency).toLowerCase();
  // The table quotes units of the currency per USD; the Yahoo series is USD per unit.
  const values = (snapshots) => snapshots.map((s) => 1 / s.usd?.[code]).filter((v) => Number.isFinite(v) && v > 0);
  const late = values(windows.late), early = values(windows.early);
  if (late.length < FALLBACK_MIN_SESSIONS || early.length < FALLBACK_MIN_SESSIONS) return null;
  return {
    asOf: windows.late[0].date,
    latest: median(late),
    anchor: { date: windows.anchorDate, value: median(early) },
    sessions: late.length + early.length,
    noiseShare: null,
    reliable: true,
    source: 'currency-api',
  };
}
