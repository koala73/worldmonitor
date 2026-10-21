// Shared market number formatters. Kept off the `@/utils` barrel so Node tests
// can import pulse HTML without loading `proxy.ts` → `import.meta.env.DEV`.

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatPrice(price: number | null | undefined): string {
  if (!isFiniteNumber(price)) return '--';
  if (price >= 1000) {
    return `$${price.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
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
