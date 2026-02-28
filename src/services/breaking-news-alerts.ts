import type { NewsItem } from '@/types';

export interface BreakingAlert {
  id: string;
  headline: string;
  source: string;
  link?: string;
  threatLevel: 'critical' | 'high';
  timestamp: Date;
  origin: 'rss_alert' | 'keyword_spike' | 'hotspot_escalation' | 'military_surge';
}

export interface AlertSettings {
  enabled: boolean;
  soundEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  sensitivity: 'critical-only' | 'critical-and-high';
}

const SETTINGS_KEY = 'wm-breaking-alerts-v1';
const RECENCY_GATE_MS = 15 * 60 * 1000;
const PER_EVENT_COOLDOWN_MS = 30 * 60 * 1000;
const GLOBAL_COOLDOWN_MS = 60 * 1000;
const SESSION_START = Date.now();

const DEFAULT_SETTINGS: AlertSettings = {
  enabled: true,
  soundEnabled: true,
  desktopNotificationsEnabled: true,
  sensitivity: 'critical-and-high',
};

const dedupeMap = new Map<string, number>();
let lastGlobalAlertMs = 0;
let storageListener: ((e: StorageEvent) => void) | null = null;
let cachedSettings: AlertSettings | null = null;

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\w\s]/g, '').trim().slice(0, 80);
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function makeAlertKey(headline: string, source: string, link?: string): string {
  const parts = normalizeTitle(headline) + '|' + source + '|' + extractHostname(link ?? '');
  return simpleHash(parts);
}

export function getAlertSettings(): AlertSettings {
  if (cachedSettings) return cachedSettings;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      cachedSettings = { ...DEFAULT_SETTINGS, ...parsed };
      return cachedSettings!;
    }
  } catch {}
  cachedSettings = { ...DEFAULT_SETTINGS };
  return cachedSettings;
}

export function updateAlertSettings(partial: Partial<AlertSettings>): void {
  const current = getAlertSettings();
  const updated = { ...current, ...partial };
  cachedSettings = updated;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  } catch {}
}

function isRecent(pubDate: Date): boolean {
  const now = Date.now();
  const recencyCutoff = Math.max(now - RECENCY_GATE_MS, SESSION_START);
  return pubDate.getTime() >= recencyCutoff;
}

function pruneDedupeMap(): void {
  const now = Date.now();
  for (const [key, ts] of dedupeMap) {
    if (now - ts >= PER_EVENT_COOLDOWN_MS) dedupeMap.delete(key);
  }
}

function isDuplicate(key: string): boolean {
  const lastFired = dedupeMap.get(key);
  if (lastFired === undefined) return false;
  return (Date.now() - lastFired) < PER_EVENT_COOLDOWN_MS;
}

function isGlobalCooldown(): boolean {
  return (Date.now() - lastGlobalAlertMs) < GLOBAL_COOLDOWN_MS;
}

function dispatchAlert(alert: BreakingAlert): void {
  pruneDedupeMap();
  dedupeMap.set(alert.id, Date.now());
  lastGlobalAlertMs = Date.now();
  document.dispatchEvent(new CustomEvent('wm:breaking-news', { detail: alert }));
}

export function checkBatchForBreakingAlerts(items: NewsItem[]): void {
  const settings = getAlertSettings();
  if (!settings.enabled) return;
  if (isGlobalCooldown()) return;

  let best: BreakingAlert | null = null;

  for (const item of items) {
    if (!item.isAlert) continue;
    if (!item.threat) continue;
    if (!isRecent(item.pubDate)) continue;

    const level = item.threat.level;
    if (level !== 'critical' && level !== 'high') continue;
    if (settings.sensitivity === 'critical-only' && level !== 'critical') continue;

    const key = makeAlertKey(item.title, item.source, item.link);
    if (isDuplicate(key)) continue;

    if (!best || (level === 'critical' && best.threatLevel !== 'critical')) {
      best = {
        id: key,
        headline: item.title,
        source: item.source,
        link: item.link,
        threatLevel: level as 'critical' | 'high',
        timestamp: item.pubDate,
        origin: 'rss_alert',
      };
    }
  }

  if (best) dispatchAlert(best);
}

export function initBreakingNewsAlerts(): void {
  storageListener = (e: StorageEvent) => {
    if (e.key === SETTINGS_KEY) {
      cachedSettings = null;
    }
  };
  window.addEventListener('storage', storageListener);
}

export function destroyBreakingNewsAlerts(): void {
  if (storageListener) {
    window.removeEventListener('storage', storageListener);
    storageListener = null;
  }
  dedupeMap.clear();
  cachedSettings = null;
  lastGlobalAlertMs = 0;
}
