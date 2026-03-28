// @ts-expect-error — JS module, no declaration file
import { keyFingerprint } from './_crypto.js';

async function fetchOAuthToken(uuid) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const resp = await fetch(`${url}/get/${encodeURIComponent(`oauth:token:${uuid}`)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);

  const data = await resp.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

export async function resolveApiKeyFromBearer(token) {
  if (!token) return null;
  const fingerprint = await fetchOAuthToken(token);
  if (typeof fingerprint !== 'string' || !fingerprint) return null;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  for (const k of validKeys) {
    if (await keyFingerprint(k) === fingerprint) return k;
  }
  return null;
}
