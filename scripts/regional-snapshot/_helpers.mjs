// @ts-check
// Shared helpers for snapshot compute modules.

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
