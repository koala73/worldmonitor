import { loadFromStorage, saveToStorage } from '@/utils';
import { safeStorageGet } from '@/utils/safe-storage';
import { clearPanelColSpanEntry, clearPanelSpanEntry } from '@/utils/panel-storage';
import { getAuthState } from '@/services/auth-state';
import { isEntitled, getEntitlementState } from '@/services/entitlements';
import {
  clearBrowserKeySession,
  migrateLegacyKeysToHttpOnlySession,
  readBrowserKeySessionStatus,
  readLegacySessionKey,
} from '@/services/browser-key-session';
import { isSelfHostKeyUnlocked, subscribeSelfHostKey } from '@/services/self-host-key';

const STORAGE_KEY = 'wm-custom-widgets';
const MAX_WIDGETS = 10;
const MAX_HISTORY = 10;
const MAX_HTML_CHARS = 50_000;
const MAX_HTML_CHARS_PRO = 80_000;

type WidgetSanitizer = Pick<typeof import('@/utils/widget-sanitizer'), 'sanitizeWidgetHtml'>;

let widgetSanitizerPromise: Promise<WidgetSanitizer> | null = null;

function getWidgetSanitizer(): Promise<WidgetSanitizer> {
  widgetSanitizerPromise ??= import('@/utils/widget-sanitizer').catch((error) => {
    widgetSanitizerPromise = null;
    throw error;
  });
  return widgetSanitizerPromise;
}

function proHtmlKey(id: string): string {
  return `wm-pro-html-${id}`;
}

export interface CustomWidgetSpec {
  id: string;
  title: string;
  html: string;
  prompt: string;
  tier: 'basic' | 'pro';
  accentColor: string | null;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
  updatedAt: number;
}

function materializeWidgets(raw: unknown, strict: boolean): CustomWidgetSpec[] {
  if (!Array.isArray(raw)) {
    if (strict) throw new Error('Stored custom widgets must be an array');
    return [];
  }

  const result: CustomWidgetSpec[] = [];
  for (const candidate of raw) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof (candidate as Partial<CustomWidgetSpec>).id !== 'string'
    ) {
      if (strict) throw new Error('Stored custom widget is malformed');
      continue;
    }
    const w = candidate as CustomWidgetSpec;
    // Legacy widgets predate the `tier` field (added after custom widgets
    // shipped) and have no `tier` key at all. Both loaders normalize a
    // missing/invalid tier to 'basic' rather than dropping the widget from
    // the dashboard.
    const tier = w.tier === 'pro' ? 'pro' : 'basic';
    if (tier === 'pro') {
      const sideKeyHtml = safeStorageGet(proHtmlKey(w.id));
      const storedHtml = typeof w.html === 'string' ? w.html : '';
      const proHtml = storedHtml || sideKeyHtml;
      if (!proHtml) {
        if (strict) throw new Error('Stored Pro widget is missing HTML');
        // HTML missing — drop widget and clean up spans
        clearPanelSpanEntry(w.id);
        clearPanelColSpanEntry(w.id);
        continue;
      }
      result.push({ ...w, tier, html: proHtml });
    } else {
      if (strict && typeof w.html !== 'string') {
        throw new Error('Stored basic widget is missing HTML');
      }
      result.push({ ...w, tier: 'basic' });
    }
  }
  return result;
}

export function loadWidgets(): CustomWidgetSpec[] {
  return materializeWidgets(loadFromStorage<unknown>(STORAGE_KEY, []), false);
}

/**
 * Activation-cohort reads must distinguish a genuinely empty widget list from
 * unavailable or malformed storage. The regular loader intentionally degrades
 * those failures to `[]` for dashboard resilience.
 */
export function loadWidgetsStrict(): CustomWidgetSpec[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  return materializeWidgets(parsed, true);
}

export async function saveWidget(spec: CustomWidgetSpec): Promise<void> {
  if (spec.tier === 'pro') {
    const proHtml = spec.html.slice(0, MAX_HTML_CHARS_PRO);
    const meta: CustomWidgetSpec = {
      ...spec,
      html: proHtml,
      conversationHistory: spec.conversationHistory.slice(-MAX_HISTORY),
    };
    const existing = loadFromStorage<CustomWidgetSpec[]>(STORAGE_KEY, []).filter(w => w.id !== spec.id);
    const updated = [...existing, meta].slice(-MAX_WIDGETS);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      try { localStorage.removeItem(proHtmlKey(spec.id)); } catch { /* ignore legacy side-key cleanup */ }
    } catch {
      throw new Error('Storage quota exceeded saving PRO widget');
    }
  } else {
    const { sanitizeWidgetHtml } = await getWidgetSanitizer();
    const trimmed: CustomWidgetSpec = {
      ...spec,
      tier: 'basic',
      html: sanitizeWidgetHtml(spec.html.slice(0, MAX_HTML_CHARS)),
      conversationHistory: spec.conversationHistory.slice(-MAX_HISTORY),
    };
    const existing = loadWidgets().filter(w => w.id !== trimmed.id);
    const updated = [...existing, trimmed].slice(-MAX_WIDGETS);
    saveToStorage(STORAGE_KEY, updated);
  }
}

export function deleteWidget(id: string): void {
  const updated = loadFromStorage<CustomWidgetSpec[]>(STORAGE_KEY, []).filter(w => w.id !== id);
  saveToStorage(STORAGE_KEY, updated);
  try { localStorage.removeItem(proHtmlKey(id)); } catch { /* ignore */ }
  clearPanelSpanEntry(id);
  clearPanelColSpanEntry(id);
}

export function getWidget(id: string): CustomWidgetSpec | null {
  return loadWidgets().find(w => w.id === id) ?? null;
}

// ── Browser tester key helpers ─────────────────────────────────────────────
// Legacy wm-widget-key / wm-pro-key values used to live in localStorage and
// JS-readable cookies. New writes go to /api/wm-session, which sets short-lived
// HttpOnly cookies. We keep only a tab-local hint so current-page flows can
// update immediately without re-exposing the raw key after reload.
//
// A hint turns on only when the server has said the key is valid: an accepted
// exchange, or the boot status read (GET /api/wm-session) that restores an
// accepted key after a reload. A key that is merely present proves nothing.

let widgetSessionHint = false;
let proSessionHint = false;
let migrationStarted = false;
// Bumped by every explicit key change, so a status answer requested before the
// change cannot overwrite it.
let hintGeneration = 0;
const accessListeners = new Set<() => void>();

function notifyAccessChanged(): void {
  for (const listener of accessListeners) listener();
}

// A self-hosted install's desktop-key verdict is a Pro signal too (KTD9), so
// its unlock changes reach the same listeners. Other verdict changes (a status
// message, a failed check) do not change access and are not forwarded.
let selfHostUnlocked = false;
subscribeSelfHostKey(() => {
  const unlocked = isSelfHostKeyUnlocked();
  if (unlocked === selfHostUnlocked) return;
  selfHostUnlocked = unlocked;
  notifyAccessChanged();
});

/** Observe tab-local tester-key and self-host key access changes without exposing credential values. */
export function subscribeWidgetAccess(listener: () => void): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

function applyHints(next: { widget?: boolean; pro?: boolean }): void {
  const widget = next.widget ?? widgetSessionHint;
  const pro = next.pro ?? proSessionHint;
  if (widget === widgetSessionHint && pro === proSessionHint) return;
  widgetSessionHint = widget;
  proSessionHint = pro;
  notifyAccessChanged();
}

async function restoreKeySessionHints(widgetKey: string, proKey: string): Promise<void> {
  if (widgetKey || proKey) {
    const generation = hintGeneration;
    // A rejected key is removed from storage; a transport failure keeps it for
    // the next boot. Neither turns a hint on.
    const result = await migrateLegacyKeysToHttpOnlySession({ widgetKey, proKey });
    if (generation === hintGeneration) {
      applyHints({
        widget: result.widget === 'accepted' ? true : undefined,
        pro: result.pro === 'accepted' ? true : undefined,
      });
    }
  }
  const generation = hintGeneration;
  const status = await readBrowserKeySessionStatus();
  if (status && generation === hintGeneration) applyHints(status);
}

function migrateLegacyKeyStorage(): void {
  if (migrationStarted || typeof window === 'undefined') return;
  migrationStarted = true;
  const widgetKey = readLegacySessionKey('wm-widget-key');
  const proKey = readLegacySessionKey('wm-pro-key');
  // Never awaited: auth and bootstrap init must not wait on this.
  void restoreKeySessionHints(widgetKey, proKey)
    .catch(() => { /* retry on next boot; a transport failure keeps legacy storage */ });
}

async function setKeySession(name: 'wm-widget-key' | 'wm-pro-key', key: string): Promise<boolean> {
  const trimmed = key.trim();
  const field = name === 'wm-widget-key' ? 'widget' : 'pro';
  // Any explicit change outranks a status answer still in flight.
  hintGeneration += 1;
  const ok = trimmed
    ? (await migrateLegacyKeysToHttpOnlySession(field === 'widget' ? { widgetKey: trimmed } : { proKey: trimmed })).ok
    : await clearBrowserKeySession(name);
  // A rejected key leaves the server's previous cookie in place, so the hint
  // keeps describing that cookie.
  if (ok) {
    if (field === 'widget') widgetSessionHint = !!trimmed;
    else proSessionHint = !!trimmed;
    notifyAccessChanged();
  }
  return ok;
}

export function setWidgetKey(key: string): Promise<boolean> {
  return setKeySession('wm-widget-key', key);
}

export function setProKey(key: string): Promise<boolean> {
  return setKeySession('wm-pro-key', key);
}

export function isWidgetFeatureEnabled(): boolean {
  migrateLegacyKeyStorage();
  return widgetSessionHint;
}

export function getWidgetAgentKey(): string {
  migrateLegacyKeyStorage();
  return '';
}

export function getBrowserTesterKeys(): string[] {
  const keys = [getProWidgetKey(), getWidgetAgentKey()];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of keys) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export function getBrowserTesterKey(): string {
  return getBrowserTesterKeys()[0] ?? '';
}

export function isProWidgetEnabled(): boolean {
  migrateLegacyKeyStorage();
  return proSessionHint;
}

export function isProUser(): boolean {
  return (
    isWidgetFeatureEnabled() ||
    isProWidgetEnabled() ||
    getAuthState().user?.role === 'pro' ||
    isEntitled() ||
    isSelfHostKeyUnlocked()
  );
}

/**
 * Whether `isProUser()` is answering from settled signals rather than from
 * "nothing has loaded yet".
 *
 * A false from isProUser() is ambiguous on a normal page load: Clerk is not
 * awaited, and for a signed-in user the Convex entitlement snapshot lands later
 * still, so a paying subscriber reads as free for the first seconds. Callers
 * that PERSIST a free-tier decision (the boot clamp, the dashboard-tab
 * snapshot heal) must wait for this before writing, or they overwrite a Pro
 * user's layout on every load.
 *
 * A true from isProUser() is always definitive — no signal that says "Pro"
 * needs confirmation.
 *
 * Mirrors `shouldDeferFreeTierEnforcement` in config/panels.ts, which App uses
 * for the same decision plus its grace-timer backstop. The rule is stated twice
 * rather than shared because importing config from services would close a
 * config <-> services import cycle; keep the two in sync.
 */
export function isProTierResolved(): boolean {
  if (isProUser()) return true;
  const session = getAuthState();
  if (session.isPending) return false;
  // Anonymous is a settled answer; a signed-in user still needs the snapshot.
  return session.user === null || getEntitlementState() !== null;
}

export function getProWidgetKey(): string {
  migrateLegacyKeyStorage();
  return '';
}
