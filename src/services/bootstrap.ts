import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

const hydrationCache = new Map<string, unknown>();

export function getHydratedData(key: string): unknown | undefined {
  const val = hydrationCache.get(key);
  if (val !== undefined) hydrationCache.delete(key);
  return val;
}

function populateCache(data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) {
      hydrationCache.set(k, v);
    }
  }
}

async function fetchTier(tier: string, signal: AbortSignal): Promise<void> {
  try {
    const resp = await fetch(toApiUrl(`/api/bootstrap?tier=${tier}`), { signal });
    if (!resp.ok) return;
    const { data } = (await resp.json()) as { data: Record<string, unknown> };
    populateCache(data);
  } catch {
    // silent — panels fall through to individual calls
  }
}

export async function fetchBootstrapData(): Promise<void> {
  // Each tier gets its own abort controller so a slow response in one
  // doesn't kill the other. Timeouts are generous — bootstrap data is
  // critical for instant panel rendering.
  const fastCtrl = new AbortController();
  const slowCtrl = new AbortController();
  // Desktop needs longer timeouts: fetch patch resolves port + token via IPC,
  // then sidecar proxies to cloud. The extra hops easily exceed 3s.
  const desktop = isDesktopRuntime();
  const fastTimeout = setTimeout(() => fastCtrl.abort(), desktop ? 8_000 : 3_000);
  const slowTimeout = setTimeout(() => slowCtrl.abort(), desktop ? 12_000 : 5_000);
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
