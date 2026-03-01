import type { NewsItem } from '@/types';
import type { OrefAlert } from '@/services/oref-alerts';
import { getSourceTier } from '@/config/feeds';

export interface RelatedSource {
  name: string;
  link?: string;
}

export interface BreakingAlert {
  id: string;
  headline: string;
  source: string;
  link?: string;
  threatLevel: 'critical' | 'high';
  timestamp: Date;
  origin: 'rss_alert' | 'keyword_spike' | 'hotspot_escalation' | 'military_surge' | 'oref_siren';
  relatedSources?: RelatedSource[];
}

export interface AlertSettings {
  enabled: boolean;
  soundEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  popupEnabled: boolean;
  sensitivity: 'critical-only' | 'critical-and-high';
}

const SETTINGS_KEY = 'wm-breaking-alerts-v1';
const RECENCY_GATE_MS = 15 * 60 * 1000;
const PER_EVENT_COOLDOWN_MS = 30 * 60 * 1000;
const GLOBAL_COOLDOWN_MS = 60 * 1000;

const DEFAULT_SETTINGS: AlertSettings = {
  enabled: true,
  soundEnabled: true,
  desktopNotificationsEnabled: true,
  popupEnabled: true,
  sensitivity: 'critical-and-high',
};

const dedupeMap = new Map<string, number>();
let lastGlobalAlertMs = 0;
let lastGlobalAlertLevel: 'critical' | 'high' | null = null;
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
  return pubDate.getTime() >= (Date.now() - RECENCY_GATE_MS);
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

function isGlobalCooldown(candidateLevel: 'critical' | 'high'): boolean {
  if ((Date.now() - lastGlobalAlertMs) >= GLOBAL_COOLDOWN_MS) return false;
  if (candidateLevel === 'critical' && lastGlobalAlertLevel !== 'critical') return false;
  return true;
}

function dispatchAlert(alert: BreakingAlert): void {
  pruneDedupeMap();
  dedupeMap.set(alert.id, Date.now());
  lastGlobalAlertMs = Date.now();
  lastGlobalAlertLevel = alert.threatLevel;
  document.dispatchEvent(new CustomEvent('wm:breaking-news', { detail: alert }));
}

export function checkBatchForBreakingAlerts(items: NewsItem[]): void {
  const settings = getAlertSettings();
  if (!settings.enabled) return;

  // Group alerts by normalized headline (similar topics)
  const alertGroups = new Map<string, { level: 'critical' | 'high'; items: NewsItem[] }>();

  for (const item of items) {
    if (!item.isAlert) continue;
    if (!item.threat) continue;
    if (!isRecent(item.pubDate)) continue;

    const level = item.threat.level;
    if (level !== 'critical' && level !== 'high') continue;
    if (settings.sensitivity === 'critical-only' && level !== 'critical') continue;

    // Tier 3+ sources (think tanks, specialty) need LLM confirmation to fire alerts.
    // Keyword-only "war" matches on analysis articles are too noisy.
    const tier = getSourceTier(item.source);
    if (tier >= 3 && item.threat.source === 'keyword') continue;

    const key = makeAlertKey(item.title, item.source, item.link);
    if (isDuplicate(key)) continue;

    // Group by normalized topic (first 40 chars of lowercase title)
    const topicKey = normalizeTitle(item.title).slice(0, 40);
    
    const existing = alertGroups.get(topicKey);
    if (!existing) {
      alertGroups.set(topicKey, { level: level as 'critical' | 'high', items: [item] });
    } else if (level === 'critical' && existing.level !== 'critical') {
      // Upgrade to critical if a critical item comes in
      alertGroups.set(topicKey, { level: 'critical', items: [...existing.items, item] });
    } else {
      existing.items.push(item);
    }
  }

  // Find the best group (critical priority, then most sources, then newest)
  let bestGroup: { level: 'critical' | 'high'; items: NewsItem[] } | null = null;
  
  for (const group of alertGroups.values()) {
    if (!bestGroup) {
      bestGroup = group;
      continue;
    }
    
    // Prioritize critical level
    if (group.level === 'critical' && bestGroup.level !== 'critical') {
      bestGroup = group;
    } else if (group.level === bestGroup.level) {
      // Then prioritize more sources
      if (group.items.length > bestGroup.items.length) {
        bestGroup = group;
      } else if (group.items.length === bestGroup.items.length) {
        // Then prioritize newest
        const groupNewest = Math.max(...group.items.map(i => i.pubDate.getTime()));
        const bestNewest = Math.max(...bestGroup.items.map(i => i.pubDate.getTime()));
        if (groupNewest > bestNewest) {
          bestGroup = group;
        }
      }
    }
  }

  if (!bestGroup || bestGroup.items.length === 0) return;
  if (isGlobalCooldown(bestGroup.level)) return;

  // Build the main alert from the newest item
  const mainItem = bestGroup.items.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())[0];
  const relatedItems = bestGroup.items.filter(i => i.link !== mainItem.link).slice(0, 3);
  
  const alert: BreakingAlert = {
    id: makeAlertKey(mainItem.title, mainItem.source, mainItem.link),
    headline: mainItem.title,
    source: mainItem.source,
    link: mainItem.link,
    threatLevel: bestGroup.level,
    timestamp: mainItem.pubDate,
    origin: 'rss_alert',
    relatedSources: relatedItems.map(item => ({
      name: item.source,
      link: item.link,
    })),
  };

  dispatchAlert(alert);
}

export function dispatchOrefBreakingAlert(alerts: OrefAlert[]): void {
  const settings = getAlertSettings();
  if (!settings.enabled || !alerts.length) return;

  const title = alerts[0]?.title || 'Siren alert';
  const allLocations = alerts.flatMap(a => a.data);
  const shown = allLocations.slice(0, 3);
  const overflow = allLocations.length - shown.length;
  const locationSuffix = shown.length
    ? ' — ' + shown.join(', ') + (overflow > 0 ? ` +${overflow} areas` : '')
    : '';
  const headline = title + locationSuffix;

  const keyParts = alerts.map(a => a.id || `${a.cat}|${a.title}|${a.alertDate}`).sort();
  const dedupeKey = 'oref:' + simpleHash(keyParts.join(','));

  if (isDuplicate(dedupeKey)) return;

  dispatchAlert({
    id: dedupeKey,
    headline,
    source: 'OREF Pikud HaOref',
    threatLevel: 'critical',
    timestamp: new Date(),
    origin: 'oref_siren',
  });
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
  lastGlobalAlertLevel = null;
}
