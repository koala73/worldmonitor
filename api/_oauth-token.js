// @ts-expect-error — JS module, no declaration file
import { keyFingerprint, sha256Hex } from './_crypto.js';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from './_upstash-json.js';

async function fetchOAuthToken(uuid) {
  return readJsonFromUpstash(`oauth:token:${uuid}`);
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
