import type {
  ServerContext,
  ListServiceStatusesRequest,
  ListServiceStatusesResponse,
  ServiceStatus,
  ServiceOperationalStatus,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { UPSTREAM_TIMEOUT_MS } from './_shared';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

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
      headers['User-Agent'] = CHROME_UA;
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
// RPC implementation
// ========================================================================

const INFRA_CACHE_KEY = 'infra:service-statuses:v1';
const INFRA_CACHE_TTL = 300; // 5 minutes

export async function listServiceStatuses(
  _ctx: ServerContext,
  req: ListServiceStatusesRequest,
): Promise<ListServiceStatusesResponse> {
  try {
    // Check Redis cache first to avoid hammering 30+ external status pages (H-8 fix)
    const cached = (await getCachedJson(INFRA_CACHE_KEY)) as ServiceStatus[] | null;
    const results = cached && Array.isArray(cached)
      ? cached
      : await (async () => {
          const fresh = await Promise.all(SERVICES.map(checkServiceStatus));
          await setCachedJson(INFRA_CACHE_KEY, fresh, INFRA_CACHE_TTL);
          return fresh;
        })();

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
}
