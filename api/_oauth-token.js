export async function resolveApiKeyFromBearer(req) {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !redisToken) return null;

  try {
    const key = `oauth:token:${token}`;
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data.result) return null;

    const entry = JSON.parse(data.result);
    return entry?.apiKey ?? null;
  } catch {
    return null;
  }
}
