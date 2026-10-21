import { establishWmKeySessionOutcome, type KeySessionOutcome } from '@/services/wm-session';

export type BrowserSessionKeyName = 'wm-widget-key' | 'wm-pro-key';

// Finish a pending exchange before clearing, so its later Set-Cookie cannot
// restore a credential after the caller's clear has completed.
let keySessionChange: Promise<unknown> = Promise.resolve();
function changeKeySession(keys: { widgetKey?: string; proKey?: string }): Promise<KeySessionOutcome> {
  const next = keySessionChange.then(() => establishWmKeySessionOutcome(keys));
  keySessionChange = next.catch(() => undefined);
  return next;
}

function safeLocalStorageGet(name: BrowserSessionKeyName): string {
  try { return localStorage.getItem(name) ?? ''; } catch { return ''; }
}

function safeLocalStorageRemove(name: BrowserSessionKeyName): void {
  try { localStorage.removeItem(name); } catch { /* ignore */ }
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
  safeLocalStorageRemove(name);
  clearLegacyReadableCookie(name);
}

export async function migrateLegacyKeysToHttpOnlySession(keys: {
  widgetKey?: string;
  proKey?: string;
}): Promise<boolean> {
  const widgetKey = keys.widgetKey?.trim() ?? '';
  const proKey = keys.proKey?.trim() ?? '';
  const exchanges: Array<[BrowserSessionKeyName, { widgetKey?: string; proKey?: string }]> = [];
  if (widgetKey) exchanges.push(['wm-widget-key', { widgetKey }]);
  if (proKey) exchanges.push(['wm-pro-key', { proKey }]);
  if (!exchanges.length) return false;

  // One exchange per key. The server answers a single 401 for the whole body
  // and an omitted field preserves that key's cookie, so exchanging them
  // separately is what makes the verdict per key.
  let allOk = true;
  for (const [name, body] of exchanges) {
    const outcome = await changeKeySession(body);
    // A key the server rejected is revoked or invalid. Keeping it in
    // localStorage would retry it on every boot and leave a JS-readable
    // credential behind forever. A transport or server failure keeps it for
    // the next attempt.
    if (outcome.ok || outcome.rejected) clearLegacyKeyStorage(name);
    if (!outcome.ok) allOk = false;
  }
  return allOk;
}

/** Delete an HttpOnly tester credential at the same API host that issued it. */
export async function clearBrowserKeySession(name: BrowserSessionKeyName): Promise<boolean> {
  const outcome = await changeKeySession(name === 'wm-widget-key' ? { widgetKey: '' } : { proKey: '' });
  if (outcome.ok) clearLegacyKeyStorage(name);
  return outcome.ok;
}
