import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
export const config = { runtime: 'edge' };

// Major tech services and their status page endpoints
// Most use Statuspage.io which has a standard /api/v2/status.json endpoint
const SERVICES = [
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

  // AI Services (incident.io powered)
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

// Statuspage.io API returns status like: none, minor, major, critical
function normalizeStatus(indicator) {
  if (!indicator) return 'unknown';
  const val = indicator.toLowerCase();
  // Check for operational indicators
  if (val === 'none' || val === 'operational' || val.includes('all systems operational')) {
    return 'operational';
  }
  // Check for degraded indicators
  if (val === 'minor' || val === 'degraded_performance' || val === 'partial_outage' || val.includes('degraded')) {
    return 'degraded';
  }
  // Check for outage indicators
  if (val === 'major' || val === 'major_outage' || val === 'critical' || val.includes('outage')) {
    return 'outage';
  }
  return 'unknown';
}

async function checkStatusPage(service) {
  if (!service.statusPage) {
    return { ...service, status: 'unknown', description: 'No API available' };
  }

  try {
    // Use browser-like headers to avoid being blocked
    const headers = {
      'Accept': service.customParser === 'rss' ? 'application/xml, text/xml' : 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    };
    // Don't send User-Agent for incident.io - they may block bots
    if (service.customParser !== 'incidentio') {
      headers['User-Agent'] = 'Mozilla/5.0 (compatible; IntelHQ/1.0)';
    }

    const response = await fetch(service.statusPage, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { ...service, status: 'unknown', description: `HTTP ${response.status}` };
    }

    // Handle custom parsers
    if (service.customParser === 'gcp') {
      const data = await response.json();
      // GCP incidents.json returns array of incidents
      const activeIncidents = Array.isArray(data) ? data.filter(i =>
        i.end === undefined || new Date(i.end) > new Date()
      ) : [];
      if (activeIncidents.length === 0) {
        return { ...service, status: 'operational', description: 'All services operational' };
      }
      const severity = activeIncidents.some(i => i.severity === 'high') ? 'outage' : 'degraded';
      return { ...service, status: severity, description: `${activeIncidents.length} active incident(s)` };
    }

    if (service.customParser === 'aws') {
      // AWS status page is complex HTML - assume operational if reachable
      return { ...service, status: 'operational', description: 'Status page reachable' };
    }

    if (service.customParser === 'rss') {
      // Azure RSS feed - check if there are recent items (incidents)
      const text = await response.text();
      const hasRecentIncident = text.includes('<item>') &&
        (text.includes('degradation') || text.includes('outage') || text.includes('incident'));
      return {
        ...service,
        status: hasRecentIncident ? 'degraded' : 'operational',
        description: hasRecentIncident ? 'Recent incidents reported' : 'No recent incidents'
      };
    }

    if (service.customParser === 'instatus') {
      // Instatus format (Railway, etc.)
      const data = await response.json();
      const pageStatus = data.page?.status;
      if (pageStatus === 'UP') {
        return { ...service, status: 'operational', description: 'All systems operational' };
      } else if (pageStatus === 'HASISSUES') {
        return { ...service, status: 'degraded', description: 'Some issues reported' };
      } else {
        return { ...service, status: 'unknown', description: pageStatus || 'Unknown' };
      }
    }

    if (service.customParser === 'statusio') {
      // Status.io format (GitLab, Docker Hub)
      const data = await response.json();
      const overall = data.result?.status_overall;
      const statusCode = overall?.status_code;
      if (statusCode === 100) {
        return { ...service, status: 'operational', description: overall.status || 'All systems operational' };
      } else if (statusCode >= 300 && statusCode < 500) {
        return { ...service, status: 'degraded', description: overall.status || 'Degraded performance' };
      } else if (statusCode >= 500) {
        return { ...service, status: 'outage', description: overall.status || 'Service disruption' };
      }
      return { ...service, status: 'unknown', description: overall?.status || 'Unknown status' };
    }

    if (service.customParser === 'slack') {
      // Slack custom API format
      const data = await response.json();
      if (data.status === 'ok') {
        return { ...service, status: 'operational', description: 'All systems operational' };
      } else if (data.status === 'active' || data.active_incidents?.length > 0) {
        const count = data.active_incidents?.length || 1;
        return { ...service, status: 'degraded', description: `${count} active incident(s)` };
      }
      return { ...service, status: 'unknown', description: data.status || 'Unknown' };
    }

    if (service.customParser === 'stripe') {
      // Stripe custom API format at /current
      const data = await response.json();
      if (data.largestatus === 'up') {
        return { ...service, status: 'operational', description: data.message || 'All systems operational' };
      } else if (data.largestatus === 'degraded') {
        return { ...service, status: 'degraded', description: data.message || 'Degraded performance' };
      } else if (data.largestatus === 'down') {
        return { ...service, status: 'outage', description: data.message || 'Service disruption' };
      }
      return { ...service, status: 'unknown', description: data.message || 'Unknown' };
    }

    if (service.customParser === 'incidentio') {
      // incident.io status pages (OpenAI, Linear, Replicate, Anthropic)
      const text = await response.text();
      // Check for HTML response (blocked)
      if (text.startsWith('<!') || text.startsWith('<html')) {
        // Try parsing HTML for status - incident.io pages have status in HTML
        const operationalMatch = text.match(/All Systems Operational|fully operational|no issues/i);
        if (operationalMatch) {
          return { ...service, status: 'operational', description: 'All systems operational' };
        }
        const degradedMatch = text.match(/degraded|partial outage|experiencing issues/i);
        if (degradedMatch) {
          return { ...service, status: 'degraded', description: 'Some issues reported' };
        }
        return { ...service, status: 'unknown', description: 'Could not parse status' };
      }
      // Parse JSON response
      try {
        const data = JSON.parse(text);
        const indicator = data.status?.indicator || '';
        const description = data.status?.description || '';
        if (indicator === 'none' || description.toLowerCase().includes('operational')) {
          return { ...service, status: 'operational', description: description || 'All systems operational' };
        } else if (indicator === 'minor' || indicator === 'maintenance') {
          return { ...service, status: 'degraded', description: description || 'Minor issues' };
        } else if (indicator === 'major' || indicator === 'critical') {
          return { ...service, status: 'outage', description: description || 'Major outage' };
        }
        return { ...service, status: 'operational', description: description || 'Status OK' };
      } catch {
        return { ...service, status: 'unknown', description: 'Invalid response' };
      }
    }

    const text = await response.text();

    // Check if we got HTML instead of JSON (blocked/redirected)
    if (text.startsWith('<!') || text.startsWith('<html')) {
      return { ...service, status: 'unknown', description: 'Blocked by service' };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ...service, status: 'unknown', description: 'Invalid JSON response' };
    }

    // Handle different API formats
    let status, description;

    if (data.status?.indicator !== undefined) {
      // Standard Statuspage.io format
      status = normalizeStatus(data.status.indicator);
      description = data.status.description || '';
    } else if (data.status?.status) {
      // Slack format
      status = data.status.status === 'ok' ? 'operational' : 'degraded';
      description = data.status.description || '';
    } else if (data.page && data.status) {
      // Alternative Statuspage format - check if status object exists
      status = normalizeStatus(data.status.indicator || data.status.description);
      description = data.status.description || 'Status available';
    } else {
      status = 'unknown';
      description = 'Unknown format';
    }

    return { ...service, status, description };
  } catch (error) {
    return { ...service, status: 'unknown', description: error.message || 'Request failed' };
  }
}

export default async function handler(req) {
  const cors = getCorsHeaders(req);
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }
  const url = new URL(req.url);
  const category = url.searchParams.get('category'); // cloud, dev, comm, ai, saas, or all

  let servicesToCheck = SERVICES;
  if (category && category !== 'all') {
    servicesToCheck = SERVICES.filter(s => s.category === category);
  }

  // Check all services in parallel
  const results = await Promise.all(servicesToCheck.map(checkStatusPage));

  // Sort by status (outages first, then degraded, then operational)
  const statusOrder = { outage: 0, degraded: 1, unknown: 2, operational: 3 };
  results.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  const summary = {
    operational: results.filter(r => r.status === 'operational').length,
    degraded: results.filter(r => r.status === 'degraded').length,
    outage: results.filter(r => r.status === 'outage').length,
    unknown: results.filter(r => r.status === 'unknown').length,
  };

  return new Response(JSON.stringify({
    success: true,
    timestamp: new Date().toISOString(),
    summary,
    services: results.map(r => ({
      id: r.id,
      name: r.name,
      category: r.category,
      status: r.status,
      description: r.description,
    })),
  }), {
    headers: {
      'Content-Type': 'application/json',
      ...cors,
      'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=30', // 1 min cache
    },
  });
}
