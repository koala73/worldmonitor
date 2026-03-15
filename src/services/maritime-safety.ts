/**
 * NGA (National Geospatial-Intelligence Agency) Maritime Safety Information
 * Public JSON API — no authentication required
 * https://msi.nga.mil/api/publications/broadcast-warn
 *
 * Covers: NAVAREA warnings, special warnings, coast guard broadcasts,
 * hydrographic office notices to mariners.
 */

export interface MaritimeWarning {
  id: string;
  msgYear: number;
  msgNumber: number;
  navArea: string;
  subregion: string;
  text: string;
  cancelTime: Date | null;
  issueTime: Date;
  authority: string;
  cancelMsgYear: number | null;
  cancelMsgNumber: number | null;
  source: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'search-rescue' | 'hazard' | 'mine' | 'wreck' | 'cable' | 'military' | 'navigation' | 'other';
}

interface NgaMsiWarning {
  msgYear: number;
  msgNumber: number;
  navArea: string;
  subregion: string;
  text: string;
  cancelTime?: string | null;
  issueTime?: string;
  authority?: string;
  cancelMsgYear?: number | null;
  cancelMsgNumber?: number | null;
  source?: string;
}

interface NgaMsiResponse {
  broadcastWarn?: NgaMsiWarning[];
  items?: NgaMsiWarning[];
}

const NGA_MSI_API = 'https://msi.nga.mil/api/publications/broadcast-warn?includeCountries=&maxSecurity=U&output=json&pageSize=100';
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
let cache: { warnings: MaritimeWarning[]; fetchedAt: number } | null = null;

const HIGH_PRIORITY_TERMS = [
  'search and rescue', 'sar', 'distress', 'mayday', 'sinking', 'capsized',
  'person overboard', 'missing vessel', 'life-threatening', 'icebreaker',
];
const HAZARD_TERMS = [
  'mine', 'wreck', 'obstruction', 'shoal', 'rock', 'reef', 'ice',
  'oil spill', 'chemical', 'debris', 'derelict', 'buoy missing', 'light out',
];
const MILITARY_TERMS = [
  'firing', 'exercise', 'military', 'naval', 'torpedo', 'gunnery', 'live fire',
];

function scoreCategory(text: string): MaritimeWarning['category'] {
  const t = text.toLowerCase();
  if (HIGH_PRIORITY_TERMS.some(k => t.includes(k))) return 'search-rescue';
  if (t.includes('mine')) return 'mine';
  if (t.includes('wreck')) return 'wreck';
  if (t.includes('cable') || t.includes('pipeline')) return 'cable';
  if (MILITARY_TERMS.some(k => t.includes(k))) return 'military';
  if (HAZARD_TERMS.some(k => t.includes(k))) return 'hazard';
  if (t.includes('light') || t.includes('buoy') || t.includes('aid to navigation')) return 'navigation';
  return 'other';
}

function scoreSeverity(category: MaritimeWarning['category']): MaritimeWarning['severity'] {
  switch (category) {
    case 'search-rescue': return 'critical';
    case 'mine': return 'high';
    case 'hazard': return 'high';
    case 'wreck': return 'medium';
    case 'military': return 'medium';
    case 'cable': return 'low';
    case 'navigation': return 'low';
    default: return 'low';
  }
}

function parseDate(str: string | null | undefined): Date | null {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

export async function fetchMaritimeWarnings(): Promise<MaritimeWarning[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.warnings;

  try {
    const res = await fetch(NGA_MSI_API, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return cache?.warnings ?? [];

    const data: NgaMsiResponse = await res.json();
    const items: NgaMsiWarning[] = data.broadcastWarn ?? data.items ?? [];

    const now = Date.now();
    const warnings: MaritimeWarning[] = [];

    for (const w of items) {
      const cancelTime = parseDate(w.cancelTime);
      // Skip canceled warnings
      if (cancelTime && cancelTime.getTime() < now) continue;

      const issueTime = parseDate(w.issueTime) ?? new Date();
      const category = scoreCategory(w.text ?? '');
      const severity = scoreSeverity(category);

      warnings.push({
        id: `maritime-${w.navArea}-${w.msgYear}-${w.msgNumber}`,
        msgYear: w.msgYear,
        msgNumber: w.msgNumber,
        navArea: w.navArea ?? '',
        subregion: w.subregion ?? '',
        text: (w.text ?? '').slice(0, 600),
        cancelTime,
        issueTime,
        authority: w.authority ?? '',
        cancelMsgYear: w.cancelMsgYear ?? null,
        cancelMsgNumber: w.cancelMsgNumber ?? null,
        source: w.source ?? 'NGA MSI',
        severity,
        category,
      });
    }

    // Keep high-severity and recent warnings
    const filtered = warnings
      .filter(w => w.severity === 'critical' || w.severity === 'high' ||
        (Date.now() - w.issueTime.getTime() < 7 * 24 * 60 * 60 * 1000))
      .sort((a, b) => {
        const sOrder: Record<MaritimeWarning['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
        return sOrder[a.severity] - sOrder[b.severity];
      })
      .slice(0, 100);

    cache = { warnings: filtered, fetchedAt: Date.now() };
    return filtered;
  } catch {
    return cache?.warnings ?? [];
  }
}

export function maritimeSeverityClass(severity: MaritimeWarning['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}
