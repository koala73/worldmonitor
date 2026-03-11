import { InfrastructureServiceClient } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';

const client = new InfrastructureServiceClient('', { fetch: (input, init) => globalThis.fetch(input, init) });

const hydrationCache = new Map<string, unknown>();

export function getHydratedData(key: string): unknown | undefined {
  const val = hydrationCache.get(key);
  if (val !== undefined) hydrationCache.delete(key);
  return val;
}

function populateCache(data: Record<string, string>): void {
  for (const [k, v] of Object.entries(data)) {
    try {
      const parsed = JSON.parse(v);
      if (parsed !== null && parsed !== undefined) {
        hydrationCache.set(k, parsed);
      }
    } catch { /* skip malformed */ }
  }
}

async function fetchTier(tier: string, signal: AbortSignal): Promise<void> {
  try {
    const response = await client.getBootstrapData({ tier, keys: [] }, { signal });
    populateCache(response.data);
  } catch {
    // silent — panels fall through to individual calls
  }
}

export async function fetchBootstrapData(): Promise<void> {
  const fastCtrl = new AbortController();
  const slowCtrl = new AbortController();
  const fastTimeout = setTimeout(() => fastCtrl.abort(), 3_000);
  const slowTimeout = setTimeout(() => slowCtrl.abort(), 5_000);
  try {
    await Promise.all([
      fetchTier('slow', slowCtrl.signal),
      fetchTier('fast', fastCtrl.signal),
    ]);
  } finally {
    clearTimeout(fastTimeout);
    clearTimeout(slowTimeout);
  }
}

/**
 * fetchBootstrapKeys is a utility for services to fetch specific keys using the RPC client.
 */
export async function fetchBootstrapKeys(keys: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const response = await client.getBootstrapData({ tier: '', keys }, { signal });
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(response.data)) {
      try {
        result[k] = JSON.parse(v);
      } catch { /* skip */ }
    }
    return result;
  } catch (err) {
    console.warn(`[Bootstrap] Failed to fetch keys ${keys.join(',')}:`, err);
    return {};
  }
}
