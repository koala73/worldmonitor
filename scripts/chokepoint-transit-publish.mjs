/**
 * Today's transits are AIS-window counts. The seeder zero-fills
 * `todayTotal` when that window is empty (`relayTransit?.total ?? 0`) while
 * `dataAvailable` only means PortWatch history exists. A finite 0 is
 * therefore unsupplied, not a published measurement (#7457 / #7370 class).
 */

function formatCount(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function publishedTransitCountLabel(value) {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number'
    ? value
    : Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return typeof value === 'string' ? String(value).trim() : formatCount(numeric);
}

export function withheldTransitCountSentence(displayName) {
  const name = String(displayName || '').trim() || 'this chokepoint';
  return `World Monitor is not currently publishing a transit count for ${name}; the AIS-derived feed has no data for this period.`;
}
