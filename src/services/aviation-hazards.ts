/**
 * Aviation hazard monitoring — FAA Aviation Weather Center
 * Public API — no authentication required, CORS-enabled
 * https://aviationweather.gov/api/data/
 *
 * Sources:
 *  - SIGMETs (Significant Meteorological Information): severe weather,
 *    volcanic ash, tropical cyclones, turbulence, icing affecting aircraft
 *  - AIRMETs (Airman's Meteorological Information): lower-severity weather
 *  - PIREPs (Pilot Reports): real-time hazard reports from in-flight aircraft
 */

export type SigmetHazardType =
  | 'thunderstorm'
  | 'turbulence'
  | 'icing'
  | 'volcanic_ash'
  | 'tropical_cyclone'
  | 'dust_sand'
  | 'radiation_release'
  | 'other';

export interface AviationSigmet {
  id: string;
  type: 'SIGMET' | 'AIRMET';
  hazard: SigmetHazardType;
  severity: 'critical' | 'high' | 'medium' | 'low';
  issuingCenter: string;
  flightLevels: string;    // e.g. "FL180-FL350"
  validFrom: Date;
  validTo: Date;
  area: string;            // text description of affected area
  rawText: string;
}

export interface AviationPirep {
  id: string;
  lat: number;
  lon: number;
  altitudeFt: number | null;
  hazardType: 'turbulence' | 'icing' | 'pirep';
  intensity: string;        // e.g. "SEV", "MOD", "LGT"
  severity: 'critical' | 'high' | 'medium' | 'low';
  reportTime: Date;
  aircraft: string;
  rawText: string;
}

// FAA Aviation Weather Center API (CORS-enabled, public)
const AWC_SIGMET_URL = 'https://aviationweather.gov/api/data/airsigmet?format=json&type=sigmet';
const AWC_AIRMET_URL = 'https://aviationweather.gov/api/data/airsigmet?format=json&type=airmet';
const AWC_PIREP_URL = 'https://aviationweather.gov/api/data/pirep?format=json&age=2&distance=0';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
let cache: { sigmets: AviationSigmet[]; pireps: AviationPirep[]; fetchedAt: number } | null = null;

function detectHazard(hazard: string, rawText: string): SigmetHazardType {
  const h = (hazard + ' ' + rawText).toUpperCase();
  if (h.includes('VA') || h.includes('VOLCANIC')) return 'volcanic_ash';
  if (h.includes('TC') || h.includes('TROPICAL')) return 'tropical_cyclone';
  if (h.includes('TS') || h.includes('THUNDERSTORM') || h.includes('EMBD') || h.includes('OBSC')) return 'thunderstorm';
  if (h.includes('ICE') || h.includes('FZRA')) return 'icing';
  if (h.includes('TURB')) return 'turbulence';
  if (h.includes('DS') || h.includes('SS') || h.includes('DUST') || h.includes('SAND')) return 'dust_sand';
  if (h.includes('RDOACT') || h.includes('RADIATION')) return 'radiation_release';
  return 'other';
}

function sigmetSeverity(type: 'SIGMET' | 'AIRMET', hazard: SigmetHazardType): AviationSigmet['severity'] {
  if (type === 'SIGMET') {
    if (hazard === 'volcanic_ash' || hazard === 'tropical_cyclone') return 'critical';
    if (hazard === 'thunderstorm' || hazard === 'turbulence') return 'high';
    return 'medium';
  }
  return 'low';
}

function pirepSeverity(intensity: string, _hazardType: AviationPirep['hazardType']): AviationPirep['severity'] {
  const i = intensity.toUpperCase();
  if (i.includes('EXTRM') || i.includes('EXTM') || i.includes('SEV-EXTRM')) return 'critical';
  if (i.includes('SEV') || i.includes('MOD-SEV')) return 'high';
  if (i.includes('MOD')) return 'medium';
  return 'low';
}

interface AwcSigmetItem {
  isigmetId?: string;
  hazard?: string;
  rawAirSigmet?: string;
  icaoId?: string;
  validTimeFrom?: string;
  validTimeTo?: string;
  altLow1?: number;
  altHi1?: number;
  rawText?: string;
}

interface AwcPirepItem {
  pirepType?: string;
  lat?: number;
  lon?: number;
  reportTime?: string;
  fltlvl?: number;
  tbInt?: string;
  icgInt?: string;
  acType?: string;
  rawOb?: string;
}

async function fetchSigmets(url: string, type: 'SIGMET' | 'AIRMET'): Promise<AviationSigmet[]> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const items: AwcSigmetItem[] = await res.json();
    if (!Array.isArray(items)) return [];

    return items.map((item, i) => {
      const rawText = item.rawAirSigmet ?? item.rawText ?? '';
      const hazard = detectHazard(item.hazard ?? '', rawText);
      const low = item.altLow1 == undefined ? 'SFC' : `FL${Math.round(item.altLow1 / 100)}`;
      const high = item.altHi1 == undefined ? 'UNL' : `FL${Math.round(item.altHi1 / 100)}`;
      return {
        id: `sigmet-${item.isigmetId ?? `${type}-${i}`}`,
        type,
        hazard,
        severity: sigmetSeverity(type, hazard),
        issuingCenter: item.icaoId ?? '',
        flightLevels: `${low}-${high}`,
        validFrom: item.validTimeFrom ? new Date(item.validTimeFrom) : new Date(),
        validTo: item.validTimeTo ? new Date(item.validTimeTo) : new Date(Date.now() + 2 * 3_600_000),
        area: '',
        rawText: rawText.slice(0, 400),
      };
    });
  } catch {
    return [];
  }
}

async function fetchPireps(): Promise<AviationPirep[]> {
  try {
    const res = await fetch(AWC_PIREP_URL, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const items: AwcPirepItem[] = await res.json();
    if (!Array.isArray(items)) return [];

    return items
      .filter(p => {
        const hasSevTurb = p.tbInt && /SEV|EXTRM/.test(p.tbInt.toUpperCase());
        const hasSevIce = p.icgInt && /SEV|EXTRM/.test(p.icgInt.toUpperCase());
        return hasSevTurb || hasSevIce;
      })
      .slice(0, 50)
      .map((p, i) => {
        const isTurb = !!(p.tbInt);
        const intensity = (isTurb ? p.tbInt : p.icgInt) ?? '';
        const hazardType: AviationPirep['hazardType'] = isTurb ? 'turbulence' : 'icing';
        return {
          id: `pirep-${i}-${p.reportTime ?? Date.now()}`,
          lat: p.lat ?? 0,
          lon: p.lon ?? 0,
          altitudeFt: p.fltlvl == undefined ? null : p.fltlvl * 100,
          hazardType,
          intensity,
          severity: pirepSeverity(intensity, hazardType),
          reportTime: p.reportTime ? new Date(p.reportTime) : new Date(),
          aircraft: p.acType ?? 'Unknown',
          rawText: (p.rawOb ?? '').slice(0, 300),
        };
      });
  } catch {
    return [];
  }
}

export async function fetchAviationHazards(): Promise<{
  sigmets: AviationSigmet[];
  pireps: AviationPirep[];
}> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { sigmets: cache.sigmets, pireps: cache.pireps };
  }

  const [sigResult, airResult, pirepResult] = await Promise.allSettled([
    fetchSigmets(AWC_SIGMET_URL, 'SIGMET'),
    fetchSigmets(AWC_AIRMET_URL, 'AIRMET'),
    fetchPireps(),
  ]);

  const sigmets: AviationSigmet[] = [
    ...(sigResult.status === 'fulfilled' ? sigResult.value : []),
    ...(airResult.status === 'fulfilled' ? airResult.value : []),
  ].sort((a, b) => {
    const sOrder: Record<AviationSigmet['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return sOrder[a.severity] - sOrder[b.severity];
  });

  const pireps = pirepResult.status === 'fulfilled' ? pirepResult.value : [];

  cache = { sigmets, pireps, fetchedAt: Date.now() };
  return { sigmets, pireps };
}

export function sigmetSeverityClass(severity: AviationSigmet['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high: 'eq-row eq-strong',
    medium: 'eq-row eq-moderate',
    low: 'eq-row',
  }[severity] ?? 'eq-row';
}
