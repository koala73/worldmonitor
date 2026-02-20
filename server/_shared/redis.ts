declare const process: { env: Record<string, string | undefined> };

export async function getCachedJson(key: string): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result?: string };
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

export async function setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    // Atomic SET with EX — single call avoids race between SET and EXPIRE (C-3 fix)
    await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}/EX/${ttlSeconds}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch { /* best-effort */ }
}
