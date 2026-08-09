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
 * | `economic:cbr-rates:v1`    | `{ rates: {...} }`   | RUB per 1 unit of CCY   |
 *
 * Quoting any of them under the wrong base is the failure mode the issue calls
 * out for the RUB table, so the direction is named in every field rather than
 * left to the caller: `usdPerUnit` / `unitsPerUsd` for the USD-quoted keys, a
 * separate EUR-base row type for ECB, and `rubPerUnit` for the Bank of Russia
 * table (issue #6231).
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
 * One Bank of Russia quote row — issue #6231.
 *
 * `rate` is RUB for ONE unit of `currency`, normalised by CBR's `Nominal`
 * multiplier (`scripts/seed-cbr-rates.mjs:200`, `value / nominal`). That is a
 * THIRD quote direction, distinct from both lists already in the panel:
 *
 * | source               | direction              |
 * |----------------------|------------------------|
 * | `shared:fx-rates:v1` | USD per 1 unit of CCY  |
 * | `economic:ecb-fx-rates:v1` | CCY per 1 EUR    |
 * | `economic:cbr-rates:v1`    | **RUB per 1 CCY** |
 *
 * Folding these into either existing table would quote the pair the wrong way
 * round — a USD row would read "1 RUB buys 81 USD" and an ECB row would invert
 * the opposite half. The field is named `rubPerUnit` so the direction survives
 * in the payload that reaches the renderer.
 *
 * `change1d` is RUB per unit, an absolute delta matching the seeder's
 * `cleanFloat(entry.rate - prior.rate)` — NOT a percentage (mirrors the ECB
 * field above). The seeder writes it null when the prior business day's table
 * was unavailable, never 0 (a failed fetch reading as "flat").
 */
export type FxRubQuoteRow = {
  currency: string;
  /** RUB for one unit of `currency` — the raw seeded value. */
  rubPerUnit: number;
  /** Absolute delta in `rubPerUnit` units vs the prior published rate. */
  change1d: number | null;
};

/**
 * Everything the FX panel renders. Declared here rather than in the component
 * so the service layer that assembles it does not have to import from
 * `src/components/` — a direction `npm run lint:boundaries` rejects.
 */
export type FxSourceId = 'stress' | 'usd' | 'eur' | 'rub';

export type FxPanelRows = {
  stress: FxStressRow[];
  usd: FxUsdSpotRow[];
  eur: FxEurSpotRow[];
  rub: FxRubQuoteRow[];
  /**
   * Sources that yielded no usable rows this load.
   *
   * Each source is implausible as a genuine empty — 45 currencies, 47 USD
   * rates, 7 ECB pairs, 54 CBR pairs — so an empty one means that source is
   * down, and the loaders cannot tell us apart from a miss. Naming them lets
   * the panel say a table is *missing* rather than silently rendering as if it
   * never existed, and lets it retry instead of waiting out the 6h refresh.
   */
  degraded: FxSourceId[];
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

/**
 * Which of the three sources came back with nothing.
 *
 * Extracted as a pure function so it is testable: the client loaders return the
 * same value for a transport failure and a cache miss, so this reasoning — that
 * an empty source is a dead source, because none of the three has a plausible
 * genuine empty — is the whole basis for the panel's degraded notice and retry.
 */
export function degradedSources(rows: Omit<FxPanelRows, 'degraded'>): FxSourceId[] {
  const degraded: FxSourceId[] = [];
  if (rows.stress.length === 0) degraded.push('stress');
  if (rows.usd.length === 0) degraded.push('usd');
  if (rows.eur.length === 0) degraded.push('eur');
  if (rows.rub.length === 0) degraded.push('rub');
  return degraded;
}

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
    // A drawdown is a peak-to-trough loss expressed as a percentage of the
    // peak, so it is bounded to [-100, 0]: zero or negative because
    // `scripts/seed-fx-yoy.mjs` seeds 0 and only lowers it, and never past
    // -100 because a rate cannot fall by more than all of itself (the seeder
    // rejects non-positive closes, so the trough is always > 0). Anything
    // outside that range is a malformed record — a positive would paint a green
    // "+7.0%" gain into a loss-only column, and a -250% would render a decline
    // that cannot physically have happened.
    if (drawdown24m === null || drawdown24m > 0 || drawdown24m < -100) continue;

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
 * Project the flat `shared:fx-rates:v1` map onto USD spot rows.
 *
 * The null guard is load-bearing, not defensive. `buildFxRatesPayload`
 * (`scripts/seed-fx-rates.mjs`) writes `payload[currency] = null` for every
 * currency whose live fetch failed and lists them under `fallbackCurrencies`,
 * so a null here means "this rate is a hardcoded constant, not a quote" — and
 * dropping it is exactly right. Rendering those constants as live rates under a
 * "Source: Yahoo Finance" heading was the defect #6220 reported and #6233 fixed
 * upstream; consuming the null is how this panel inherits that fix.
 *
 * `fallbackCurrencies` itself rides in the same flat map as a top-level array.
 * It is skipped by name below purely to document that the map is not uniformly
 * currency-keyed — an array already fails the numeric check, so removing the
 * skip changes no behaviour today. It is here for the reader and for a future
 * where that metadata is not an array.
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
    // Provenance metadata, not a rate (see the note above).
    if (currency === 'fallbackCurrencies') continue;
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

/**
 * Project `economic:cbr-rates:v1` onto RUB quote rows — issue #6231.
 *
 * The seeded payload is `{ quoteCurrency, rateUnit, effectiveDate, rates,
 * keyRate, ... }`, where `rates[code] = { rate, valuePerNominal, nominal,
 * name, numCode, id, change1d }` (`scripts/seed-cbr-rates.mjs:363`).
 *
 * `rate` is RUB per ONE unit of the listed currency (Value / Nominal) — the
 * quoted direction stated in the payload as `rateUnit: 'RUB per 1 unit of the
 * listed currency'`. The `nominal` field is kept in the source specifically so
 * a consumer that reaches for it instead of `rate` is off by that factor and
 * gets caught; this mapper reads `rate` and nothing else.
 *
 * `RUB` itself is skipped — the table's own base quoting "1 RUB = 1 RUB" is
 * the same noise the USD self-quote is in the USD table. Rows with an
 * unusable rate are dropped: the seeder already filters non-positive/NaN
 * rates, but a malformed cache record must not render NaN or a negative
 * inflation either.
 *
 * @param payload the `economic:cbr-rates:v1` value, enveloped or not
 */
export function toRubQuoteRows(payload: unknown): FxRubQuoteRow[] {
  const unwrapped = unwrapEnvelope(payload, 'rates');
  if (!isRecord(unwrapped)) return [];
  const rates = unwrapped.rates;
  if (!isRecord(rates)) return [];

  const rows: FxRubQuoteRow[] = [];
  for (const [currency, value] of Object.entries(rates)) {
    if (currency === 'RUB') continue;
    if (!isRecord(value)) continue;
    const rubPerUnit = finiteNumber(value.rate);
    if (rubPerUnit === null || rubPerUnit <= 0) continue;
    rows.push({ currency, rubPerUnit, change1d: finiteNumber(value.change1d) });
  }

  return rows.sort((a, b) => a.currency.localeCompare(b.currency));
}
