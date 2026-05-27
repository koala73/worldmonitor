import { loadFromStorage, saveToStorage } from '@/utils';
import { STORAGE_KEYS } from '@/config/variants/base';
import { sanitizeWidgetHtml } from '@/utils/widget-sanitizer';
import { getAuthState } from '@/services/auth-state';
import { isEntitled } from '@/services/entitlements';
import {
  clearLegacyKeyStorage,
  migrateLegacyKeysToHttpOnlySession,
  readLegacySessionKey,
} from '@/services/browser-key-session';

const STORAGE_KEY = 'wm-custom-widgets';
const PANEL_SPANS_KEY = STORAGE_KEYS.panelSpans;
const PANEL_COL_SPANS_KEY = 'worldmonitor-panel-col-spans';
const MAX_WIDGETS = 10;
const MAX_HISTORY = 10;
const MAX_HTML_CHARS = 50_000;
const MAX_HTML_CHARS_PRO = 80_000;

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

export function loadWidgets(): CustomWidgetSpec[] {
  const raw = loadFromStorage<CustomWidgetSpec[]>(STORAGE_KEY, []);
  const result: CustomWidgetSpec[] = [];
  for (const w of raw) {
    const tier = w.tier === 'pro' ? 'pro' : 'basic';
    if (tier === 'pro') {
      const proHtml = localStorage.getItem(proHtmlKey(w.id));
      if (!proHtml) {
        // HTML missing — drop widget and clean up spans
        cleanSpanEntry(PANEL_SPANS_KEY, w.id);
        cleanSpanEntry(PANEL_COL_SPANS_KEY, w.id);
        continue;
      }
      result.push({ ...w, tier, html: proHtml });
    } else {
      result.push({ ...w, tier: 'basic' });
    }
  }
  return result;
}

export function saveWidget(spec: CustomWidgetSpec): void {
  if (spec.tier === 'pro') {
    const proHtml = spec.html.slice(0, MAX_HTML_CHARS_PRO);
    // Write HTML first (raw localStorage — must be catchable for rollback)
    try {
      localStorage.setItem(proHtmlKey(spec.id), proHtml);
    } catch {
      throw new Error('Storage quota exceeded saving PRO widget HTML');
    }
    // Build metadata entry (no html field)
    const meta: Omit<CustomWidgetSpec, 'html'> & { html: string } = {
      ...spec,
      html: '',
      conversationHistory: spec.conversationHistory.slice(-MAX_HISTORY),
    };
    const existing = loadFromStorage<CustomWidgetSpec[]>(STORAGE_KEY, []).filter(w => w.id !== spec.id);
    const updated = [...existing, meta].slice(-MAX_WIDGETS);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // Rollback HTML write
      localStorage.removeItem(proHtmlKey(spec.id));
      throw new Error('Storage quota exceeded saving PRO widget metadata');
    }
  } else {
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
  cleanSpanEntry(PANEL_SPANS_KEY, id);
  cleanSpanEntry(PANEL_COL_SPANS_KEY, id);
}

export function getWidget(id: string): CustomWidgetSpec | null {
  return loadWidgets().find(w => w.id === id) ?? null;
}

// ── Browser tester key helpers ─────────────────────────────────────────────
// Legacy wm-widget-key / wm-pro-key values used to live in localStorage and
// JS-readable cookies. New writes go to /api/wm-session, which sets short-lived
// HttpOnly cookies. We keep only a tab-local hint so current-page flows can
// update immediately without re-exposing the raw key after reload.

let widgetSessionHint = false;
let proSessionHint = false;
let migrationStarted = false;

function migrateLegacyKeyStorage(): void {
  if (migrationStarted || typeof window === 'undefined') return;
  migrationStarted = true;
  const widgetKey = readLegacySessionKey('wm-widget-key');
  const proKey = readLegacySessionKey('wm-pro-key');
  if (!widgetKey && !proKey) return;
  widgetSessionHint = !!widgetKey;
  proSessionHint = !!proKey;
  void migrateLegacyKeysToHttpOnlySession({ widgetKey, proKey })
    .catch(() => { /* retry on next boot; keep legacy storage until success */ });
}

export function setWidgetKey(key: string): void {
  const trimmed = key.trim();
  widgetSessionHint = !!trimmed;
  if (!trimmed) {
    clearLegacyKeyStorage('wm-widget-key');
    return;
  }
  void migrateLegacyKeysToHttpOnlySession({ widgetKey: trimmed })
    .catch(() => { /* caller can retry; no new JS-readable write */ });
}

export function setProKey(key: string): void {
  const trimmed = key.trim();
  proSessionHint = !!trimmed;
  if (!trimmed) {
    clearLegacyKeyStorage('wm-pro-key');
    return;
  }
  void migrateLegacyKeysToHttpOnlySession({ proKey: trimmed })
    .catch(() => { /* caller can retry; no new JS-readable write */ });
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
    isEntitled()
  );
}

export function getProWidgetKey(): string {
  migrateLegacyKeyStorage();
  return '';
}

function cleanSpanEntry(storageKey: string, panelId: string): void {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const spans = JSON.parse(raw) as Record<string, number>;
    if (!(panelId in spans)) return;
    delete spans[panelId];
    if (Object.keys(spans).length === 0) {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, JSON.stringify(spans));
    }
  } catch {
    // ignore
  }
}
