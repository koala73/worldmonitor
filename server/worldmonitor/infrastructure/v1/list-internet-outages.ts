declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListInternetOutagesRequest,
  ListInternetOutagesResponse,
  InternetOutage,
  OutageSeverity,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { UPSTREAM_TIMEOUT_MS } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'infra:outages:v1';
const REDIS_CACHE_TTL = 300; // 5 min — Cloudflare Radar rate-limited

// ========================================================================
// Constants
// ========================================================================

const CLOUDFLARE_RADAR_URL = 'https://api.cloudflare.com/client/v4/radar/annotations/outages';

// ========================================================================
// Cloudflare Radar types
// ========================================================================

interface CloudflareOutage {
  id: string;
  dataSource: string;
  description: string;
  scope: string | null;
  startDate: string;
  endDate: string | null;
  locations: string[];
  asns: number[];
  eventType: string;
  linkedUrl: string;
  locationsDetails: Array<{ name: string; code: string }>;
  asnsDetails: Array<{ asn: string; name: string; location: { code: string; name: string } }>;
  outage: { outageCause: string; outageType: string };
}

interface CloudflareResponse {
  configured?: boolean;
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: { annotations: CloudflareOutage[] };
}

// ========================================================================
// Country coordinates (centroid for mapping outage locations)
// ========================================================================

const COUNTRY_COORDS: Record<string, [number, number]> = {
  AF:[33.94,67.71],AL:[41.15,20.17],DZ:[28.03,1.66],AO:[-11.20,17.87],
  AR:[-38.42,-63.62],AM:[40.07,45.04],AU:[-25.27,133.78],AT:[47.52,14.55],
  AZ:[40.14,47.58],BH:[26.07,50.56],BD:[23.69,90.36],BY:[53.71,27.95],
  BE:[50.50,4.47],BJ:[9.31,2.32],BO:[-16.29,-63.59],BA:[43.92,17.68],
  BW:[-22.33,24.68],BR:[-14.24,-51.93],BG:[42.73,25.49],BF:[12.24,-1.56],
  BI:[-3.37,29.92],KH:[12.57,104.99],CM:[7.37,12.35],CA:[56.13,-106.35],
  CF:[6.61,20.94],TD:[15.45,18.73],CL:[-35.68,-71.54],CN:[35.86,104.20],
  CO:[4.57,-74.30],CG:[-0.23,15.83],CD:[-4.04,21.76],CR:[9.75,-83.75],
  HR:[45.10,15.20],CU:[21.52,-77.78],CY:[35.13,33.43],CZ:[49.82,15.47],
  DK:[56.26,9.50],DJ:[11.83,42.59],EC:[-1.83,-78.18],EG:[26.82,30.80],
  SV:[13.79,-88.90],ER:[15.18,39.78],EE:[58.60,25.01],ET:[9.15,40.49],
  FI:[61.92,25.75],FR:[46.23,2.21],GA:[-0.80,11.61],GM:[13.44,-15.31],
  GE:[42.32,43.36],DE:[51.17,10.45],GH:[7.95,-1.02],GR:[39.07,21.82],
  GT:[15.78,-90.23],GN:[9.95,-9.70],HT:[18.97,-72.29],HN:[15.20,-86.24],
  HK:[22.32,114.17],HU:[47.16,19.50],IN:[20.59,78.96],ID:[-0.79,113.92],
  IR:[32.43,53.69],IQ:[33.22,43.68],IE:[53.14,-7.69],IL:[31.05,34.85],
  IT:[41.87,12.57],CI:[7.54,-5.55],JP:[36.20,138.25],JO:[30.59,36.24],
  KZ:[48.02,66.92],KE:[-0.02,37.91],KW:[29.31,47.48],KG:[41.20,74.77],
  LA:[19.86,102.50],LV:[56.88,24.60],LB:[33.85,35.86],LY:[26.34,17.23],
  LT:[55.17,23.88],LU:[49.82,6.13],MG:[-18.77,46.87],MW:[-13.25,34.30],
  MY:[4.21,101.98],ML:[17.57,-4.00],MR:[21.01,-10.94],MX:[23.63,-102.55],
  MD:[47.41,28.37],MN:[46.86,103.85],MA:[31.79,-7.09],MZ:[-18.67,35.53],
  MM:[21.92,95.96],NA:[-22.96,18.49],NP:[28.39,84.12],NL:[52.13,5.29],
  NZ:[-40.90,174.89],NI:[12.87,-85.21],NE:[17.61,8.08],NG:[9.08,8.68],
  KP:[40.34,127.51],NO:[60.47,8.47],OM:[21.47,55.98],PK:[30.38,69.35],
  PS:[31.95,35.23],PA:[8.54,-80.78],PG:[-6.32,143.96],PY:[-23.44,-58.44],
  PE:[-9.19,-75.02],PH:[12.88,121.77],PL:[51.92,19.15],PT:[39.40,-8.22],
  QA:[25.35,51.18],RO:[45.94,24.97],RU:[61.52,105.32],RW:[-1.94,29.87],
  SA:[23.89,45.08],SN:[14.50,-14.45],RS:[44.02,21.01],SL:[8.46,-11.78],
  SG:[1.35,103.82],SK:[48.67,19.70],SI:[46.15,14.99],SO:[5.15,46.20],
  ZA:[-30.56,22.94],KR:[35.91,127.77],SS:[6.88,31.31],ES:[40.46,-3.75],
  LK:[7.87,80.77],SD:[12.86,30.22],SE:[60.13,18.64],CH:[46.82,8.23],
  SY:[34.80,38.997],TW:[23.70,120.96],TJ:[38.86,71.28],TZ:[-6.37,34.89],
  TH:[15.87,100.99],TG:[8.62,0.82],TT:[10.69,-61.22],TN:[33.89,9.54],
  TR:[38.96,35.24],TM:[38.97,59.56],UG:[1.37,32.29],UA:[48.38,31.17],
  AE:[23.42,53.85],GB:[55.38,-3.44],US:[37.09,-95.71],UY:[-32.52,-55.77],
  UZ:[41.38,64.59],VE:[6.42,-66.59],VN:[14.06,108.28],YE:[15.55,48.52],
  ZM:[-13.13,27.85],ZW:[-19.02,29.15],
};

// ========================================================================
// Helpers
// ========================================================================

function mapOutageSeverity(outageType: string | undefined): OutageSeverity {
  if (outageType === 'NATIONWIDE') return 'OUTAGE_SEVERITY_TOTAL';
  if (outageType === 'REGIONAL') return 'OUTAGE_SEVERITY_MAJOR';
  return 'OUTAGE_SEVERITY_PARTIAL';
}

function toEpochMs(value: string | null | undefined): number {
  if (!value) return 0;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

// ========================================================================
// RPC implementation
// ========================================================================

export async function listInternetOutages(
  _ctx: ServerContext,
  req: ListInternetOutagesRequest,
): Promise<ListInternetOutagesResponse> {
  try {
    // Redis shared cache (stores UNFILTERED outages — filters applied after)
    const cached = (await getCachedJson(REDIS_CACHE_KEY)) as ListInternetOutagesResponse | null;
    let outages: InternetOutage[];

    if (cached?.outages?.length) {
      outages = cached.outages;
    } else {
      const token = process.env.CLOUDFLARE_API_TOKEN;
      if (!token) {
        return { outages: [], pagination: undefined };
      }

      const response = await fetch(
        `${CLOUDFLARE_RADAR_URL}?dateRange=7d&limit=50`,
        {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        return { outages: [], pagination: undefined };
      }

      const data: CloudflareResponse = await response.json();
      if (data.configured === false || !data.success || data.errors?.length) {
        return { outages: [], pagination: undefined };
      }

      outages = [];

      for (const raw of data.result?.annotations || []) {
        if (!raw.locations?.length) continue;
        const countryCode = raw.locations[0];
        if (!countryCode) continue;

        const coords = COUNTRY_COORDS[countryCode];
        if (!coords) continue;

        const countryName = raw.locationsDetails?.[0]?.name ?? countryCode;

        const categories: string[] = ['Cloudflare Radar'];
        if (raw.outage?.outageCause) categories.push(raw.outage.outageCause.replace(/_/g, ' '));
        if (raw.outage?.outageType) categories.push(raw.outage.outageType);
        for (const asn of raw.asnsDetails?.slice(0, 2) || []) {
          if (asn.name) categories.push(asn.name);
        }

        outages.push({
          id: `cf-${raw.id}`,
          title: raw.scope ? `${raw.scope} outage in ${countryName}` : `Internet disruption in ${countryName}`,
          link: raw.linkedUrl || 'https://radar.cloudflare.com/outage-center',
          description: raw.description,
          detectedAt: toEpochMs(raw.startDate),
          country: countryName,
          region: '',
          location: { latitude: coords[0], longitude: coords[1] },
          severity: mapOutageSeverity(raw.outage?.outageType),
          categories,
          cause: raw.outage?.outageCause || '',
          outageType: raw.outage?.outageType || '',
          endedAt: toEpochMs(raw.endDate),
        });
      }

      if (outages.length > 0) {
        setCachedJson(REDIS_CACHE_KEY, { outages, pagination: undefined }, REDIS_CACHE_TTL).catch(() => {});
      }
    }

    // Always apply filters (to both cached and fresh data)
    let filtered = outages;
    if (req.country) {
      const target = req.country.toLowerCase();
      filtered = outages.filter((o) => o.country.toLowerCase().includes(target));
    }
    if (req.timeRange?.start) {
      filtered = filtered.filter((o) => o.detectedAt >= req.timeRange!.start);
    }
    if (req.timeRange?.end) {
      filtered = filtered.filter((o) => o.detectedAt <= req.timeRange!.end);
    }

    return { outages: filtered, pagination: undefined };
  } catch {
    return { outages: [], pagination: undefined };
  }
}
