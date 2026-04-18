// Web Push configuration (Phase 6).
//
// VAPID public key is NOT a secret — it's the public half of the
// keypair whose private half lives in Railway (VAPID_PRIVATE_KEY)
// and signs the JWT attached to every push delivery. It's shipped
// in client bundles at worldmonitor.app and in the PWA manifest.
//
// An env override is supported primarily so a single-key rotation
// can roll without redeploying the static bundle, though in practice
// rotating the keypair invalidates every existing subscription and
// is rarely worth it.

const ENV_KEY = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_VAPID_PUBLIC_KEY;

// Generated 2026-04-18 via `npx web-push generate-vapid-keys`.
// Partner private key lives only in Railway service env.
const DEFAULT_VAPID_PUBLIC_KEY =
  'BNIrVn4fQrNVN82cADphw320VdnaaAGwjnJNHZJAMyUepPJywn8LSJZTeNpWgqYOOstaJQUZ1WugocN-RKlPAQM';

export const VAPID_PUBLIC_KEY: string =
  typeof ENV_KEY === 'string' && ENV_KEY.length > 0 ? ENV_KEY : DEFAULT_VAPID_PUBLIC_KEY;

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
