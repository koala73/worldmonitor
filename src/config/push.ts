// Web Push configuration (Phase 6).
//
// The VAPID public key is served from the `VITE_VAPID_PUBLIC_KEY`
// build-time env var ONLY. No committed fallback:
//
//   - A committed fallback means two sources of truth (code vs env)
//     which causes "did the rotation actually ship?" confusion.
//   - The public key is public, but rotating the keypair should be a
//     pure env-var operation (update Vercel + Railway env → redeploy),
//     not a code change.
//   - If the env var is missing at build time we WANT the push
//     subscribe path to fail loudly at runtime rather than silently
//     register against a stale key.
//
// Partner private key lives in Railway (`VAPID_PRIVATE_KEY`) and
// signs the JWT attached to every push delivery. NEVER paste it in
// PR descriptions, commit messages, issue comments, or chat — a
// leaked VAPID private key grants send-to-any-subscriber capability
// against this origin's push subscribers.

const ENV_KEY = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_VAPID_PUBLIC_KEY;

/**
 * VAPID public key from build-time env. Empty string when the env
 * var is unset — `isWebPushConfigured()` guards the subscribe flow
 * so callers don't attempt `pushManager.subscribe` without a key.
 */
export const VAPID_PUBLIC_KEY: string =
  typeof ENV_KEY === 'string' ? ENV_KEY.trim() : '';

/** True when the client bundle was built with a VAPID public key set. */
export function isWebPushConfigured(): boolean {
  return VAPID_PUBLIC_KEY.length > 0;
}

/** Convert a URL-safe base64 VAPID key into the Uint8Array pushManager wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normal = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normal);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Convert an ArrayBuffer push-subscription key into a URL-safe base64 string. */
export function arrayBufferToBase64(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
