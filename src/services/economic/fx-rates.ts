/**
 * Row mappers for the FX panel — issue #6199.
 *
 * Three seeded payloads feed one panel and none of them agree on shape or
 * quote direction, so each gets its own mapper and the three row types never
 * merge into one list:
 *
 * | key                        | shape                | `rate` means            |
 * |----------------------------|----------------------|-------------------------|
 * | `economic:fx:yoy:v1`       | `{ rates: [...] }`   | USD per 1 unit of CCY   |
 * | `shared:fx-rates:v1`       | `{ CCY: number }`    | USD per 1 unit of CCY   |
 * | `economic:ecb-fx-rates:v1` | `{ rates: [...] }`   | CCY per 1 EUR           |
 *
 * Quoting any of them under the wrong base is the failure mode the issue calls
 * out for the RUB table, so the direction is named in every field rather than
 * left to the caller: `usdPerUnit` / `unitsPerUsd` for the USD-quoted keys, and
 * a separate EUR-base row type for ECB.
 *
 * `economic:fx:yoy:v1` in particular had no consumer anywhere in the repo
 * before this panel — a daily cron computing currency-crisis data for 45
 * currencies that nothing read.
 */

/** The Yahoo `{CCY}USD=X` close is USD per one unit of CCY. */
export type FxStressRow = {
  countryCode: string;
  currency: string;
  /** % change vs the bar 12 months ago; negative = depreciation. Null when the anchor bar was missing. */
  yoyChange: number | null;
  /** Worst peak-to-trough % loss over the last 24 monthly bars; never positive. */
  drawdown24m: number;
  /** True when the drawdown reaches the resilience methodology's stress threshold. */
  stressed: boolean;
  peakRate: number | null;
  peakDate: string | null;
  troughRate: number | null;
  troughDate: string | null;
  /** Date of the newest bar backing this row. */
  asOf: string | null;
};

export type FxUsdSpotRow = {
  currency: string;
  /** USD for one unit of `currency` — the raw seeded value. */
  usdPerUnit: number;
  /** Units of `currency` for one USD — the conventional market quote. */
  unitsPerUsd: number;
};

export type FxEurSpotRow = {
  currency: string;
  /** Units of `currency` for one EUR. */
  rate: number;
  /**
   * Day-over-day change as an ABSOLUTE difference in `rate` units — NOT a
   * percentage. `scripts/seed-ecb-fx-rates.mjs:98` computes
   * `+(rate - prev.value).toFixed(6)`, and the pre-existing consumer
   * `src/components/MarketPanel.ts:531` renders it unsuffixed for that reason.
   * Printing it with a `%` would report EURJPY's 0.85 move as "0.9%" when the
   * true change is 0.50%, and would flatten all five sub-2.0 pairs to "0.0%".
   *
   * The seeder writes 0 BOTH when the rate did not move and when there is no
   * prior observation, so 0 cannot be read as "confirmed unchanged". Null here
   * means the field was absent from the payload entirely.
   */
  change1d: number | null;
};

/**
 * Everything the FX panel renders. Declared here rather than in the component
 * so the service layer that assembles it does not have to import from
 * `src/components/` — a direction `npm run lint:boundaries` rejects.
 */
export type FxPanelRows = {
  stress: FxStressRow[];
  usd: FxUsdSpotRow[];
  eur: FxEurSpotRow[];
};

/**
 * The drawdown at which the resilience FX Stress family calls a currency
 * stressed (`scripts/backtest-resilience-outcomes.mjs:348`). Reused here so the
 * panel highlights exactly what the methodology would label, rather than
 * inventing a second, quietly different threshold.
 */
export const FX_STRESS_THRESHOLD_PCT = -15;

/**
 * Display order for the ECB pairs, matching the seven the seeder requests
 * (`scripts/seed-ecb-fx-rates.mjs`). Exported so the CommoditiesPanel FX tab
 * and this panel order the same pairs identically instead of each keeping a
 * private copy — the duplication issue #6199 flags.
 */
export const EUR_FX_ORDER = ['USD', 'GBP', 'JPY', 'CHF', 'CAD', 'CNY', 'AUD'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Seeded keys are stored as `{_seed, data}` envelopes, so accept either shape.
 *
 * On the path these mappers actually take today this is a no-op: the bootstrap
 * endpoint already strips the envelope before the client sees it
 * (`api/bootstrap.js:300` returns `unwrapEnvelope(parsed).data`). The guard is
 * here for any reader that does NOT go through that endpoint — a server handler
 * or a direct cache read — because the failure it prevents is silent: an
 * enveloped payload has no `rates` key, so every mapper would return `[]` and
 * the panel would render an empty state against perfectly good data.
 *
 * `marker` is a key the payload itself always carries; when it is present at
 * the top level the payload is already unwrapped and must be left alone.
 */
function unwrapEnvelope(payload: unknown, marker?: string): unknown {
  if (!isRecord(payload)) return payload;
  if (marker !== undefined && marker in payload) return payload;
  if (isRecord(payload.data)) return payload.data;
  return payload;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Project `economic:fx:yoy:v1` onto stress rows, worst drawdown first.
 *
 * A record is dropped rather than rendered when it has no country/currency or
 * no usable drawdown — the drawdown is the column the tab is built around, and
 * a row without it would render an empty cell that reads as "0% stress".
 * `yoyChange` is independent and may legitimately be null (the 12-month anchor
 * bar can be missing while 24 months of history still exist), so it does not
 * gate the row.
 *
 * @param payload the `economic:fx:yoy:v1` value, enveloped or not
 */
export function toFxStressRows(payload: unknown): FxStressRow[] {
  const unwrapped = unwrapEnvelope(payload, 'rates');
  if (!isRecord(unwrapped)) return [];
  const rates = unwrapped.rates;
  if (!Array.isArray(rates)) return [];

  const rows: FxStressRow[] = [];
  for (const entry of rates) {
    if (!isRecord(entry)) continue;
    const countryCode = nonEmptyString(entry.countryCode);
    const currency = nonEmptyString(entry.currency);
    if (countryCode === null || currency === null) continue;
    const drawdown24m = finiteNumber(entry.drawdown24m);
    // A drawdown is a peak-to-trough loss: zero or negative, never positive
    // (`scripts/seed-fx-yoy.mjs` seeds 0 and only lowers it). A positive value
    // is a malformed record, and rendering it would paint a green "+7.0%" gain
    // into a column that can only ever show a loss.
    if (drawdown24m === null || drawdown24m > 0) continue;

    rows.push({
      countryCode,
      currency,
      yoyChange: finiteNumber(entry.yoyChange),
      drawdown24m,
      stressed: drawdown24m <= FX_STRESS_THRESHOLD_PCT,
      peakRate: finiteNumber(entry.peakRate),
      peakDate: nonEmptyString(entry.peakDate),
      troughRate: finiteNumber(entry.troughRate),
      troughDate: nonEmptyString(entry.troughDate),
      asOf: nonEmptyString(entry.asOf),
    });
  }

  // Worst first — the panel exists to surface currency collapses, so the
  // deepest drawdown must be the first thing read. Currency breaks ties so the
  // order is stable across refreshes rather than following Object key order.
  return rows.sort((a, b) => a.drawdown24m - b.drawdown24m || a.currency.localeCompare(b.currency));
}

/**
/**
 * Project the flat `shared:fx-rates:v1` map onto USD spot rows.
 *
 * The null/zero guard below is defensive, NOT the failure path it looks like:
 * `seed-fx-rates.mjs:52` writes `fallbacks[currency] ?? null`, but
 * `SHARED_FX_FALLBACKS` (`scripts/_seed-utils.mjs:190-201`) covers all 47
 * currencies, so a failed fetch silently publishes a hardcoded constant rather
 * than null. Those constants are indistinguishable from a real quote at this
 * layer and are presently rendered as live rates — see #6220. The fix belongs
 * in the seeder, which also feeds the bigmac and grocery-basket conversions,
 * so it is deliberately not attempted here.
 *
 * @param payload the `shared:fx-rates:v1` value, enveloped or not
 */
export function toUsdSpotRows(payload: unknown): FxUsdSpotRow[] {
  const unwrapped = unwrapEnvelope(payload);
  if (!isRecord(unwrapped)) return [];

  const rows: FxUsdSpotRow[] = [];
  for (const [currency, value] of Object.entries(unwrapped)) {
    // The dollar's own row would read "1 USD = 1 USD".
    if (currency === 'USD') continue;
    const usdPerUnit = finiteNumber(value);
    if (usdPerUnit === null || usdPerUnit <= 0) continue;
    // Check the inverse itself, not just its input: a positive denormal
    // (Number.MIN_VALUE) clears every guard above and still divides to
    // Infinity, which formatRate would render into the DOM as a bare infinity
    // sign under a live-rate heading.
    const unitsPerUsd = 1 / usdPerUnit;
    if (!Number.isFinite(unitsPerUsd)) continue;
    rows.push({ currency, usdPerUnit, unitsPerUsd });
  }

  return rows.sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Project the ECB reference rates onto EUR-base rows.
 *
 * Only `EURXXX` pairs are accepted: the tab's footer attributes the rates to
 * the ECB, whose reference rates are euro-base by definition, so a pair quoted
 * any other way round does not belong in this list.
 *
 * @param rates the `rates` array from `getEcbFxRatesData()`
 */
export function toEurSpotRows(rates: unknown): FxEurSpotRow[] {
  if (!Array.isArray(rates)) return [];

  const rows: FxEurSpotRow[] = [];
  for (const entry of rates) {
    if (!isRecord(entry)) continue;
    const pair = nonEmptyString(entry.pair);
    if (pair === null || pair.length !== 6 || !pair.startsWith('EUR')) continue;
    const rate = finiteNumber(entry.rate);
    if (rate === null || rate <= 0) continue;
    rows.push({ currency: pair.slice(3), rate, change1d: finiteNumber(entry.change1d) });
  }

  // The seven seeded pairs lead, in the order the CommoditiesPanel FX tab
  // already shows them. Anything the seeder starts publishing beyond that set
  // is appended rather than dropped, so new coverage surfaces on its own.
  const rank = new Map(EUR_FX_ORDER.map((ccy, i) => [ccy as string, i]));
  return rows.sort((a, b) => {
    const ra = rank.get(a.currency) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.currency) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || a.currency.localeCompare(b.currency);
  });
}
