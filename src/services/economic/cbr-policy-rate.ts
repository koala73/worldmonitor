import type { BisPolicyRate } from '@/generated/client/worldmonitor/economic/v1/service_client';

/**
 * Project the Bank of Russia key rate onto the BIS policy-rate row shape.
 *
 * BIS `WS_CBPOL` covers 12 central banks and Russia is not among them
 * (`scripts/seed-bis-data.mjs`), so the Central Banks tab has a hole no upstream
 * change can close — the PBoC, Banco Central do Brasil and the RBI are all
 * there, the CBR is not. `scripts/seed-cbr-rates.mjs` (#6154) publishes the
 * missing rate; this adapts it to the row the tab already renders.
 *
 * The two contracts disagree on nullability, which is the whole reason this is a
 * function rather than an object literal at the call site. `BisPolicyRate`
 * requires `previousRate: number` and `date: string`; the CBR payload leaves
 * `previousRate` and `changedAt` null whenever the queried window shows no rate
 * move. `EconomicPanel.renderCentralBanks` derives its cut/hike/hold arrow from
 * `r.rate - r.previousRate` with no null branch, so passing those straight
 * through would render `NaN` and an arrow that is none of the three states.
 */

const RUSSIA_ROW = {
  countryCode: 'RU',
  countryName: 'Russia',
  centralBank: 'Bank of Russia',
} as const;

type CbrKeyRate = {
  rate?: unknown;
  observedAt?: unknown;
  previousRate?: unknown;
  changedAt?: unknown;
};

/** Seeded keys are written as `{_seed, data}` envelopes; readers vary on unwrapping. */
function unwrap(payload: unknown): { keyRate?: CbrKeyRate } | null {
  if (!payload || typeof payload !== 'object') return null;
  const outer = payload as { data?: unknown; keyRate?: unknown };
  if (outer.keyRate !== undefined) return outer as { keyRate?: CbrKeyRate };
  if (outer.data && typeof outer.data === 'object') return outer.data as { keyRate?: CbrKeyRate };
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * @param payload the `economic:cbr-rates:v1` value, enveloped or not
 * @returns a policy-rate row, or null when the payload carries no usable rate
 */
export function cbrKeyRateAsPolicyRate(payload: unknown): BisPolicyRate | null {
  const keyRate = unwrap(payload)?.keyRate;
  if (!keyRate || typeof keyRate !== 'object') return null;

  const rate = finiteNumber(keyRate.rate);
  if (rate == null) return null;

  // `changedAt` is when the current rate took effect and is the more meaningful
  // label; `observedAt` (the newest observation) is the fallback when the window
  // shows no move. A row with neither is dropped rather than rendered undated.
  const date = nonEmptyString(keyRate.changedAt) ?? nonEmptyString(keyRate.observedAt);
  if (date == null) return null;

  // Falling back to `rate` makes the delta exactly 0, which the tab already
  // renders as HOLD — the honest reading of "no move inside the window we asked
  // for". Any other default would invent a cut or a hike.
  const previousRate = finiteNumber(keyRate.previousRate) ?? rate;

  return { ...RUSSIA_ROW, rate, previousRate, date };
}

/**
 * Append the Russia row to the BIS policy-rate list, if it belongs there.
 *
 * Kept here rather than inline at the call site so the two guards below are
 * reachable by a test — they are the part of this feature most likely to be
 * "simplified" away, and both fail silently if they are.
 *
 * @param bisRates rows BIS supplied, used as-is
 * @param cbrPayload the `economic:cbr-rates:v1` value, or null/undefined
 */
export function mergeCbrPolicyRate(
  bisRates: readonly BisPolicyRate[] | null | undefined,
  cbrPayload: unknown,
): BisPolicyRate[] {
  const rows = [...(bisRates ?? [])];

  // Guard 1 — never carry the list on Russia alone. When BIS returns nothing the
  // tab renders a "no data" empty state; appending one row instead produces a
  // one-bank policy-rate table, which reads as a working feed missing eleven
  // countries rather than as an outage.
  if (rows.length === 0) return rows;

  const russia = cbrKeyRateAsPolicyRate(cbrPayload);
  if (!russia) return rows;

  // Guard 2 — BIS wins if WS_CBPOL ever adds Russia. Appending unconditionally
  // would render two "Bank of Russia" cards with no indication which is which.
  if (rows.some((r) => r.countryCode === russia.countryCode)) return rows;

  rows.push(russia);
  return rows;
}
