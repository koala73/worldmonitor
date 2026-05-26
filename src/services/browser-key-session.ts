import { establishWmKeySession } from '@/services/wm-session';

export type BrowserSessionKeyName = 'wm-widget-key' | 'wm-pro-key';

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
  if (!widgetKey && !proKey) return false;

  const ok = await establishWmKeySession({
    ...(widgetKey ? { widgetKey } : {}),
    ...(proKey ? { proKey } : {}),
  });
  if (!ok) return false;

  if (widgetKey) clearLegacyKeyStorage('wm-widget-key');
  if (proKey) clearLegacyKeyStorage('wm-pro-key');
  return true;
}
