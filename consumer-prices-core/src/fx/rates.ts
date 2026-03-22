/**
 * Static FX rates: local currency → USD.
 * Approximate mid-market rates, updated periodically.
 * Source: major central bank published rates / ECB reference rates.
 *
 * Update RATES_DATE and rates together when refreshing. Pegged currencies
 * (AED, SAR, QAR) are stable; floating currencies (BRL, KES, INR) can
 * drift 20-30%/year — refresh quarterly.
 */
export const RATES_DATE = '2026-03';

export const FX_RATES_TO_USD: Record<string, number> = {
  USD: 1,
  AED: 0.2723,  // UAE dirham (fixed peg ~3.673)
  SAR: 0.2667,  // Saudi riyal (fixed peg ~3.75)
  GBP: 1.275,
  EUR: 1.08,
  CHF: 1.115,
  SGD: 0.745,
  AUD: 0.635,
  CAD: 0.735,
  INR: 0.012,
  BRL: 0.180,
  KES: 0.0077,
  NGN: 0.00065,
  ZAR: 0.054,
  PKR: 0.0036,
  EGP: 0.020,
  KWD: 3.27,
  QAR: 0.2747,
  BHD: 2.653,
  OMR: 2.597,
};
