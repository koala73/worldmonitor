import type { NewsItem } from '@/types';
import type { OrefAlert } from '@/services/oref-alerts';
import { getSourceTier } from '@/config/feeds';
import { isDesktopRuntime, getRemoteApiBaseUrl } from '@/services/runtime';
import { getClerkToken } from '@/services/clerk';
import { SITE_VARIANT } from '@/config/variant';

export interface BreakingAlert {
  id: string;
  headline: string;
  source: string;
  link?: string;
  threatLevel: 'critical' | 'high';
  timestamp: Date;
  origin: 'rss_alert' | 'keyword_spike' | 'hotspot_escalation' | 'military_surge' | 'oref_siren';
}

export interface AlertSettings {
  enabled: boolean;
  soundEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  sensitivity: 'critical-only' | 'critical-and-high';
}

const SETTINGS_KEY = 'wm-breaking-alerts-v1';
const DEDUPE_KEY = 'wm-breaking-alerts-dedupe';
const RECENCY_GATE_MS = 15 * 60 * 1000;
// When Railway relay fully handles notifications server-side, set VITE_RELAY_GATES_READY=true
// to stop the browser from double-dispatching via /api/notify.
const RELAY_GATES_READY = import.meta.env.VITE_RELAY_GATES_READY === 'true';
const PER_EVENT_COOLDOWN_MS = 30 * 60 * 1000;
const GLOBAL_COOLDOWN_MS = 60 * 1000;
// Suppress RSS-based alerts during initial feed fetch after app load.
// OREF siren alerts bypass this — real-time sirens must never be delayed.
const STARTUP_GRACE_MS = 10 * 1000;

const DEFAULT_SETTINGS: AlertSettings = {
  enabled: true,
  soundEnabled: true,
  desktopNotificationsEnabled: true,
  sensitivity: 'critical-and-high',
};

const dedupeMap = new Map<string, number>();
let lastGlobalAlertMs = 0;
let lastGlobalAlertLevel: 'critical' | 'high' | null = null;
let storageListener: ((e: StorageEvent) => void) | null = null;
let cachedSettings: AlertSettings | null = null;
let initTimestamp = 0;

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

// ─── Persist dedup map to localStorage ─────────────────────────────────────
// Prevents the same article from re-firing on every page load/refresh.

function loadDedupeMap(): void {
  try {
    const raw = localStorage.getItem(DEDUPE_KEY);
    if (!raw) return;
    const entries: Array<[string, number]> = JSON.parse(raw);
    const now = Date.now();
    for (const [key, ts] of entries) {
      if (now - ts < PER_EVENT_COOLDOWN_MS) {
        dedupeMap.set(key, ts);
      }
    }
  } catch {}
}

function saveDedupeMap(): void {
  try {
    const entries = [...dedupeMap.entries()];
    localStorage.setItem(DEDUPE_KEY, JSON.stringify(entries));
  } catch {}
}

// ─── Settings ──────────────────────────────────────────────────────────────

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

// ─── Gate checks ───────────────────────────────────────────────────────────

function isRecent(pubDate: Date): boolean {
  return pubDate.getTime() >= (Date.now() - RECENCY_GATE_MS);
}

function isInStartupGrace(): boolean {
  return initTimestamp > 0 && (Date.now() - initTimestamp) < STARTUP_GRACE_MS;
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
  console.log('[breaking-news-alerts] dispatching:', alert.origin, alert.threatLevel, alert.headline.slice(0, 60));
  pruneDedupeMap();
  dedupeMap.set(alert.id, Date.now());
  lastGlobalAlertMs = Date.now();
  lastGlobalAlertLevel = alert.threatLevel;
  saveDedupeMap();
  document.dispatchEvent(new CustomEvent('wm:breaking-news', { detail: alert }));

  if (!RELAY_GATES_READY) {
    void (async () => {
      const token = await getClerkToken();
      if (!token) { console.warn('[breaking-news-alerts] no Clerk token, skipping notify'); return; }
      const body = JSON.stringify({
        eventType: alert.origin,
        payload: { title: alert.headline, source: alert.source, link: alert.link },
        severity: alert.threatLevel,
        variant: SITE_VARIANT,
      });
      if (isDesktopRuntime()) {
        // On desktop the fetch patch intercepts /api/* and routes to the local sidecar.
        // Use XHR to send directly to the cloud relay endpoint, bypassing the interceptor.
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${getRemoteApiBaseUrl()}/api/notify`);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(body);
      } else {
        fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body,
        }).then((res) => {
          if (!res.ok) console.warn('[breaking-news-alerts] notify returned', res.status, alert.origin);
          else console.log('[breaking-news-alerts] notify queued:', alert.origin, alert.threatLevel);
        }).catch((err) => { console.warn('[breaking-news-alerts] notify network error:', err); });
      }
    })();
  }
}

export function checkBatchForBreakingAlerts(items: NewsItem[]): void {
  const settings = getAlertSettings();
  if (!settings.enabled) return;

  // During startup grace period, suppress RSS alerts so the initial feed fetch
  // doesn't surface stale articles as "breaking". Articles with updated pubDate
  // (e.g. CBS "updated 2m ago" on a hours-old story) would otherwise fire every
  // time the app is opened.
  if (isInStartupGrace()) return;

  let best: BreakingAlert | null = null;

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

    // Sustained/fading stories are already well-covered; only break/develop phases
    // warrant a banner interrupt. Unspecified (no storyMeta) passes through.
    const phase = item.storyMeta?.phase;
    if (phase === 'sustained' || phase === 'fading') continue;

    const isBetter = !best
      || (level === 'critical' && best.threatLevel !== 'critical')
      || (level === best.threatLevel && item.pubDate.getTime() > best.timestamp.getTime());

    if (isBetter) {
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

  if (best && !isGlobalCooldown(best.threatLevel)) dispatchAlert(best);
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
  initTimestamp = Date.now();
  loadDedupeMap();
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
  initTimestamp = 0;
}
