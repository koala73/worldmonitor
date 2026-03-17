// Launch Library 2 API — free tier, 300 req/day, CORS-enabled
// https://ll.thespacedevs.com/2.2.0/launch/upcoming/

export type LaunchCategory = 'military' | 'intelligence' | 'civil' | 'commercial' | 'adversary' | 'other';
export type LaunchStatus = 'go' | 'tbd' | 'success' | 'failure' | 'hold' | 'other';

export interface SpaceLaunch {
  id: string;
  name: string;
  vehicle: string;
  provider: string;
  providerCountry: string;
  missionName: string;
  missionType: string;
  missionDescription: string;
  orbit: string;
  launchSite: string;
  launchCountry: string;
  netTime: Date;
  status: LaunchStatus;
  probability: number | null;
  category: LaunchCategory;
  isAdversary: boolean;
  url: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const API_URL = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=25&format=json';

interface Cache {
  launches: SpaceLaunch[];
  ts: number;
}

let _cache: Cache | null = null;

const ADVERSARY_CODES = new Set(['RUS', 'CHN', 'PRK', 'IRN']);
const ADVERSARY_NAMES = new Set(['Russia', 'China', 'North Korea', 'Iran']);

function isAdversaryCountry(code: string, name: string): boolean {
  return ADVERSARY_CODES.has(code) || ADVERSARY_NAMES.has(name);
}

function mapStatus(abbrev: string): LaunchStatus {
  switch (abbrev) {
    case 'Go':      return 'go';
    case 'TBD':     return 'tbd';
    case 'Success': return 'success';
    case 'Failure': return 'failure';
    case 'Hold':    return 'hold';
    default:        return 'other';
  }
}

function detectCategory(
  missionType: string,
  missionName: string,
  providerName: string,
  providerType: string,
  isAdversary: boolean,
): LaunchCategory {
  if (isAdversary) return 'adversary';

  const INTEL_PROGRAMS = /\b(NROL|NRO|NTS)\b/i;
  const INTEL_TYPE = /classified/i;
  if (INTEL_PROGRAMS.test(missionName) || INTEL_TYPE.test(missionType)) return 'intelligence';

  const MILITARY_PROGRAMS = /\b(NROL|GPS|AEHF|SBIRS|WGS|MUOS|MILSTAR|DSP|NAVSTAR)\b/i;
  const MILITARY_TYPE = /military/i;
  const MILITARY_PROVIDER = /space force|air force|defence|MoD/i;
  if (
    MILITARY_TYPE.test(missionType) ||
    MILITARY_PROGRAMS.test(missionName) ||
    MILITARY_PROVIDER.test(providerName)
  ) return 'military';

  const CIVIL_AGENCIES = /nasa|esa|jaxa|isro|cnes/i;
  if (providerType === 'Government' || CIVIL_AGENCIES.test(providerName)) return 'civil';

  if (providerType === 'Commercial') return 'commercial';

  return 'other';
}

function detectSeverity(
  category: LaunchCategory,
  missionName: string,
  missionType: string,
  providerCountry: string,
  launchCountry: string,
  isAdversary: boolean,
): SpaceLaunch['severity'] {
  const isNK = providerCountry === 'PRK' || launchCountry === 'PRK' ||
               providerCountry === 'North Korea' || launchCountry === 'North Korea';
  const isIran = providerCountry === 'IRN' || launchCountry === 'IRN' ||
                 providerCountry === 'Iran' || launchCountry === 'Iran';
  const isRusChina =
    ['RUS', 'CHN', 'Russia', 'China'].some(c => c === providerCountry || c === launchCountry);

  if (isAdversary) {
    if (isNK || isIran) return 'critical';
    if (isRusChina) {
      if (category === 'adversary') {
        const MILITARY_PROGRAMS = /\b(NROL|GPS|AEHF|SBIRS|WGS|MUOS|MILSTAR|DSP|NAVSTAR)\b/i;
        const isMilitary = /military/i.test(missionType) || MILITARY_PROGRAMS.test(missionName);
        return isMilitary ? 'critical' : 'high';
      }
      return 'high';
    }
    return 'medium';
  }

  if (category === 'intelligence') return 'high';
  if (category === 'military') return 'high';
  if (category === 'commercial') return 'low';

  return 'medium';
}

interface LL2Launch {
  id: string;
  name: string;
  net: string;
  status: { abbrev: string } | null;
  launch_service_provider: {
    name: string;
    country_code: string;
    type: string;
  } | null;
  rocket: {
    configuration: { name: string; family: string } | null;
  } | null;
  mission: {
    name: string;
    description: string;
    type: string;
    orbit: { name: string; abbrev: string } | null;
  } | null;
  pad: {
    location: { country_code: string; name: string } | null;
  } | null;
  probability: number | null;
  url?: string;
}

function parseLaunch(raw: LL2Launch): SpaceLaunch | null {
  const netTime = new Date(raw.net);
  if (isNaN(netTime.getTime())) return null;

  // Filter: only next 30 days
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (netTime.getTime() < now || netTime.getTime() > now + thirtyDays) return null;

  const provider = raw.launch_service_provider;
  const providerName = provider?.name ?? 'Unknown';
  const providerCountry = provider?.country_code ?? '';
  const providerType = provider?.type ?? '';

  const rocket = raw.rocket?.configuration;
  const vehicle = rocket?.name ?? 'Unknown';

  const mission = raw.mission;
  const missionName = mission?.name ?? raw.name ?? '';
  const missionType = mission?.type ?? '';
  const missionDescription = mission?.description ?? '';
  const orbit = mission?.orbit?.name ?? mission?.orbit?.abbrev ?? '';

  const pad = raw.pad?.location;
  const launchSite = pad?.name ?? '';
  const launchCountry = pad?.country_code ?? '';

  const isAdversary = isAdversaryCountry(providerCountry, providerName) ||
                      isAdversaryCountry(launchCountry, '');

  const category = detectCategory(missionType, missionName, providerName, providerType, isAdversary);
  const severity = detectSeverity(category, missionName, missionType, providerCountry, launchCountry, isAdversary);

  return {
    id: raw.id,
    name: raw.name,
    vehicle,
    provider: providerName,
    providerCountry,
    missionName,
    missionType,
    missionDescription: missionDescription.slice(0, 500),
    orbit,
    launchSite,
    launchCountry,
    netTime,
    status: mapStatus(raw.status?.abbrev ?? ''),
    probability: raw.probability ?? null,
    category,
    isAdversary,
    url: raw.url ?? `https://ll.thespacedevs.com/2.2.0/launch/${raw.id}/`,
    severity,
  };
}

const CATEGORY_ORDER: Record<LaunchCategory, number> = {
  adversary: 0,
  military: 1,
  intelligence: 2,
  civil: 3,
  commercial: 4,
  other: 5,
};

export async function fetchSpaceLaunches(): Promise<SpaceLaunch[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.launches;

  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      _cache = { launches: [], ts: Date.now() };
      return [];
    }

    const json = (await res.json()) as { results?: LL2Launch[] };
    const raw = json.results ?? [];

    const launches: SpaceLaunch[] = [];
    for (const item of raw) {
      const launch = parseLaunch(item);
      if (launch) launches.push(launch);
    }

    launches.sort((a, b) => {
      const catDiff = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
      if (catDiff !== 0) return catDiff;
      return a.netTime.getTime() - b.netTime.getTime();
    });

    const limited = launches.slice(0, 30);
    _cache = { launches: limited, ts: Date.now() };
    return limited;
  } catch {
    _cache = { launches: [], ts: Date.now() };
    return [];
  }
}

export function launchSeverityClass(severity: SpaceLaunch['severity']): string {
  return {
    critical: 'eq-row eq-major',
    high:     'eq-row eq-strong',
    medium:   'eq-row eq-moderate',
    low:      'eq-row',
  }[severity] ?? 'eq-row';
}

export function launchCategoryLabel(category: LaunchCategory): string {
  return {
    military:     'Military',
    intelligence: 'Intelligence',
    civil:        'Civil',
    commercial:   'Commercial',
    adversary:    'Adversary Nation',
    other:        'Other',
  }[category] ?? 'Other';
}
