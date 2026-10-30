import { startSmartPollLoop, toApiUrl, type SmartPollLoopHandle } from '@/services/runtime';
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
let pollingLoop: SmartPollLoopHandle | null = null;
const updateCallbacks = new Set<(data: OrefAlertsResponse) => void>();

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

const OREF_LABEL_RE = /(?:ALERT|AREAS|DESC)\[[^\]]*\]:\s*/g;

function stripOrefLabels(text: string): string {
  return text.replace(OREF_LABEL_RE, '').trim();
}

export { stripOrefLabels };

// Translate treats its text as data and translates it literally, so OREF sends
// each Hebrew string the dictionary and location map cannot cover as its own
// plain-text request (server-cached per string), and keeps the static
// translation when the LLM has no usable answer. Each string is sent at most
// once per session; null records a failed attempt.
const MAX_LLM_STRINGS_PER_PASS = 8;
const MAX_STRING_TRANSLATIONS = 500;
const MAX_LLM_STRING_LEN = 500;
const stringTranslations = new Map<string, string | null>();

function staticTranslateArea(text: string): string {
  const translated = staticTranslate(text);
  return locationTranslator ? locationTranslator(translated) : translated;
}

function untranslatedString(text: string, fallback: (s: string) => string): string | null {
  if (!text || !hasHebrew(fallback(text))) return null;
  return sanitizeHebrew(text);
}

function pendingStrings(alert: OrefAlert): string[] {
  return [
    untranslatedString(alert.title, staticTranslate),
    ...alert.data.map(d => untranslatedString(d, staticTranslateArea)),
    untranslatedString(alert.desc, staticTranslate),
  ].filter((s): s is string => s !== null);
}

function resolveString(text: string, fallback: (s: string) => string): string {
  const viaStatic = fallback(text);
  if (!text || !hasHebrew(viaStatic)) return viaStatic;
  return stringTranslations.get(sanitizeHebrew(text)) ?? viaStatic;
}

function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  const iter = map.keys();
  while (map.size > max) {
    const k = iter.next().value;
    if (k === undefined) break;
    map.delete(k);
  }
}

// Uses every per-string answer already in hand, so an alert whose remaining
// strings wait for a later pass still shows the ones that are done.
function translateFields(alert: OrefAlert): OrefAlert {
  return {
    ...alert,
    title: resolveString(alert.title, staticTranslate),
    data: alert.data.map(d => resolveString(d, staticTranslateArea)),
    desc: resolveString(alert.desc, staticTranslate),
  };
}

function applyTranslations(alerts: OrefAlert[]): OrefAlert[] {
  return alerts.map(a => {
    const cached = translationCache.get(a.id);
    if (cached) {
      const merged = { ...a, ...cached };
      return alertNeedsTranslation(merged) ? translateFields(merged) : merged;
    }
    if (alertNeedsTranslation(a)) return translateFields(a);
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
      const batch = [...new Set(untranslated.flatMap(pendingStrings))]
        .filter(text => !stringTranslations.has(text))
        .slice(0, MAX_LLM_STRINGS_PER_PASS);
      const results = await Promise.all(batch.map(async (text) => {
        if (text.length > MAX_LLM_STRING_LEN) return [text, null] as const;
        try {
          return [text, await translateText(text, 'en')] as const;
        } catch (e) {
          console.warn('OREF alert translation failed', e);
          return [text, null] as const;
        }
      }));
      for (const [text, result] of results) {
        const answer = result?.trim() ?? '';
        const usable = answer.length > 0 && !hasHebrew(answer);
        stringTranslations.set(text, usable ? answer : null);
        if (usable) translated = true;
      }
      trimOldest(stringTranslations, MAX_STRING_TRANSLATIONS);
      // An alert is settled once every string it needs has been attempted;
      // the rest wait for a later pass.
      for (const alert of untranslated) {
        if (pendingStrings(alert).some(text => !stringTranslations.has(text))) continue;
        translationCache.set(alert.id, {
          title: resolveString(alert.title, staticTranslate),
          data: alert.data.map(d => resolveString(d, staticTranslateArea)),
          desc: resolveString(alert.desc, staticTranslate),
        });
      }
      trimOldest(translationCache, MAX_TRANSLATION_CACHE);
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
  const suffix = endpoint ? `?endpoint=${endpoint}` : '';
  return toApiUrl(`/api/oref-alerts${suffix}`);
}

export async function fetchOrefAlerts(options: { signal?: AbortSignal } = {}): Promise<OrefAlertsResponse> {
  await ensureLocationMapLoaded();
  const now = Date.now();
  if (cachedResponse && now - lastFetchAt < CACHE_TTL) {
    return { ...cachedResponse, alerts: applyTranslations(cachedResponse.alerts) };
  }

  try {
    const res = await fetch(getOrefApiUrl(), {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: options.signal,
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
    if ((err as { name?: string })?.name === 'AbortError') {
      throw err;
    }
    return { configured: false, alerts: [], historyCount24h: 0, timestamp: new Date().toISOString(), error: String(err) };
  }
}

export async function fetchOrefHistory(): Promise<OrefHistoryResponse> {
  await ensureLocationMapLoaded();
  try {
    const res = await fetch(getOrefApiUrl('history'), {
      credentials: 'omit',
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

export function onOrefAlertsUpdate(cb: (data: OrefAlertsResponse) => void): () => void {
  updateCallbacks.add(cb);
  return () => { updateCallbacks.delete(cb); };
}

export function startOrefPolling(): void {
  if (pollingLoop?.isActive()) return;
  pollingLoop = startSmartPollLoop(async ({ signal }) => {
    const data = await fetchOrefAlerts({ signal });
    for (const cb of updateCallbacks) cb(data);
  }, {
    intervalMs: 120_000,
    pauseWhenHidden: true,
    refreshOnVisible: true,
    runImmediately: false,
  });
}

export function stopOrefPolling(): void {
  pollingLoop?.stop();
  pollingLoop = null;
  updateCallbacks.clear();
}
