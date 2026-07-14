import type { ChinaCountrySummaryGroup, ChinaCountrySummarySignal } from '@/components/CountryBriefPanel';

// Pure state derivation for the China country summary groups. Kept free of
// service/DOM imports so the four-state contract (available/partial/stale/
// unavailable) stays unit-testable without bundling the intel manager.
export function chinaSummaryState(signals: ChinaCountrySummarySignal[], expectedSignals: number): ChinaCountrySummaryGroup['state'] {
  if (signals.length === 0) return 'unavailable';
  if (signals.every((signal) => signal.stale)) return 'stale';
  return signals.length < expectedSignals || signals.some((signal) => signal.stale) ? 'partial' : 'available';
}

// Source-provided timestamps are dates or months ('2026-06', '2025-Q4');
// retrieval timestamps are full ISO strings. Trim the latter to the date part
// so the attribution row never shows a millisecond-precision machine string.
export function toObservedDate(timestamp: string): string {
  const tIndex = timestamp.indexOf('T');
  return tIndex > 0 ? timestamp.slice(0, tIndex) : timestamp;
}
