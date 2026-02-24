/**
 * Unified infrastructure service module -- replaces two legacy services:
 *   - src/services/outages.ts (Cloudflare Radar internet outages)
 *   - ServiceStatusPanel's direct /api/service-status fetch
 *
 * All data now flows through the InfrastructureServiceClient RPC.
 */

import {
  InfrastructureServiceClient,
  type ListInternetOutagesResponse,
  type ListServiceStatusesResponse,
  type InternetOutage as ProtoOutage,
  type ServiceStatus as ProtoServiceStatus,
} from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { InternetOutage } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { isFeatureAvailable } from '../runtime-config';

// ---- Client + Circuit Breakers ----

const client = new InfrastructureServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const outageBreaker = createCircuitBreaker<ListInternetOutagesResponse>({ name: 'Internet Outages' });
const statusBreaker = createCircuitBreaker<ListServiceStatusesResponse>({ name: 'Service Statuses' });

const emptyOutageFallback: ListInternetOutagesResponse = { outages: [], pagination: undefined };
const emptyStatusFallback: ListServiceStatusesResponse = { statuses: [] };

// ---- Proto enum -> legacy string adapters ----

const SEVERITY_REVERSE: Record<string, 'partial' | 'major' | 'total'> = {
  OUTAGE_SEVERITY_PARTIAL: 'partial',
  OUTAGE_SEVERITY_MAJOR: 'major',
  OUTAGE_SEVERITY_TOTAL: 'total',
};

const STATUS_REVERSE: Record<string, 'operational' | 'degraded' | 'outage' | 'unknown'> = {
  SERVICE_OPERATIONAL_STATUS_OPERATIONAL: 'operational',
  SERVICE_OPERATIONAL_STATUS_DEGRADED: 'degraded',
  SERVICE_OPERATIONAL_STATUS_PARTIAL_OUTAGE: 'outage',
  SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE: 'outage',
  SERVICE_OPERATIONAL_STATUS_MAINTENANCE: 'degraded',
  SERVICE_OPERATIONAL_STATUS_UNSPECIFIED: 'unknown',
};

// ---- Adapter: proto InternetOutage -> legacy InternetOutage ----

function toOutage(proto: ProtoOutage): InternetOutage {
  return {
    id: proto.id,
    title: proto.title,
    link: proto.link,
    description: proto.description,
    pubDate: proto.detectedAt ? new Date(proto.detectedAt) : new Date(),
    country: proto.country,
    region: proto.region || undefined,
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    severity: SEVERITY_REVERSE[proto.severity] || 'partial',
    categories: proto.categories,
    cause: proto.cause || undefined,
    outageType: proto.outageType || undefined,
    endDate: proto.endedAt ? new Date(proto.endedAt) : undefined,
  };
}

// ========================================================================
// Internet Outages -- replaces src/services/outages.ts
// ========================================================================

let outagesConfigured: boolean | null = null;

export function isOutagesConfigured(): boolean | null {
  return outagesConfigured;
}

export async function fetchInternetOutages(): Promise<InternetOutage[]> {
  if (!isFeatureAvailable('internetOutages')) {
    outagesConfigured = false;
    return [];
  }

  const resp = await outageBreaker.execute(async () => {
    return client.listInternetOutages({
      country: '',
    });
  }, emptyOutageFallback);

  if (resp.outages.length === 0) {
    // Could be not configured or just no current outages -- keep previous state
    // unless we've never fetched before
    if (outagesConfigured === null) outagesConfigured = false;
    return [];
  }

  outagesConfigured = true;
  return resp.outages.map(toOutage);
}

export function getOutagesStatus(): string {
  return outageBreaker.getStatus();
}

// ========================================================================
// Service Statuses -- replaces direct /api/service-status fetch
// ========================================================================

export interface ServiceStatusResult {
  id: string;
  name: string;
  category: string;
  status: 'operational' | 'degraded' | 'outage' | 'unknown';
  description: string;
}

export interface ServiceStatusSummary {
  operational: number;
  degraded: number;
  outage: number;
  unknown: number;
}

export interface ServiceStatusResponse {
  success: boolean;
  timestamp: string;
  summary: ServiceStatusSummary;
  services: ServiceStatusResult[];
}

// Category map for the service IDs (matches the handler's SERVICES list)
const CATEGORY_MAP: Record<string, string> = {
  aws: 'cloud', azure: 'cloud', gcp: 'cloud', cloudflare: 'cloud', vercel: 'cloud',
  netlify: 'cloud', digitalocean: 'cloud', render: 'cloud', railway: 'cloud',
  github: 'dev', gitlab: 'dev', npm: 'dev', docker: 'dev', bitbucket: 'dev',
  circleci: 'dev', jira: 'dev', confluence: 'dev', linear: 'dev',
  slack: 'comm', discord: 'comm', zoom: 'comm', notion: 'comm',
  openai: 'ai', anthropic: 'ai', replicate: 'ai',
  stripe: 'saas', twilio: 'saas', datadog: 'saas', sentry: 'saas', supabase: 'saas',
};

function toServiceResult(proto: ProtoServiceStatus): ServiceStatusResult {
  return {
    id: proto.id,
    name: proto.name,
    category: CATEGORY_MAP[proto.id] || 'saas',
    status: STATUS_REVERSE[proto.status] || 'unknown',
    description: proto.description,
  };
}

export async function fetchServiceStatuses(): Promise<ServiceStatusResponse> {
  const resp = await statusBreaker.execute(async () => {
    return client.listServiceStatuses({
      status: 'SERVICE_OPERATIONAL_STATUS_UNSPECIFIED',
    });
  }, emptyStatusFallback);

  const services = resp.statuses.map(toServiceResult);

  const summary: ServiceStatusSummary = {
    operational: services.filter((s) => s.status === 'operational').length,
    degraded: services.filter((s) => s.status === 'degraded').length,
    outage: services.filter((s) => s.status === 'outage').length,
    unknown: services.filter((s) => s.status === 'unknown').length,
  };

  return {
    success: true,
    timestamp: new Date().toISOString(),
    summary,
    services,
  };
}
