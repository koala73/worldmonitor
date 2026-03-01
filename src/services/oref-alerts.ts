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
  totalHistoryCount?: number;
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

let locationTranslator: ((s: string) => string) | null = null;
let locationMapPromise: Promise<void> | null = null;

async function ensureLocationMapLoaded(): Promise<void> {
  if (locationTranslator) return;
  if (locationMapPromise) { await locationMapPromise; return; }
  locationMapPromise = import('./oref-locations').then(m => {
    locationTranslator = m.translateLocation;
  }).catch(() => { locationMapPromise = null; console.warn('[OREF] Failed to load location translations, will retry'); });
  await locationMapPromise;
}

const MAX_TRANSLATION_CACHE = 200;
const translationCache = new Map<string, { title: string; data: string[]; desc: string }>();
let translationPromise: Promise<boolean> | null = null;

function sanitizeHebrew(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .trim()
    .replace(/\s+/g, ' ');
}

const HEBREW_RE = /[\u0590-\u05FF]/;

const STATIC_TRANSLATIONS: Record<string, string> = {
  'ירי רקטות וטילים': 'Rocket and missile fire',
  'חדירת כלי טיס עוין': 'Hostile aircraft intrusion',
  'רעידת אדמה': 'Earthquake',
  'צונאמי': 'Tsunami',
  'חומרים מסוכנים': 'Hazardous materials',
  'פריצת מחסום': 'Security breach',
  'חשש לחדירה עוינת': 'Suspected hostile infiltration',
  'אירוע רדיולוגי': 'Radiological event',
  'אירוע חומרים מסוכנים': 'Hazardous materials event',
  'היכנסו למרחב המוגן': 'Enter the protected space',
  'ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו': 'You may leave the protected space but stay nearby',
  'ניתן לצאת מהמרחב המוגן': 'You may leave the protected space',
  'בדקות הקרובות צפויות להתקבל התרעות באזורך': 'Alerts expected in your area soon',
  'התרעה לא קונבנציונלית': 'Non-conventional threat alert',
  'ירי שיגור רקטות': 'Rocket launch fire',
  'התקפה כימית': 'Chemical attack',
  'חדירת מחבלים': 'Terrorist infiltration',
  'שריפה גדולה': 'Large fire',
  'אזעקה': 'Siren alert',
  'ירי רקטות': 'Rocket fire',
  'ירי טילים': 'Missile fire',
  'התגוננו': 'Take shelter',
};

function staticTranslate(text: string): string {
  if (!text || !HEBREW_RE.test(text)) return text;
  const sanitized = sanitizeHebrew(text);
  const direct = STATIC_TRANSLATIONS[sanitized];
  if (direct) return direct;
  let result = sanitized;
  for (const [heb, eng] of Object.entries(STATIC_TRANSLATIONS)) {
    if (result.includes(heb)) result = result.replace(heb, eng);
  }
  return result;
}

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
    if (alertNeedsTranslation(a)) {
      return {
        ...a,
        title: staticTranslate(a.title),
        data: a.data.map(d => locationTranslator ? locationTranslator(staticTranslate(d)) : staticTranslate(d)),
        desc: staticTranslate(a.desc),
      };
    }
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
  await ensureLocationMapLoaded();
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
  await ensureLocationMapLoaded();
  try {
    const res = await fetch(getOrefApiUrl('history'), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn('[OREF History] HTTP', res.status);
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
