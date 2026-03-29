/**
 * FAA National Airspace System (NAS) Status
 * Fetches real-time delay and ground stop data from the FAA Airport Status API.
 * https://services.faa.gov/airport/status/{IATA}?format=application/json
 *
 * Free, no authentication, CORS-enabled.
 */

export type NasDelayType = 'departure' | 'arrival' | 'ground-stop' | 'ground-delay' | 'closure' | 'general';

export interface NasDelay {
  id: string;
  airport: string;         // IATA code e.g. "EWR"
  airportName: string;
  city: string;
  state: string;
  delayType: NasDelayType;
  avgDelayMinutes: number | null; // parsed from "2 hrs 15 mins" → 135
  reason: string;
  weather: string;
  pubDate: Date;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface NasStatus {
  delays: NasDelay[];
  totalDelayed: number;
  fetchedAt: Date;
}

const MONITORED_AIRPORTS = [
  'ATL', 'LAX', 'ORD', 'DFW', 'JFK', 'SFO', 'SEA', 'DEN', 'LAS', 'MCO',
  'MIA', 'PHX', 'BOS', 'EWR', 'MSP', 'DTW', 'FLL', 'CLT', 'PHL', 'IAH',
  'IAD', 'BWI', 'SLC', 'MDW', 'PDX',
];

const FAA_BASE = 'https://services.faa.gov/airport/status';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — time-sensitive
let cache: { status: NasStatus; fetchedAt: number } | null = null;

interface FaaAirportStatus {
  IATA?: string;
  city?: string;
  state?: string;
  name?: string;
  delay?: boolean;
  delayCount?: number;
  status?: {
    type?: string;
    avgDelay?: string;
    reason?: string;
  }[];
  weather?: {
    weather?: string;
    temp?: string;
    wind?: string;
  };
}

function parseDelayMinutes(delayStr: string): number | null {
  if (!delayStr) return null;
  const normalized = delayStr.toLowerCase().trim();

  // Match "2 hrs 15 mins", "1 hr 20 mins", "45 mins", "1 hr", "2 hours", etc.
  const hoursMatch = /(\d+)\s*hr(?:s|ours?)?/.exec(normalized);
  const minsMatch = /(\d+)\s*min(?:s|utes?)?/.exec(normalized);

  const hours = hoursMatch ? Number.parseInt(hoursMatch[1] ?? '0', 10) : 0;
  const minutes = minsMatch ? Number.parseInt(minsMatch[1] ?? '0', 10) : 0;

  if (!hoursMatch && !minsMatch) return null;
  return hours * 60 + minutes;
}

function mapDelayType(typeStr: string | undefined): NasDelayType {
  if (!typeStr) return 'general';
  const t = typeStr.toLowerCase();
  if (t.includes('ground stop')) return 'ground-stop';
  if (t.includes('ground delay')) return 'ground-delay';
  if (t.includes('departure')) return 'departure';
  if (t.includes('arrival')) return 'arrival';
  if (t.includes('closure')) return 'closure';
  return 'general';
}

function isSystemicReason(reason: string): boolean {
  const r = reason.toUpperCase();
  return (
    r.includes('EQUIPMENT') ||
    r.includes('ATC EQUIPMENT') ||
    r.includes('ATC STAFFING') ||
    r.includes('ATC OUTAGE') ||
    r.includes('STAFFING')
  );
}

const SEVERITY_ORDER: NasDelay['severity'][] = ['low', 'medium', 'high', 'critical'];

function boostSeverity(severity: NasDelay['severity']): NasDelay['severity'] {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(idx + 1, SEVERITY_ORDER.length - 1)] ?? severity;
}

function computeSeverity(
  delayType: NasDelayType,
  avgDelayMinutes: number | null,
  reason: string,
): NasDelay['severity'] {
  let severity: NasDelay['severity'];

  if (delayType === 'ground-stop') {
    severity = 'critical';
  } else if (avgDelayMinutes !== null && avgDelayMinutes > 180) {
    severity = 'critical';
  } else if (avgDelayMinutes !== null && avgDelayMinutes > 60) {
    severity = 'high';
  } else if (avgDelayMinutes !== null && avgDelayMinutes >= 30) {
    severity = 'medium';
  } else {
    severity = 'low';
  }

  if (isSystemicReason(reason)) {
    severity = boostSeverity(severity);
  }

  return severity;
}

async function fetchAirportStatus(iata: string): Promise<NasDelay | null> {
  try {
    const url = `${FAA_BASE}/${iata}?format=application/json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;

    const data = (await res.json()) as FaaAirportStatus;
    if (!data.delay) return null;

    const statusEntry = data.status?.[0];
    const delayType = mapDelayType(statusEntry?.type);
    const reason = statusEntry?.reason ?? 'Unknown';
    const avgDelayMinutes = parseDelayMinutes(statusEntry?.avgDelay ?? '');

    const weatherObj = data.weather;
    const weatherParts = [weatherObj?.weather, weatherObj?.temp, weatherObj?.wind].filter(Boolean);
    const weather = weatherParts.join(', ') || 'No weather data';

    const severity = computeSeverity(delayType, avgDelayMinutes, reason);

    return {
      id: `faa-${iata.toLowerCase()}-${Date.now()}`,
      airport: data.IATA ?? iata,
      airportName: data.name ?? iata,
      city: data.city ?? '',
      state: data.state ?? '',
      delayType,
      avgDelayMinutes,
      reason,
      weather,
      pubDate: new Date(),
      severity,
    };
  } catch {
    return null;
  }
}

export async function fetchNasStatus(): Promise<NasStatus> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.status;
  }

  const results = await Promise.allSettled(
    MONITORED_AIRPORTS.map(iata => fetchAirportStatus(iata)),
  );

  const delays: NasDelay[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) delays.push(r.value);
  }

  // Sort: critical first, then by delay minutes desc
  delays.sort((a, b) => {
    const sOrder: NasDelay['severity'][] = ['critical', 'high', 'medium', 'low'];
    const sA = sOrder.indexOf(a.severity);
    const sB = sOrder.indexOf(b.severity);
    if (sA !== sB) return sA - sB;
    return (b.avgDelayMinutes ?? 0) - (a.avgDelayMinutes ?? 0);
  });

  const status: NasStatus = {
    delays,
    totalDelayed: delays.length,
    fetchedAt: new Date(),
  };

  cache = { status, fetchedAt: Date.now() };
  return status;
}

export function nasDelaySeverityClass(severity: NasDelay['severity']): string {
  return (
    {
      critical: 'eq-row eq-major',
      high: 'eq-row eq-strong',
      medium: 'eq-row eq-moderate',
      low: 'eq-row',
    }[severity] ?? 'eq-row'
  );
}
