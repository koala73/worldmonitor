import { getRpcBaseUrl } from '@/services/rpc-client';
import type { GetCableHealthResponse, CableHealthRecord as ProtoCableHealthRecord } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { CableHealthRecord, CableHealthResponse, CableHealthStatus } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { InfrastructureServiceClient } from '@/services/generated-rpc-clients';

const client = new InfrastructureServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<GetCableHealthResponse>({ name: 'Cable Health', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
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
    lastUpdated: proto.lastUpdated ? new Date(proto.lastUpdated).toISOString() : '',
    evidence: proto.evidence.map((e) => ({
      source: e.source,
      summary: e.summary,
      ts: e.ts ? new Date(e.ts).toISOString() : '',
    })),
  };
}

// ---- Local cache (1 minute) ----

let cachedResponse: CableHealthResponse | null = null;
let cacheExpiry = 0;
const LOCAL_CACHE_MS = 60_000;
const MAX_RETAINED_AGE_MS = 90 * 60 * 1000;

function isUsableResponse(response: GetCableHealthResponse): boolean {
  if (!response) return false;
  const age = Date.now() - response.generatedAt;
  return !!response.cables && typeof response.cables === 'object' && !Array.isArray(response.cables)
    && Number.isFinite(response.generatedAt) && response.generatedAt > 0
    && age >= 0 && age < MAX_RETAINED_AGE_MS
    && Object.values(response.cables).every((record) => record && typeof record === 'object'
      && typeof record.lastUpdated === 'number' && Number.isFinite(new Date(record.lastUpdated).getTime())
      && Array.isArray(record.evidence)
      && record.evidence.every((e) => e && typeof e === 'object'
        && typeof e.source === 'string' && typeof e.summary === 'string'
        && typeof e.ts === 'number' && Number.isFinite(new Date(e.ts).getTime())));
}

function retainedResponse(): CableHealthResponse | null {
  if (!cachedResponse) return null;
  const age = Date.now() - Date.parse(cachedResponse.generatedAt);
  return age >= 0 && age < MAX_RETAINED_AGE_MS ? cachedResponse : null;
}

// ---- Public API ----

export async function fetchCableHealth(): Promise<CableHealthResponse> {
  const now = Date.now();
  const retained = retainedResponse();
  if (retained && now < cacheExpiry) return retained;

  const resp = await breaker.execute(async () => {
    const response = await client.getCableHealth({});
    if (!isUsableResponse(response)) throw new Error('Cable health unavailable');
    return response;
  }, emptyFallback, { shouldCache: isUsableResponse, staleRefreshMode: 'await' });

  if (!isUsableResponse(resp)) {
    const lastGood = retainedResponse();
    if (lastGood) return lastGood;
    throw new Error('Cable health unavailable');
  }

  const cables: Record<string, CableHealthRecord> = {};
  for (const [id, proto] of Object.entries(resp.cables)) {
    cables[id] = toRecord(proto);
  }

  const result: CableHealthResponse = {
    generatedAt: new Date(resp.generatedAt).toISOString(),
    cables,
  };

  cachedResponse = result;
  cacheExpiry = now + LOCAL_CACHE_MS;

  return result;
}

export function getCableHealthRecord(cableId: string): CableHealthRecord | undefined {
  return retainedResponse()?.cables[cableId];
}

export function getCableHealthMap(): Record<string, CableHealthRecord> {
  return retainedResponse()?.cables ?? {};
}
