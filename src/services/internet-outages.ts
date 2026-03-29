/**
 * Internet outage detection — IODA (Internet Outage Detection and Analysis)
 * Research project by Georgia Tech / CAIDA, public API, no auth required.
 * https://ioda.inetintel.cc.gatech.edu/api/v2/
 *
 * Detects country/AS-level internet blackouts using BGP, active probing,
 * and darknet traffic signals. Used by journalists and human rights orgs
 * to document government-ordered internet shutdowns.
 */

export interface IodaOutage {
  id: string;
  entityType: 'country' | 'asn' | 'region';
  entityName: string;
  entityCode: string;        // ISO country code or ASN
  score: number;             // 0–1 outage severity score
  overallScore: number;      // IODA composite score
  bgpScore: number | null;   // BGP routing signal
  activeScore: number | null; // Active probing signal
  darknetsScore: number | null; // Darknet traffic signal
  startTime: Date;
  endTime: Date | null;
  isOngoing: boolean;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

interface IodaAlert {
  entity: {
    type: string;
    name: string;
    code: string;
  };
  overallScore: number;
  bgpScore?: number;
  activeScore?: number;
  darknetsScore?: number;
  from: number;   // unix timestamp
  until?: number; // unix timestamp
}

interface IodaResponse {
  data?: IodaAlert[];
  alerts?: IodaAlert[];
}

const IODA_API = 'https://ioda.inetintel.cc.gatech.edu/api/v2/outages/alerts';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cache: { outages: IodaOutage[]; fetchedAt: number } | null = null;

function scoreToSeverity(score: number): IodaOutage['severity'] {
  if (score >= 0.8) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.2) return 'medium';
  return 'low';
}

export async function fetchIodaOutages(): Promise<IodaOutage[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.outages;

  try {
    // Request alerts from last 24 hours
    const from = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const until = Math.floor(Date.now() / 1000);
    const url = `${IODA_API}?from=${from}&until=${until}&limit=50&page=1`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return cache?.outages ?? [];

    const data: IodaResponse = await res.json();
    const alerts: IodaAlert[] = data.data ?? data.alerts ?? [];

    const outages: IodaOutage[] = alerts
      .filter(a => a.overallScore >= 0.1) // filter trivial noise
      .map((a, i) => {
        const score = Math.min(1, a.overallScore);
        const startTime = new Date(a.from * 1000);
        const endTime = a.until ? new Date(a.until * 1000) : null;
        const isOngoing = !endTime || endTime.getTime() > Date.now();
        const entityType = (a.entity?.type === 'country' ? 'country'
          : (a.entity?.type === 'asn' ? 'asn' : 'region')) as IodaOutage['entityType'];

        return {
          id: `ioda-${a.entity?.code ?? i}-${a.from}`,
          entityType,
          entityName: a.entity?.name ?? 'Unknown',
          entityCode: a.entity?.code ?? '',
          score,
          overallScore: a.overallScore,
          bgpScore: a.bgpScore ?? null,
          activeScore: a.activeScore ?? null,
          darknetsScore: a.darknetsScore ?? null,
          startTime,
          endTime,
          isOngoing,
          severity: scoreToSeverity(score),
        };
      });

    // Sort: ongoing first, then by score
    outages.sort((a, b) => {
      if (a.isOngoing !== b.isOngoing) return a.isOngoing ? -1 : 1;
      return b.score - a.score;
    });

    cache = { outages: outages.slice(0, 50), fetchedAt: Date.now() };
    return cache.outages;
  } catch {
    return cache?.outages ?? [];
  }
}

export function outageEntityLabel(outage: IodaOutage): string {
  if (outage.entityType === 'asn') return `AS${outage.entityCode} (${outage.entityName})`;
  return outage.entityName;
}

export function outageSeverityClass(severity: IodaOutage['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}
