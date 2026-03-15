/**
 * FAA Temporary Flight Restrictions (TFRs)
 * Public XML feed — no authentication required
 * https://tfr.faa.gov/save_pages/detail_list.xml
 *
 * Emergency-class TFRs signal real-world hazards:
 *  - Type 11: Hazard (wildfire, toxic spill, disaster)
 *  - Type 3/4: Security (air defense, national security)
 *  - Type 14: Space operations (launch corridor hazard)
 */

export interface FaaTfr {
  id: string;
  notamId: string;
  facilityDesig: string;
  type: string;
  state: string;
  city: string;
  effectiveStart: Date;
  effectiveEnd: Date | null;
  description: string;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const TFR_FEED = 'https://tfr.faa.gov/save_pages/detail_list.xml';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cache: { tfrs: FaaTfr[]; fetchedAt: number } | null = null;

// TFR types that indicate emergency/hazard conditions
const EMERGENCY_TYPES: Record<string, FaaTfr['severity']> = {
  'HAZARD': 'high',
  'SECURITY': 'critical',
  'DISASTER': 'high',
  'EMERGENCY': 'high',
  'SPACE OPS': 'medium',
  'AIR SHOW': 'low',
  'VIP': 'low',
};

function scoreSeverity(type: string, notamClass: string): FaaTfr['severity'] {
  const t = type.toUpperCase();
  const c = notamClass.toUpperCase();
  if (c.includes('SECURITY') || t.includes('SECURITY')) return 'critical';
  if (t.includes('HAZARD') || t.includes('DISASTER') || t.includes('EMERGENCY')) return 'high';
  if (t.includes('SPACE')) return 'medium';
  for (const [k, v] of Object.entries(EMERGENCY_TYPES)) {
    if (t.includes(k)) return v;
  }
  return 'low';
}

function parseDate(str: string | null | undefined): Date | null {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function getText(el: Element, tag: string): string {
  return el.querySelector(tag)?.textContent?.trim() ?? '';
}

export async function fetchFaaTfrs(): Promise<FaaTfr[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.tfrs;

  try {
    const proxyUrl = `/api/rss-proxy?url=${encodeURIComponent(TFR_FEED)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return cache?.tfrs ?? [];

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return cache?.tfrs ?? [];

    const items = doc.querySelectorAll('NOTAM, notam, TFR, tfr');
    if (items.length === 0) {
      // Try generic item tags
      const rows = doc.querySelectorAll('item');
      if (rows.length === 0) return cache?.tfrs ?? [];
    }

    const now = Date.now();
    const tfrs: FaaTfr[] = [];

    // Parse the FAA TFR XML structure
    const notams = doc.querySelectorAll('NOTAM');
    for (const notam of Array.from(notams)) {
      const notamId = getText(notam, 'notamID') || getText(notam, 'NOTAMID');
      const facilityDesig = getText(notam, 'facilityDesig') || getText(notam, 'FACILITYDESIG');
      const type = getText(notam, 'type') || getText(notam, 'TYPE');
      const state = getText(notam, 'state') || getText(notam, 'STATE');
      const city = getText(notam, 'city') || getText(notam, 'CITY');
      const startStr = getText(notam, 'effectiveStart') || getText(notam, 'EFFECTIVESTART');
      const endStr = getText(notam, 'effectiveEnd') || getText(notam, 'EFFECTIVEEND');
      const notamClass = getText(notam, 'classification') || getText(notam, 'CLASS') || '';

      const start = parseDate(startStr) ?? new Date();
      const end = parseDate(endStr);

      // Skip expired TFRs
      if (end && end.getTime() < now) continue;

      const severity = scoreSeverity(type, notamClass);
      const description = `TFR ${notamId}: ${type} near ${city}, ${state}`.trim();

      tfrs.push({
        id: `tfr-${notamId || `${facilityDesig}-${startStr}`}`,
        notamId,
        facilityDesig,
        type,
        state,
        city,
        effectiveStart: start,
        effectiveEnd: end,
        description,
        url: `https://tfr.faa.gov/tfr2/list.jsp`,
        severity,
      });
    }

    // Filter to emergency/hazard types only for alert purposes
    const alertable = tfrs
      .filter(t => t.severity === 'critical' || t.severity === 'high')
      .sort((a, b) => b.effectiveStart.getTime() - a.effectiveStart.getTime())
      .slice(0, 50);

    cache = { tfrs: alertable, fetchedAt: Date.now() };
    return alertable;
  } catch {
    return cache?.tfrs ?? [];
  }
}

export function tfrSeverityClass(severity: FaaTfr['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}
