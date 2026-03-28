// @ts-expect-error — JS module, no declaration file
import { keyFingerprint, sha256Hex } from './_crypto.js';

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

// Legacy: 16-char fingerprint for client_credentials tokens (backward compat)
export async function resolveApiKeyFromFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint) return null;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  for (const k of validKeys) {
    if (await keyFingerprint(k) === fingerprint) return k;
  }
  return null;
}

// New: full SHA-256 (64 hex chars) for authorization_code / refresh_token issued tokens
export async function resolveApiKeyFromHash(fullHash) {
  if (typeof fullHash !== 'string' || fullHash.length !== 64) return null;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  for (const k of validKeys) {
    if (await sha256Hex(k) === fullHash) return k;
  }
  return null;
}

export async function resolveApiKeyFromBearer(token) {
  if (!token) return null;
  const stored = await fetchOAuthToken(token);
  if (typeof stored !== 'string' || !stored) return null;
  // Dispatch based on stored value length: 64 = full SHA-256 (new), 16 = fingerprint (legacy)
  if (stored.length === 64) return resolveApiKeyFromHash(stored);
  return resolveApiKeyFromFingerprint(stored);
}
