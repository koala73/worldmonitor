import {
  InfrastructureServiceClient,
  type GetCableHealthResponse,
  type CableHealthRecord as ProtoCableHealthRecord,
} from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { CableHealthRecord, CableHealthResponse, CableHealthStatus } from '@/types';
import { createCircuitBreaker } from '@/utils';

const client = new InfrastructureServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<GetCableHealthResponse>({ name: 'Cable Health' });
const emptyFallback: GetCableHealthResponse = { generatedAt: 0, cables: {} };

// ---- Proto enum -> frontend string adapter ----

const STATUS_REVERSE: Record<string, CableHealthStatus> = {
  CABLE_HEALTH_STATUS_FAULT: 'fault',
  CABLE_HEALTH_STATUS_DEGRADED: 'degraded',
  CABLE_HEALTH_STATUS_OK: 'ok',
  CABLE_HEALTH_STATUS_UNSPECIFIED: 'unknown',
};

function toRecord(proto: ProtoCableHealthRecord): CableHealthRecord {
  return {
    status: STATUS_REVERSE[proto.status] || 'unknown',
    score: proto.score,
    confidence: proto.confidence,
    lastUpdated: proto.lastUpdated ? new Date(proto.lastUpdated).toISOString() : new Date().toISOString(),
    evidence: proto.evidence.map((e) => ({
      source: e.source,
      summary: e.summary,
      ts: e.ts ? new Date(e.ts).toISOString() : new Date().toISOString(),
    })),
  };
}

// ---- Local cache (1 minute) ----

let cachedResponse: CableHealthResponse | null = null;
let cacheExpiry = 0;
const LOCAL_CACHE_MS = 60_000;

// ---- Public API ----

export async function fetchCableHealth(): Promise<CableHealthResponse> {
  const now = Date.now();
  if (cachedResponse && now < cacheExpiry) return cachedResponse;

  const resp = await breaker.execute(async () => {
    return client.getCableHealth({});
  }, emptyFallback);

  const cables: Record<string, CableHealthRecord> = {};
  for (const [id, proto] of Object.entries(resp.cables)) {
    cables[id] = toRecord(proto);
  }

  const result: CableHealthResponse = {
    generatedAt: resp.generatedAt ? new Date(resp.generatedAt).toISOString() : new Date().toISOString(),
    cables,
  };

  cachedResponse = result;
  cacheExpiry = now + LOCAL_CACHE_MS;

  return result;
}

export function getCableHealthRecord(cableId: string): CableHealthRecord | undefined {
  return cachedResponse?.cables[cableId];
}

export function getCableHealthMap(): Record<string, CableHealthRecord> {
  return cachedResponse?.cables ?? {};
}
