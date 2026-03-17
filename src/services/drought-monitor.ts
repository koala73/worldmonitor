/**
 * US Drought Monitor — University of Nebraska / NIDIS
 * API: https://droughtmonitor.unl.edu/DmData/DataTables.aspx?mode=table&aoi=state&date=&statisdata=1
 * Returns weekly drought conditions by state. Data updates once a week (Thursdays).
 */

export type DroughtLevel = 'D0' | 'D1' | 'D2' | 'D3' | 'D4';

export interface DroughtState {
  id: string;
  state: string;
  stateAbbr: string;
  validStart: Date;
  validEnd: Date;
  none: number;   // % No drought
  d0: number;     // % Abnormally Dry
  d1: number;     // % Moderate Drought
  d2: number;     // % Severe Drought
  d3: number;     // % Extreme Drought
  d4: number;     // % Exceptional Drought
  maxLevel: DroughtLevel | 'None';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'none';
}

export interface DroughtSummary {
  states: DroughtState[];
  validDate: Date | null;
  nationalD3D4Pct: number;
  fetchedAt: Date;
}

const DROUGHT_API_URL =
  'https://droughtmonitor.unl.edu/DmData/DataTables.aspx?mode=table&aoi=state&date=&statisdata=1';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
let cache: { summary: DroughtSummary; fetchedAt: number } | null = null;

// Full US state name → abbreviation lookup
const STATE_ABBR: Record<string, string> = {
  'Alabama': 'AL',
  'Alaska': 'AK',
  'Arizona': 'AZ',
  'Arkansas': 'AR',
  'California': 'CA',
  'Colorado': 'CO',
  'Connecticut': 'CT',
  'Delaware': 'DE',
  'Florida': 'FL',
  'Georgia': 'GA',
  'Hawaii': 'HI',
  'Idaho': 'ID',
  'Illinois': 'IL',
  'Indiana': 'IN',
  'Iowa': 'IA',
  'Kansas': 'KS',
  'Kentucky': 'KY',
  'Louisiana': 'LA',
  'Maine': 'ME',
  'Maryland': 'MD',
  'Massachusetts': 'MA',
  'Michigan': 'MI',
  'Minnesota': 'MN',
  'Mississippi': 'MS',
  'Missouri': 'MO',
  'Montana': 'MT',
  'Nebraska': 'NE',
  'Nevada': 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  'Ohio': 'OH',
  'Oklahoma': 'OK',
  'Oregon': 'OR',
  'Pennsylvania': 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  'Tennessee': 'TN',
  'Texas': 'TX',
  'Utah': 'UT',
  'Vermont': 'VT',
  'Virginia': 'VA',
  'Washington': 'WA',
  'West Virginia': 'WV',
  'Wisconsin': 'WI',
  'Wyoming': 'WY',
  // US territories
  'Puerto Rico': 'PR',
  'Virgin Islands': 'VI',
  'Guam': 'GU',
};

function resolveAbbr(stateName: string): string {
  return STATE_ABBR[stateName] ?? stateName.slice(0, 2).toUpperCase();
}

function computeMaxLevel(d0: number, d1: number, d2: number, d3: number, d4: number): DroughtLevel | 'None' {
  if (d4 > 0) return 'D4';
  if (d3 > 0) return 'D3';
  if (d2 > 0) return 'D2';
  if (d1 > 0) return 'D1';
  if (d0 > 0) return 'D0';
  return 'None';
}

function computeSeverity(
  d0: number,
  d1: number,
  d2: number,
  d3: number,
  d4: number,
): DroughtState['severity'] {
  if (d3 + d4 > 10) return 'critical';
  if (d2 > 20) return 'high';
  if (d1 > 30) return 'medium';
  if (d0 > 30) return 'low';
  return 'none';
}

interface RawDroughtRow {
  MapDate?: string;
  ReleaseDate?: string;
  State?: string;
  StatisticFormatID?: number;
  None?: number | string;
  D0?: number | string;
  D1?: number | string;
  D2?: number | string;
  D3?: number | string;
  D4?: number | string;
  ValidStart?: string;
  ValidEnd?: string;
}

function toNum(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(n) ? 0 : n;
}

export async function fetchDroughtMonitor(): Promise<DroughtSummary> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.summary;
  }

  try {
    const res = await fetch(DROUGHT_API_URL, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      return cache?.summary ?? emptyDroughtSummary();
    }

    const json = await res.json() as RawDroughtRow[];
    if (!Array.isArray(json)) return cache?.summary ?? emptyDroughtSummary();

    let validDate: Date | null = null;
    const states: DroughtState[] = [];

    for (const row of json) {
      const stateName = row.State ?? '';
      if (!stateName) continue;

      const none = toNum(row.None);
      const d0 = toNum(row.D0);
      const d1 = toNum(row.D1);
      const d2 = toNum(row.D2);
      const d3 = toNum(row.D3);
      const d4 = toNum(row.D4);

      // Only include states with any D1+ drought
      if (d1 + d2 + d3 + d4 <= 0) continue;

      const mapDateStr = row.MapDate ?? row.ReleaseDate ?? '';
      const validStartStr = row.ValidStart ?? mapDateStr;
      const validEndStr = row.ValidEnd ?? mapDateStr;

      const validStart = validStartStr ? new Date(validStartStr) : new Date();
      const validEnd = validEndStr ? new Date(validEndStr) : new Date();

      if (!validDate && mapDateStr) {
        validDate = new Date(mapDateStr);
      }

      const maxLevel = computeMaxLevel(d0, d1, d2, d3, d4);
      const severity = computeSeverity(d0, d1, d2, d3, d4);
      const stateAbbr = resolveAbbr(stateName);

      states.push({
        id: `drought-${stateAbbr.toLowerCase()}`,
        state: stateName,
        stateAbbr,
        validStart,
        validEnd,
        none,
        d0,
        d1,
        d2,
        d3,
        d4,
        maxLevel,
        severity,
      });
    }

    // Sort: most severe first, then by d3+d4 percentage descending
    const sOrder: Record<DroughtState['severity'], number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      none: 4,
    };
    states.sort((a, b) => {
      const sd = sOrder[a.severity] - sOrder[b.severity];
      if (sd !== 0) return sd;
      return (b.d3 + b.d4) - (a.d3 + a.d4);
    });

    // National D3+D4 percentage — simple average across all states in response
    let nationalD3D4Pct = 0;
    if (json.length > 0) {
      const totalD3D4 = json.reduce((acc, row) => acc + toNum(row.D3) + toNum(row.D4), 0);
      nationalD3D4Pct = totalD3D4 / json.length;
    }

    const summary: DroughtSummary = {
      states,
      validDate,
      nationalD3D4Pct,
      fetchedAt: new Date(),
    };

    cache = { summary, fetchedAt: Date.now() };
    return summary;
  } catch {
    return cache?.summary ?? emptyDroughtSummary();
  }
}

function emptyDroughtSummary(): DroughtSummary {
  return {
    states: [],
    validDate: null,
    nationalD3D4Pct: 0,
    fetchedAt: new Date(),
  };
}

export function droughtSeverityClass(severity: DroughtState['severity']): string {
  return (
    {
      critical: 'eq-row eq-major',
      high: 'eq-row eq-strong',
      medium: 'eq-row eq-moderate',
      low: 'eq-row',
      none: 'eq-row',
    }[severity] ?? 'eq-row'
  );
}

export function droughtLevelLabel(level: DroughtLevel | 'None'): string {
  const labels: Record<DroughtLevel | 'None', string> = {
    D0: 'Abnormally Dry',
    D1: 'Moderate Drought',
    D2: 'Severe Drought',
    D3: 'Extreme Drought',
    D4: 'Exceptional Drought',
    None: 'No Drought',
  };
  return labels[level] ?? level;
}
