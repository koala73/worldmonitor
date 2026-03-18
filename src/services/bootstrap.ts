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
  const fastCtrl = new AbortController();
  const slowCtrl = new AbortController();
  const desktop = isDesktopRuntime();
  const fastTimeout = setTimeout(() => fastCtrl.abort(), desktop ? 5_000 : 1_200);
  const slowTimeout = setTimeout(() => slowCtrl.abort(), desktop ? 8_000 : 1_800);
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
