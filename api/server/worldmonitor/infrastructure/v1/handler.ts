/**
 * Infrastructure service handler -- implements the generated
 * InfrastructureServiceHandler interface with 2 RPCs:
 *   - ListInternetOutages  (Cloudflare Radar internet outage annotations)
 *   - ListServiceStatuses  (checks ~30 tech service status pages)
 *
 * Consolidates legacy edge functions:
 *   api/cloudflare-outages.js
 *   api/service-status.js
 *
 * All RPCs have graceful degradation: return empty on upstream failure.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  InfrastructureServiceHandler,
  ServerContext,
  ListInternetOutagesRequest,
  ListInternetOutagesResponse,
  ListServiceStatusesRequest,
  ListServiceStatusesResponse,
  InternetOutage,
  ServiceStatus,
  OutageSeverity,
  ServiceOperationalStatus,
} from '../../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

// ========================================================================
// Constants
// ========================================================================

const CLOUDFLARE_RADAR_URL = 'https://api.cloudflare.com/client/v4/radar/annotations/outages';
const UPSTREAM_TIMEOUT_MS = 10_000;

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
// Service status page definitions and parsers
// ========================================================================

interface ServiceDef {
  id: string;
  name: string;
  statusPage: string;
  customParser?: string;
  category: string;
}

const SERVICES: ServiceDef[] = [
  // Cloud Providers
  { id: 'aws', name: 'AWS', statusPage: 'https://health.aws.amazon.com/health/status', customParser: 'aws', category: 'cloud' },
  { id: 'azure', name: 'Azure', statusPage: 'https://azure.status.microsoft/en-us/status/feed/', customParser: 'rss', category: 'cloud' },
  { id: 'gcp', name: 'Google Cloud', statusPage: 'https://status.cloud.google.com/incidents.json', customParser: 'gcp', category: 'cloud' },
  { id: 'cloudflare', name: 'Cloudflare', statusPage: 'https://www.cloudflarestatus.com/api/v2/status.json', category: 'cloud' },
  { id: 'vercel', name: 'Vercel', statusPage: 'https://www.vercel-status.com/api/v2/status.json', category: 'cloud' },
  { id: 'netlify', name: 'Netlify', statusPage: 'https://www.netlifystatus.com/api/v2/status.json', category: 'cloud' },
  { id: 'digitalocean', name: 'DigitalOcean', statusPage: 'https://status.digitalocean.com/api/v2/status.json', category: 'cloud' },
  { id: 'render', name: 'Render', statusPage: 'https://status.render.com/api/v2/status.json', category: 'cloud' },
  { id: 'railway', name: 'Railway', statusPage: 'https://railway.instatus.com/summary.json', customParser: 'instatus', category: 'cloud' },
  // Developer Tools
  { id: 'github', name: 'GitHub', statusPage: 'https://www.githubstatus.com/api/v2/status.json', category: 'dev' },
  { id: 'gitlab', name: 'GitLab', statusPage: 'https://status.gitlab.com/1.0/status/5b36dc6502d06804c08349f7', customParser: 'statusio', category: 'dev' },
  { id: 'npm', name: 'npm', statusPage: 'https://status.npmjs.org/api/v2/status.json', category: 'dev' },
  { id: 'docker', name: 'Docker Hub', statusPage: 'https://www.dockerstatus.com/1.0/status/533c6539221ae15e3f000031', customParser: 'statusio', category: 'dev' },
  { id: 'bitbucket', name: 'Bitbucket', statusPage: 'https://bitbucket.status.atlassian.com/api/v2/status.json', category: 'dev' },
  { id: 'circleci', name: 'CircleCI', statusPage: 'https://status.circleci.com/api/v2/status.json', category: 'dev' },
  { id: 'jira', name: 'Jira', statusPage: 'https://jira-software.status.atlassian.com/api/v2/status.json', category: 'dev' },
  { id: 'confluence', name: 'Confluence', statusPage: 'https://confluence.status.atlassian.com/api/v2/status.json', category: 'dev' },
  { id: 'linear', name: 'Linear', statusPage: 'https://linearstatus.com/api/v2/status.json', customParser: 'incidentio', category: 'dev' },
  // Communication
  { id: 'slack', name: 'Slack', statusPage: 'https://slack-status.com/api/v2.0.0/current', customParser: 'slack', category: 'comm' },
  { id: 'discord', name: 'Discord', statusPage: 'https://discordstatus.com/api/v2/status.json', category: 'comm' },
  { id: 'zoom', name: 'Zoom', statusPage: 'https://www.zoomstatus.com/api/v2/status.json', category: 'comm' },
  { id: 'notion', name: 'Notion', statusPage: 'https://www.notion-status.com/api/v2/status.json', category: 'comm' },
  // AI Services
  { id: 'openai', name: 'OpenAI', statusPage: 'https://status.openai.com/api/v2/status.json', customParser: 'incidentio', category: 'ai' },
  { id: 'anthropic', name: 'Anthropic', statusPage: 'https://status.claude.com/api/v2/status.json', customParser: 'incidentio', category: 'ai' },
  { id: 'replicate', name: 'Replicate', statusPage: 'https://www.replicatestatus.com/api/v2/status.json', customParser: 'incidentio', category: 'ai' },
  // SaaS
  { id: 'stripe', name: 'Stripe', statusPage: 'https://status.stripe.com/current', customParser: 'stripe', category: 'saas' },
  { id: 'twilio', name: 'Twilio', statusPage: 'https://status.twilio.com/api/v2/status.json', category: 'saas' },
  { id: 'datadog', name: 'Datadog', statusPage: 'https://status.datadoghq.com/api/v2/status.json', category: 'saas' },
  { id: 'sentry', name: 'Sentry', statusPage: 'https://status.sentry.io/api/v2/status.json', category: 'saas' },
  { id: 'supabase', name: 'Supabase', statusPage: 'https://status.supabase.com/api/v2/status.json', category: 'saas' },
];

// ========================================================================
// Status normalization
// ========================================================================

function normalizeToProtoStatus(raw: string): ServiceOperationalStatus {
  if (!raw) return 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED';
  const val = raw.toLowerCase();
  if (val === 'none' || val === 'operational' || val.includes('all systems operational')) {
    return 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL';
  }
  if (val === 'minor' || val === 'degraded_performance' || val.includes('degraded')) {
    return 'SERVICE_OPERATIONAL_STATUS_DEGRADED';
  }
  if (val === 'partial_outage') {
    return 'SERVICE_OPERATIONAL_STATUS_PARTIAL_OUTAGE';
  }
  if (val === 'major' || val === 'major_outage' || val === 'critical' || val.includes('outage')) {
    return 'SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE';
  }
  if (val === 'maintenance' || val.includes('maintenance')) {
    return 'SERVICE_OPERATIONAL_STATUS_MAINTENANCE';
  }
  return 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED';
}

// ========================================================================
// Service status page checker
// ========================================================================

async function checkServiceStatus(service: ServiceDef): Promise<ServiceStatus> {
  const now = Date.now();
  const base: Pick<ServiceStatus, 'id' | 'name' | 'url'> = {
    id: service.id,
    name: service.name,
    url: service.statusPage,
  };
  const unknown = (desc: string): ServiceStatus => ({
    ...base,
    status: 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED',
    description: desc,
    checkedAt: now,
    latencyMs: 0,
  });

  try {
    const headers: Record<string, string> = {
      Accept: service.customParser === 'rss' ? 'application/xml, text/xml' : 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    };
    if (service.customParser !== 'incidentio') {
      headers['User-Agent'] = 'Mozilla/5.0 (compatible; WorldMonitor/1.0)';
    }

    const start = Date.now();
    const response = await fetch(service.statusPage, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED', description: `HTTP ${response.status}`, checkedAt: now, latencyMs };
    }

    // Custom parsers
    if (service.customParser === 'gcp') {
      const data = await response.json() as any[];
      const active = Array.isArray(data) ? data.filter((i: any) => i.end === undefined || new Date(i.end) > new Date()) : [];
      if (active.length === 0) {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL', description: 'All services operational', checkedAt: now, latencyMs };
      }
      const hasHigh = active.some((i: any) => i.severity === 'high');
      return {
        ...base,
        status: hasHigh ? 'SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE' : 'SERVICE_OPERATIONAL_STATUS_DEGRADED',
        description: `${active.length} active incident(s)`,
        checkedAt: now, latencyMs,
      };
    }

    if (service.customParser === 'aws') {
      return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL', description: 'Status page reachable', checkedAt: now, latencyMs };
    }

    if (service.customParser === 'rss') {
      const text = await response.text();
      const hasIncident = text.includes('<item>') && (text.includes('degradation') || text.includes('outage') || text.includes('incident'));
      return {
        ...base,
        status: hasIncident ? 'SERVICE_OPERATIONAL_STATUS_DEGRADED' : 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL',
        description: hasIncident ? 'Recent incidents reported' : 'No recent incidents',
        checkedAt: now, latencyMs,
      };
    }

    if (service.customParser === 'instatus') {
      const data = await response.json() as any;
      const pageStatus = data.page?.status;
      if (pageStatus === 'UP') {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL', description: 'All systems operational', checkedAt: now, latencyMs };
      }
      if (pageStatus === 'HASISSUES') {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_DEGRADED', description: 'Some issues reported', checkedAt: now, latencyMs };
      }
      return unknown(pageStatus || 'Unknown');
    }

    if (service.customParser === 'statusio') {
      const data = await response.json() as any;
      const overall = data.result?.status_overall;
      const code = overall?.status_code;
      if (code === 100) {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL', description: overall.status || 'All systems operational', checkedAt: now, latencyMs };
      }
      if (code >= 300 && code < 500) {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_DEGRADED', description: overall.status || 'Degraded performance', checkedAt: now, latencyMs };
      }
      if (code >= 500) {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE', description: overall.status || 'Service disruption', checkedAt: now, latencyMs };
      }
      return unknown(overall?.status || 'Unknown status');
    }

    if (service.customParser === 'slack') {
      const data = await response.json() as any;
      if (data.status === 'ok') {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL', description: 'All systems operational', checkedAt: now, latencyMs };
      }
      if (data.status === 'active' || data.active_incidents?.length > 0) {
        const count = data.active_incidents?.length || 1;
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_DEGRADED', description: `${count} active incident(s)`, checkedAt: now, latencyMs };
      }
      return unknown(data.status || 'Unknown');
    }

    if (service.customParser === 'stripe') {
      const data = await response.json() as any;
      if (data.largestatus === 'up') {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL', description: data.message || 'All systems operational', checkedAt: now, latencyMs };
      }
      if (data.largestatus === 'degraded') {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_DEGRADED', description: data.message || 'Degraded performance', checkedAt: now, latencyMs };
      }
      if (data.largestatus === 'down') {
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE', description: data.message || 'Service disruption', checkedAt: now, latencyMs };
      }
      return unknown(data.message || 'Unknown');
    }

    if (service.customParser === 'incidentio') {
      const text = await response.text();
      if (text.startsWith('<!') || text.startsWith('<html')) {
        if (/All Systems Operational|fully operational|no issues/i.test(text)) {
          return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL', description: 'All systems operational', checkedAt: now, latencyMs };
        }
        if (/degraded|partial outage|experiencing issues/i.test(text)) {
          return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_DEGRADED', description: 'Some issues reported', checkedAt: now, latencyMs };
        }
        return unknown('Could not parse status');
      }
      try {
        const data = JSON.parse(text);
        const indicator = data.status?.indicator || '';
        const description = data.status?.description || '';
        if (indicator === 'none' || description.toLowerCase().includes('operational')) {
          return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL', description: description || 'All systems operational', checkedAt: now, latencyMs };
        }
        if (indicator === 'minor' || indicator === 'maintenance') {
          return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_DEGRADED', description: description || 'Minor issues', checkedAt: now, latencyMs };
        }
        if (indicator === 'major' || indicator === 'critical') {
          return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE', description: description || 'Major outage', checkedAt: now, latencyMs };
        }
        return { ...base, status: 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL', description: description || 'Status OK', checkedAt: now, latencyMs };
      } catch {
        return unknown('Invalid response');
      }
    }

    // Default: Statuspage.io JSON format
    const text = await response.text();
    if (text.startsWith('<!') || text.startsWith('<html')) {
      return unknown('Blocked by service');
    }

    let data: any;
    try { data = JSON.parse(text); } catch { return unknown('Invalid JSON response'); }

    if (data.status?.indicator !== undefined) {
      return {
        ...base,
        status: normalizeToProtoStatus(data.status.indicator),
        description: data.status.description || '',
        checkedAt: now, latencyMs,
      };
    }
    if (data.status?.status) {
      return {
        ...base,
        status: data.status.status === 'ok' ? 'SERVICE_OPERATIONAL_STATUS_OPERATIONAL' : 'SERVICE_OPERATIONAL_STATUS_DEGRADED',
        description: data.status.description || '',
        checkedAt: now, latencyMs,
      };
    }
    if (data.page && data.status) {
      return {
        ...base,
        status: normalizeToProtoStatus(data.status.indicator || data.status.description),
        description: data.status.description || 'Status available',
        checkedAt: now, latencyMs,
      };
    }

    return unknown('Unknown format');
  } catch {
    return unknown('Request failed');
  }
}

// ========================================================================
// Outage severity mapping
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
// Handler export
// ========================================================================

export const infrastructureHandler: InfrastructureServiceHandler = {
  async listInternetOutages(
    _ctx: ServerContext,
    req: ListInternetOutagesRequest,
  ): Promise<ListInternetOutagesResponse> {
    try {
      const token = process.env.CLOUDFLARE_API_TOKEN;
      if (!token) {
        return { outages: [], pagination: undefined };
      }

      const response = await fetch(
        `${CLOUDFLARE_RADAR_URL}?dateRange=7d&limit=50`,
        {
          headers: { Authorization: `Bearer ${token}` },
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

      const outages: InternetOutage[] = [];

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

      // Apply optional country filter
      let filtered = outages;
      if (req.country) {
        const target = req.country.toLowerCase();
        filtered = outages.filter((o) => o.country.toLowerCase().includes(target));
      }

      // Apply optional time range filter
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
  },

  async listServiceStatuses(
    _ctx: ServerContext,
    req: ListServiceStatusesRequest,
  ): Promise<ListServiceStatusesResponse> {
    try {
      const results = await Promise.all(SERVICES.map(checkServiceStatus));

      // Apply optional status filter
      let filtered = results;
      if (req.status && req.status !== 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED') {
        filtered = results.filter((s) => s.status === req.status);
      }

      // Sort: outages first, then degraded, then operational
      const statusOrder: Record<string, number> = {
        SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE: 0,
        SERVICE_OPERATIONAL_STATUS_PARTIAL_OUTAGE: 1,
        SERVICE_OPERATIONAL_STATUS_DEGRADED: 2,
        SERVICE_OPERATIONAL_STATUS_MAINTENANCE: 3,
        SERVICE_OPERATIONAL_STATUS_UNSPECIFIED: 4,
        SERVICE_OPERATIONAL_STATUS_OPERATIONAL: 5,
      };
      filtered.sort((a, b) => (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4));

      return { statuses: filtered };
    } catch {
      return { statuses: [] };
    }
  },
};
