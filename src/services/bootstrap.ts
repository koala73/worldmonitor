const hydrationCache = new Map<string, unknown>();

export function getHydratedData(key: string): unknown | undefined {
  const val = hydrationCache.get(key);
  if (val !== undefined) hydrationCache.delete(key);
  return val;
}

export async function fetchBootstrapData(): Promise<void> {
  try {
    const resp = await fetch('/api/bootstrap', {
      signal: AbortSignal.timeout(800),
    });
    if (!resp.ok) return;
    const { data } = (await resp.json()) as { data: Record<string, unknown> };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) {
        hydrationCache.set(k, v);
      }
    }
  } catch {
    // silent — panels fall through to individual calls
  }
}
