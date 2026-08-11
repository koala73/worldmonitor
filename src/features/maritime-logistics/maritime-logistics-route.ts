/**
 * URL, viewport and vessel-admission contract for the owned maritime
 * logistics workspace. Keeping these rules DOM-free makes the critical
 * no-global-fallback and stale-position invariants directly testable.
 */

export const MARITIME_LOGISTICS_PATH = '/maritime-logistics';

export type MaritimeFocusAreaId =
  | 'suez'
  | 'panama'
  | 'malacca'
  | 'hormuz'
  | 'bab-el-mandeb'
  | 'dover';

export type MaritimeFocusArea = {
  id: MaritimeFocusAreaId;
  label: string;
  description: string;
  swLat: number;
  swLon: number;
  neLat: number;
  neLon: number;
};

export type AisPositionCandidate = {
  mmsi: string;
  lat: number;
  lon: number;
  timestamp: number;
};

// Every viewport remains within Maritime v1's 10-degree server limit. A
// focused request is intentional: the relay must never answer a moved map
// with a cached, arbitrary global vessel subset.
export const MARITIME_FOCUS_AREAS: readonly MaritimeFocusArea[] = [
  {
    id: 'suez', label: '苏伊士运河', description: '埃及地峡与红海北端',
    swLat: 24, swLon: 29, neLat: 34, neLon: 39,
  },
  {
    id: 'panama', label: '巴拿马运河', description: '中美洲运河两端',
    swLat: 5, swLon: -84, neLat: 15, neLon: -74,
  },
  {
    id: 'malacca', label: '马六甲海峡', description: '马来半岛与苏门答腊之间',
    swLat: -2, swLon: 98, neLat: 8, neLon: 108,
  },
  {
    id: 'hormuz', label: '霍尔木兹海峡', description: '波斯湾出口',
    swLat: 22, swLon: 52, neLat: 30, neLon: 60,
  },
  {
    id: 'bab-el-mandeb', label: '曼德海峡', description: '红海与亚丁湾之间',
    swLat: 8, swLon: 38, neLat: 18, neLon: 48,
  },
  {
    id: 'dover', label: '多佛海峡', description: '英吉利海峡最窄水域',
    swLat: 46, swLon: -4, neLat: 56, neLon: 6,
  },
] as const;

export const DEFAULT_MARITIME_FOCUS: MaritimeFocusAreaId = 'suez';

export function isMaritimeLogisticsPath(pathname: string): boolean {
  return /^\/maritime-logistics\/?$/.test(pathname);
}

export function maritimeFocusArea(raw: string | null | undefined): MaritimeFocusArea {
  const id = String(raw ?? '').trim().toLowerCase() as MaritimeFocusAreaId;
  return MARITIME_FOCUS_AREAS.find((area) => area.id === id)
    ?? MARITIME_FOCUS_AREAS.find((area) => area.id === DEFAULT_MARITIME_FOCUS)!;
}

export function maritimeLogisticsUrl(focus: MaritimeFocusAreaId = DEFAULT_MARITIME_FOCUS): string {
  return `${MARITIME_LOGISTICS_PATH}?focus=${encodeURIComponent(focus)}`;
}

export function isWithinMaritimeFocus(candidate: Pick<AisPositionCandidate, 'lat' | 'lon'>, focus: MaritimeFocusArea): boolean {
  return Number.isFinite(candidate.lat)
    && Number.isFinite(candidate.lon)
    && candidate.lat >= focus.swLat
    && candidate.lat <= focus.neLat
    && candidate.lon >= focus.swLon
    && candidate.lon <= focus.neLon;
}

export function selectVerifiedAisReports<T extends AisPositionCandidate>(
  reports: readonly T[] | undefined,
  focus: MaritimeFocusArea,
  maxResults = 250,
): T[] {
  const newestByMmsi = new Map<string, T>();
  for (const report of reports ?? []) {
    const mmsi = String(report.mmsi ?? '').trim();
    if (!/^\d{9}$/.test(mmsi)) continue;
    if (!Number.isFinite(report.timestamp) || report.timestamp <= 0) continue;
    if (!isWithinMaritimeFocus(report, focus)) continue;
    const previous = newestByMmsi.get(mmsi);
    if (!previous || report.timestamp > previous.timestamp) {
      newestByMmsi.set(mmsi, report);
    }
  }
  return [...newestByMmsi.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, Math.max(1, maxResults));
}
