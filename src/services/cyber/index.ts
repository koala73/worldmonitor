import {
  CyberServiceClient,
  type CyberThreat as ProtoCyberThreat,
  type ListCyberThreatsResponse,
} from '@/generated/client/worldmonitor/cyber/v1/service_client';
import type {
  CyberThreat,
  CyberThreatType,
  CyberThreatSource,
  CyberThreatSeverity,
  CyberThreatIndicatorType,
} from '@/types';
import { createCircuitBreaker } from '@/utils';

// ---- Client + Circuit Breaker ----

const client = new CyberServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListCyberThreatsResponse>({ name: 'Cyber Threats' });

const emptyFallback: ListCyberThreatsResponse = { threats: [], pagination: undefined };

// ---- Proto enum -> legacy string adapters ----

const THREAT_TYPE_REVERSE: Record<string, CyberThreatType> = {
  CYBER_THREAT_TYPE_C2_SERVER: 'c2_server',
  CYBER_THREAT_TYPE_MALWARE_HOST: 'malware_host',
  CYBER_THREAT_TYPE_PHISHING: 'phishing',
  CYBER_THREAT_TYPE_MALICIOUS_URL: 'malicious_url',
};

const SOURCE_REVERSE: Record<string, CyberThreatSource> = {
  CYBER_THREAT_SOURCE_FEODO: 'feodo',
  CYBER_THREAT_SOURCE_URLHAUS: 'urlhaus',
  CYBER_THREAT_SOURCE_C2INTEL: 'c2intel',
  CYBER_THREAT_SOURCE_OTX: 'otx',
  CYBER_THREAT_SOURCE_ABUSEIPDB: 'abuseipdb',
};

const INDICATOR_TYPE_REVERSE: Record<string, CyberThreatIndicatorType> = {
  CYBER_THREAT_INDICATOR_TYPE_IP: 'ip',
  CYBER_THREAT_INDICATOR_TYPE_DOMAIN: 'domain',
  CYBER_THREAT_INDICATOR_TYPE_URL: 'url',
};

const SEVERITY_REVERSE: Record<string, CyberThreatSeverity> = {
  CRITICALITY_LEVEL_LOW: 'low',
  CRITICALITY_LEVEL_MEDIUM: 'medium',
  CRITICALITY_LEVEL_HIGH: 'high',
  CRITICALITY_LEVEL_CRITICAL: 'critical',
};

// ---- Adapter: proto CyberThreat -> legacy CyberThreat ----

function toCyberThreat(proto: ProtoCyberThreat): CyberThreat {
  return {
    id: proto.id,
    type: THREAT_TYPE_REVERSE[proto.type] || 'malicious_url',
    source: SOURCE_REVERSE[proto.source] || 'feodo',
    indicator: proto.indicator,
    indicatorType: INDICATOR_TYPE_REVERSE[proto.indicatorType] || 'ip',
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    country: proto.country || undefined,
    severity: SEVERITY_REVERSE[proto.severity] || 'low',
    malwareFamily: proto.malwareFamily || undefined,
    tags: proto.tags,
    firstSeen: proto.firstSeenAt ? new Date(proto.firstSeenAt).toISOString() : undefined,
    lastSeen: proto.lastSeenAt ? new Date(proto.lastSeenAt).toISOString() : undefined,
  };
}

// ---- Exported Functions ----

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

function clampInt(rawValue: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(rawValue)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(rawValue as number)));
}

export async function fetchCyberThreats(options: { limit?: number; days?: number } = {}): Promise<CyberThreat[]> {
  const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const days = clampInt(options.days, DEFAULT_DAYS, 1, MAX_DAYS);
  const now = Date.now();

  const resp = await breaker.execute(async () => {
    return client.listCyberThreats({
      timeRange: {
        start: now - days * 24 * 60 * 60 * 1000,
        end: now,
      },
      pagination: { pageSize: limit, cursor: '' },
      type: 'CYBER_THREAT_TYPE_UNSPECIFIED',
      source: 'CYBER_THREAT_SOURCE_UNSPECIFIED',
      minSeverity: 'CRITICALITY_LEVEL_UNSPECIFIED',
    });
  }, emptyFallback);

  return resp.threats.map(toCyberThreat);
}
