import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';
import {
  establishWmKeySessionOutcome,
  fetchWmKeySessionStatus,
  type KeySessionOutcome,
  type WmKeySessionStatus,
} from '@/services/wm-session';

export type BrowserSessionKeyName = 'wm-widget-key' | 'wm-pro-key';

/** What the server said about one submitted key. */
export type KeyVerdict = 'accepted' | 'rejected' | 'failed';

export interface KeyExchangeResult {
  /** True only when every submitted key was accepted. */
  ok: boolean;
  widget?: KeyVerdict;
  pro?: KeyVerdict;
}

/**
 * Records that this browser once had a tester key accepted, so a reload knows
 * an HttpOnly key cookie may exist and is worth asking about. Holds no key.
 * Without it every anonymous page load would spend a status request.
 */
export const KEY_SESSION_MARKER = 'wm-key-session-check';

// Finish a pending exchange before clearing, so its later Set-Cookie cannot
// restore a credential after the caller's clear has completed.
let keySessionChange: Promise<unknown> = Promise.resolve();
function changeKeySession(keys: { widgetKey?: string; proKey?: string }): Promise<KeySessionOutcome> {
  const next = keySessionChange.then(() => establishWmKeySessionOutcome(keys));
  keySessionChange = next.catch(() => undefined);
  return next;
}

function safeLocalStorageGet(name: string): string {
  return safeStorageGet(name) ?? '';
}

function safeReadableCookieGet(name: BrowserSessionKeyName): string {
  try {
    const prefix = `${name}=`;
    const match = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(prefix));
    return match ? decodeURIComponent(match.slice(prefix.length)).trim() : '';
  } catch {
    return '';
  }
}

function clearLegacyReadableCookie(name: BrowserSessionKeyName): void {
  try {
    document.cookie = `${name}=; domain=.worldmonitor.app; path=/; max-age=0; SameSite=Lax; Secure`;
    document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax; Secure`;
  } catch {
    // ignore
  }
}

export function readLegacySessionKey(name: BrowserSessionKeyName): string {
  return safeLocalStorageGet(name).trim() || safeReadableCookieGet(name);
}

export function clearLegacyKeyStorage(name: BrowserSessionKeyName): void {
  safeStorageRemove(name);
  clearLegacyReadableCookie(name);
}

export async function migrateLegacyKeysToHttpOnlySession(keys: {
  widgetKey?: string;
  proKey?: string;
}): Promise<KeyExchangeResult> {
  const widgetKey = keys.widgetKey?.trim() ?? '';
  const proKey = keys.proKey?.trim() ?? '';
  const exchanges: Array<[BrowserSessionKeyName, { widgetKey?: string; proKey?: string }]> = [];
  if (widgetKey) exchanges.push(['wm-widget-key', { widgetKey }]);
  if (proKey) exchanges.push(['wm-pro-key', { proKey }]);
  if (!exchanges.length) return { ok: false };

  // One exchange per key. The server answers a single 401 for the whole body
  // and an omitted field preserves that key's cookie, so exchanging them
  // separately is what makes the verdict per key.
  const result: KeyExchangeResult = { ok: true };
  for (const [name, body] of exchanges) {
    const outcome = await changeKeySession(body);
    // A key the server rejected is revoked or invalid. Keeping it in
    // localStorage would retry it on every boot and leave a JS-readable
    // credential behind forever. A transport or server failure keeps it for
    // the next attempt.
    if (outcome.ok || outcome.rejected) clearLegacyKeyStorage(name);
    if (outcome.ok) safeStorageSet(KEY_SESSION_MARKER, '1');
    const verdict: KeyVerdict = outcome.ok ? 'accepted' : outcome.rejected ? 'rejected' : 'failed';
    if (name === 'wm-widget-key') result.widget = verdict;
    else result.pro = verdict;
    if (!outcome.ok) result.ok = false;
  }
  return result;
}

/**
 * Ask the server which HttpOnly tester-key sessions are valid right now.
 *
 * Resolves null when the answer is unknown: no key was ever accepted in this
 * browser (no request is sent), or the request failed. Queued behind any
 * pending exchange so it reports the cookie that exchange set.
 */
export async function readBrowserKeySessionStatus(): Promise<WmKeySessionStatus | null> {
  // The marker is read after the queue drains: a pending exchange may set it.
  const next = keySessionChange.then(() =>
    safeLocalStorageGet(KEY_SESSION_MARKER) ? fetchWmKeySessionStatus() : null);
  keySessionChange = next.catch(() => undefined);
  const status = await next;
  if (status && !status.widget && !status.pro) safeStorageRemove(KEY_SESSION_MARKER);
  return status;
}

/** Delete an HttpOnly tester credential at the same API host that issued it. */
export async function clearBrowserKeySession(name: BrowserSessionKeyName): Promise<boolean> {
  const outcome = await changeKeySession(name === 'wm-widget-key' ? { widgetKey: '' } : { proKey: '' });
  if (outcome.ok) clearLegacyKeyStorage(name);
  return outcome.ok;
}
