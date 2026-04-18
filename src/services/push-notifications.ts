// Web Push subscription lifecycle (Phase 6).
//
// Tiny wrapper around navigator.serviceWorker.pushManager that:
//   1. Waits for the existing service worker (registered in main.ts)
//   2. Calls Notification.requestPermission() if not already granted
//   3. Calls pushManager.subscribe({ userVisibleOnly, applicationServerKey })
//   4. Hands the { endpoint, p256dh, auth } triple to the
//      /api/notification-channels edge route as action=set-web-push
//   5. Mirrors unsubscribe on delete
//
// Notes on scope:
//   - We do NOT register a fresh service worker here. VitePWA already
//     registers /sw.js at '/' scope in main.ts. Browsers enforce one
//     SW per scope, and the VitePWA SW imports our push handler via
//     workbox.importScripts.
//   - Permission state is read-through, not cached. Browsers handle
//     the prompt UX; repeated requestPermission() calls while 'default'
//     are idempotent per spec.
//   - On subscribe(), if a prior subscription exists on this device
//     we return it without re-prompting. Re-linking an already-linked
//     device is a no-op from the user's perspective.

import { getClerkToken } from '@/services/clerk';
import { VAPID_PUBLIC_KEY, isWebPushConfigured, urlBase64ToUint8Array, arrayBufferToBase64 } from '@/config/push';

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

/**
 * True if the current context can reasonably attempt web push.
 * Tauri's webview, iOS Safari without "Add to Home Screen", and
 * in-app browsers typically fail this check and the UI should
 * surface a "Install the app first" hint instead of an error.
 *
 * Also returns false when the client bundle was built without a
 * VAPID public key (VITE_VAPID_PUBLIC_KEY unset at build time) —
 * in that case subscribe() would throw a cryptic pushManager error;
 * surfacing it as "unsupported" routes the UI through the same
 * "can't subscribe on this build" path as iOS/Tauri.
 */
export function isWebPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  if (typeof Notification === 'undefined') return false;
  if (!isWebPushConfigured()) return false;
  return true;
}

export function getPushPermission(): PushPermission {
  if (!isWebPushSupported()) return 'unsupported';
  return Notification.permission as PushPermission;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isWebPushSupported()) return null;
  // VitePWA's registered SW is at '/'. getRegistration() without args
  // returns the one that controls the current page; .ready waits until
  // it's actually active so pushManager.subscribe() doesn't race.
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/** Read-only: is there an existing push subscription for this device? */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  const reg = await getRegistration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

interface SubscriptionPayload {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
}

function subscriptionToPayload(sub: PushSubscription): SubscriptionPayload | null {
  const p256dh = arrayBufferToBase64(sub.getKey('p256dh'));
  const auth = arrayBufferToBase64(sub.getKey('auth'));
  if (!p256dh || !auth || !sub.endpoint) return null;
  return {
    endpoint: sub.endpoint,
    p256dh,
    auth,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : '',
  };
}

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const token = await getClerkToken();
  if (!token) throw new Error('Not authenticated');
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

/**
 * Ask permission (if needed), subscribe via pushManager, and register
 * the endpoint with the server. Resolves with the payload the server
 * accepted, or throws on cancel / denial / network failure.
 */
export async function subscribeToPush(): Promise<SubscriptionPayload> {
  if (!isWebPushSupported()) {
    throw new Error('Web push is not supported in this browser.');
  }
  const reg = await getRegistration();
  if (!reg) throw new Error('Service worker unavailable.');

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(
      perm === 'denied'
        ? 'Notifications are blocked. Enable them in your browser settings to continue.'
        : 'Notifications permission was not granted.',
    );
  }

  // Re-use an existing subscription if pushManager already has one
  // for this origin. Re-registering via POST keeps server state in
  // sync even when the browser has a stale subscription — this is
  // important after sign-out/sign-in, where the browser's push
  // identity persists but the Convex row does not.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });
  }

  const payload = subscriptionToPayload(sub);
  if (!payload) {
    // Chrome occasionally hands back a subscription with null keys on
    // first-grant. Unsubscribe and retry once.
    await sub.unsubscribe().catch(() => {});
    const retry = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });
    const retryPayload = subscriptionToPayload(retry);
    if (!retryPayload) throw new Error('Failed to extract push subscription keys.');
    await postSubscription(retryPayload);
    return retryPayload;
  }

  await postSubscription(payload);
  return payload;
}

async function postSubscription(payload: SubscriptionPayload): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    body: JSON.stringify({ action: 'set-web-push', ...payload }),
  });
  if (!res.ok) {
    throw new Error(`Failed to register push subscription (${res.status}).`);
  }
}

/** Reverse of subscribeToPush: unregisters with the server and the browser. */
export async function unsubscribeFromPush(): Promise<void> {
  const reg = await getRegistration();
  if (reg) {
    const sub = await reg.pushManager.getSubscription().catch(() => null);
    if (sub) {
      // Best-effort browser-side unsubscribe. If the network delete
      // fails we still want the browser subscription removed so the
      // user isn't left with a phantom channel.
      await sub.unsubscribe().catch(() => {});
    }
  }
  try {
    await authFetch('/api/notification-channels', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete-channel', channelType: 'web_push' }),
    });
  } catch {
    // Ignore — best-effort. Server will age the row out naturally.
  }
}
