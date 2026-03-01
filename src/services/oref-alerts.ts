import { getApiBaseUrl } from '@/services/runtime';
import { translateText } from '@/services/summarization';

export interface OrefAlert {
  id: string;
  cat: string;
  title: string;
  data: string[];
  desc: string;
  alertDate: string;
}

export interface OrefAlertsResponse {
  configured: boolean;
  alerts: OrefAlert[];
  historyCount24h: number;
  timestamp: string;
  error?: string;
}

export interface OrefHistoryEntry {
  alerts: OrefAlert[];
  timestamp: string;
}

export interface OrefHistoryResponse {
  configured: boolean;
  history: OrefHistoryEntry[];
  historyCount24h: number;
  timestamp: string;
  error?: string;
}

let cachedResponse: OrefAlertsResponse | null = null;
let lastFetchAt = 0;
const CACHE_TTL = 8_000;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let updateCallbacks: Array<(data: OrefAlertsResponse) => void> = [];

const MAX_TRANSLATION_CACHE = 200;
const translationCache = new Map<string, { title: string; data: string[]; desc: string }>();
let translationPromise: Promise<boolean> | null = null;

const HEBREW_RE = /[\u0590-\u05FF]/;

function hasHebrew(text: string): boolean {
  return HEBREW_RE.test(text);
}

function alertNeedsTranslation(alert: OrefAlert): boolean {
  return hasHebrew(alert.title) || alert.data.some(hasHebrew) || hasHebrew(alert.desc);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTranslationPrompt(alerts: OrefAlert[]): string {
  const lines: string[] = [];
  for (const a of alerts) {
    lines.push(`ALERT[${a.id}]: ${a.title || '(none)'}`);
    lines.push(`AREAS[${a.id}]: ${a.data.join(', ') || '(none)'}`);
    lines.push(`DESC[${a.id}]: ${a.desc || '(none)'}`);
  }
  return 'Translate each line from Hebrew to English. Keep the ALERT/AREAS/DESC labels and IDs exactly as-is. Only translate the text after the colon.\n' + lines.join('\n');
}

function parseTranslationResponse(raw: string, alerts: OrefAlert[]): void {
  const lines = raw.split('\n');
  for (const alert of alerts) {
    const eid = escapeRegExp(alert.id);
    const reAlert = new RegExp(`ALERT\\[${eid}\\]:\\s*(.+)`);
    const reAreas = new RegExp(`AREAS\\[${eid}\\]:\\s*(.+)`);
    const reDesc = new RegExp(`DESC\\[${eid}\\]:\\s*(.+)`);
    let title = alert.title;
    let areas = alert.data;
    let desc = alert.desc;
    for (const line of lines) {
      const alertMatch = line.match(reAlert);
      if (alertMatch?.[1]) title = alertMatch[1].trim();
      const areasMatch = line.match(reAreas);
      if (areasMatch?.[1]) areas = areasMatch[1].split(',').map(s => s.trim());
      const descMatch = line.match(reDesc);
      if (descMatch?.[1]) desc = descMatch[1].trim();
    }
    translationCache.set(alert.id, { title, data: areas, desc });
  }
  if (translationCache.size > MAX_TRANSLATION_CACHE) {
    const excess = translationCache.size - MAX_TRANSLATION_CACHE;
    const iter = translationCache.keys();
    for (let i = 0; i < excess; i++) {
      const k = iter.next().value;
      if (k !== undefined) translationCache.delete(k);
    }
  }
}

function applyTranslations(alerts: OrefAlert[]): OrefAlert[] {
  return alerts.map(a => {
    const cached = translationCache.get(a.id);
    if (cached) return { ...a, ...cached };
    return a;
  });
}

async function translateAlerts(alerts: OrefAlert[]): Promise<boolean> {
  const untranslated = alerts.filter(a => !translationCache.has(a.id) && alertNeedsTranslation(a));
  if (!untranslated.length) {
    if (translationPromise) await translationPromise;
    return false;
  }

  if (translationPromise) {
    await translationPromise;
    return translateAlerts(alerts);
  }

  let translated = false;
  translationPromise = (async () => {
    try {
      const prompt = buildTranslationPrompt(untranslated);
      const result = await translateText(prompt, 'en');
      if (result) {
        parseTranslationResponse(result, untranslated);
        translated = true;
      }
    } catch (e) {
      console.warn('OREF alert translation failed', e);
    } finally {
      translationPromise = null;
    }
    return translated;
  })();

  await translationPromise;
  return translated;
}

function getOrefApiUrl(endpoint?: string): string {
  const base = getApiBaseUrl();
  const suffix = endpoint ? `?endpoint=${endpoint}` : '';
  return `${base}/api/oref-alerts${suffix}`;
}

export async function fetchOrefAlerts(): Promise<OrefAlertsResponse> {
  const now = Date.now();
  if (cachedResponse && now - lastFetchAt < CACHE_TTL) {
    return { ...cachedResponse, alerts: applyTranslations(cachedResponse.alerts) };
  }

  try {
    const res = await fetch(getOrefApiUrl(), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString(), error: `HTTP ${res.status}` };
    }
    const data: OrefAlertsResponse = await res.json();
    cachedResponse = data;
    lastFetchAt = now;

    if (data.alerts.length) {
      translateAlerts(data.alerts).then((didTranslate) => {
        if (didTranslate) {
          for (const cb of updateCallbacks) cb({ ...data, alerts: applyTranslations(data.alerts) });
        }
      }).catch(() => {});
    }

    return { ...data, alerts: applyTranslations(data.alerts) };
  } catch (err) {
    return { configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString(), error: String(err) };
  }
}

export async function fetchOrefHistory(): Promise<OrefHistoryResponse> {
  try {
    const res = await fetch(getOrefApiUrl('history'), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { configured: false, history: [], historyCount24h: 0, timestamp: new Date().toISOString(), error: `HTTP ${res.status}` };
    }
    const data: OrefHistoryResponse = await res.json();

    if (data.history?.length) {
      const recentWaves = data.history.slice(-50);
      const recentAlerts = recentWaves.flatMap(w => w.alerts);
      await translateAlerts(recentAlerts);
      data.history = data.history.map(w => ({
        ...w,
        alerts: applyTranslations(w.alerts),
      }));
    }

    return data;
  } catch (err) {
    return { configured: false, history: [], historyCount24h: 0, timestamp: new Date().toISOString(), error: String(err) };
  }
}

export function onOrefAlertsUpdate(cb: (data: OrefAlertsResponse) => void): void {
  updateCallbacks.push(cb);
}

export function startOrefPolling(): void {
  if (pollingInterval) return;
  pollingInterval = setInterval(async () => {
    const data = await fetchOrefAlerts();
    for (const cb of updateCallbacks) cb(data);
  }, 120_000);
}

export function stopOrefPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  updateCallbacks = [];
}
