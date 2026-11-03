// Shared market number formatters. Kept off the `@/utils` barrel so Node tests
// can import pulse HTML without loading `proxy.ts` → `import.meta.env.DEV`.

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// Two fraction digits round every positive price under half a cent to "$0.00".
// Sub-cent prices keep up to 8 fraction digits (enough for 1e-8). Anything
// smaller would still print as zero, so it uses an explicit floor instead of a
// long or scientific digit string.
const SUB_CENT_ABS = 0.01;
const MIN_DISPLAYED_ABS = 1e-8;

function formatTinyPrice(price: number): string {
  const floor = MIN_DISPLAYED_ABS.toLocaleString(undefined, { maximumFractionDigits: 8 });
  return price < 0 ? `>-$${floor}` : `<$${floor}`;
}

export function formatPrice(price: number | null | undefined): string {
  if (!isFiniteNumber(price)) return '--';
  const abs = Math.abs(price);
  if (price !== 0 && abs < SUB_CENT_ABS) {
    if (abs < MIN_DISPLAYED_ABS) return formatTinyPrice(price);
    return `$${price.toLocaleString(undefined, { maximumFractionDigits: 8 })}`;
  }
  if (price >= 1000) {
    return `$${price.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  }
  // Sub-dollar quotes (the old token list used six places) keep extra digits.
  // A one-cent price still shows two places, so $0.50 does not become $0.5.
  if (abs < 1) {
    return `$${price.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })}`;
  }
  return `$${price.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatChange(change: number | null | undefined): string {
  if (!isFiniteNumber(change)) return '--';
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

export function getChangeClass(change: number | null | undefined): string {
  if (!isFiniteNumber(change)) return '';
  return change >= 0 ? 'up' : 'down';
}

export function getHeatmapClass(change: number | null | undefined): string {
  if (!isFiniteNumber(change)) return '';
  const abs = Math.abs(change);
  const direction = change >= 0 ? 'up' : 'down';

  if (abs >= 2) return `${direction}-3`;
  if (abs >= 1) return `${direction}-2`;
  return `${direction}-1`;
}
