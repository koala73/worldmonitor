// @ts-check
// Shared helpers for snapshot compute modules.

import { stripSeedEnvelope } from '../_seed-envelope-source.mjs';

/** Clamp a number to the [lo, hi] range. */
export function clip(value, lo, hi) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/** Safe numeric coercion with default fallback. */
export function num(value, fallback = 0) {
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Weighted average. Returns 0 if all weights are zero. */
export function weightedAverage(items, valueFn, weightFn) {
  let weighted = 0;
  let total = 0;
  for (const item of items) {
    const w = weightFn(item);
    weighted += valueFn(item) * w;
    total += w;
  }
  return total > 0 ? weighted / total : 0;
}

/** Percentile (0-100) of a numeric array. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Simple UUID v7-ish: time-ordered, sortable, no external deps. */
export function generateSnapshotId() {
  const t = Date.now().toString(16).padStart(12, '0');
  const r = Math.random().toString(16).slice(2, 14).padStart(12, '0');
  return `${t}-${r}`;
}

/**
 * Unwrap the `{ _seed, data }` envelope written by the relay's envelopeWrite-based
 * seeders (cross-source-signals, forecasts, national-debt, transit-summaries, …)
 * so the compute modules — which read flat fields like `.signals`, `.predictions`,
 * `.entries`, `.summaries` — see the payload shape they were written for.
 *
 * Without this, `sources['intelligence:cross-source-signals:v1'].signals` is
 * `undefined` (the signals live at `.data.signals`), so coercive_pressure scored
 * 0 for every region and the regime engine reported a flat `calm` regardless of
 * actual conflict. Flat payloads (no `_seed`) pass through unchanged.
 *
 * Freshness classification (freshness.mjs) keeps working after the unwrap: every
 * enveloped input either declares a companion seed-meta key or carries its own
 * timestamp inside `data` (forecast `generatedAt`, debt `seededAt`, transit
 * `fetchedAt`) — and forecast:predictions:v2, whose `generatedAt` was hidden one
 * level down, now dates correctly instead of reading as present-but-undated.
 *
 * Uses the repo's canonical seed-envelope contract: only well-formed envelopes
 * with a numeric `_seed.fetchedAt` unwrap. Malformed `_seed` objects pass through
 * unchanged so seed-contract violations stay visible instead of being silently
 * accepted as valid regional inputs.
 *
 * @template T
 * @param {T} parsed
 * @returns {T | unknown}
 */
export function unwrapEnvelope(parsed) {
  return stripSeedEnvelope(parsed);
}
