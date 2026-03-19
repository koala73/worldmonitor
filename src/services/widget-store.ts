import { loadFromStorage, saveToStorage } from '@/utils';
import { sanitizeWidgetHtml } from '@/utils/widget-sanitizer';

const STORAGE_KEY = 'wm-custom-widgets';
const PANEL_SPANS_KEY = 'worldmonitor-panel-spans';
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

export function isWidgetFeatureEnabled(): boolean {
  try {
    return !!localStorage.getItem('wm-widget-key');
  } catch {
    return false;
  }
}

export function getWidgetAgentKey(): string {
  try {
    return localStorage.getItem('wm-widget-key') ?? '';
  } catch {
    return '';
  }
}

export function isProWidgetEnabled(): boolean {
  try {
    return !!localStorage.getItem('wm-pro-key');
  } catch {
    return false;
  }
}

export function getProWidgetKey(): string {
  try {
    return localStorage.getItem('wm-pro-key') ?? '';
  } catch {
    return '';
  }
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
