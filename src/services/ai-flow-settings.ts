/**
 * Quick Settings — Web-only user preferences for AI pipeline and map behavior.
 * Desktop (Tauri) manages AI config via its own settings window.
 *
 * TODO: Migrate panel visibility, sources, and language selector into this
 *       settings hub once the UI is extended with additional sections.
 */

const STORAGE_KEY_BROWSER_MODEL = 'wm-ai-flow-browser-model';
const STORAGE_KEY_CLOUD_LLM = 'wm-ai-flow-cloud-llm';
const STORAGE_KEY_MAP_NEWS_FLASH = 'wm-map-news-flash';
const STORAGE_KEY_BADGE_ANIMATION = 'wm-badge-animation';
const STORAGE_KEY_STREAM_QUALITY = 'wm-stream-quality';
const EVENT_NAME = 'ai-flow-changed';
const STREAM_QUALITY_EVENT = 'stream-quality-changed';

export interface AiFlowSettings {
  browserModel: boolean;
  cloudLlm: boolean;
  mapNewsFlash: boolean;
  badgeAnimation: boolean;
}

function readBool(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === 'true';
  } catch {
    return defaultValue;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Quota or private-browsing; silently ignore
  }
}

const STORAGE_KEY_MAP: Record<keyof AiFlowSettings, string> = {
  browserModel: STORAGE_KEY_BROWSER_MODEL,
  cloudLlm: STORAGE_KEY_CLOUD_LLM,
  mapNewsFlash: STORAGE_KEY_MAP_NEWS_FLASH,
  badgeAnimation: STORAGE_KEY_BADGE_ANIMATION,
};

const DEFAULTS: AiFlowSettings = {
  browserModel: false,
  cloudLlm: true,
  mapNewsFlash: true,
  badgeAnimation: false,
};

export function getAiFlowSettings(): AiFlowSettings {
  return {
    browserModel: readBool(STORAGE_KEY_BROWSER_MODEL, DEFAULTS.browserModel),
    cloudLlm: readBool(STORAGE_KEY_CLOUD_LLM, DEFAULTS.cloudLlm),
    mapNewsFlash: readBool(STORAGE_KEY_MAP_NEWS_FLASH, DEFAULTS.mapNewsFlash),
    badgeAnimation: readBool(STORAGE_KEY_BADGE_ANIMATION, DEFAULTS.badgeAnimation),
  };
}

export function setAiFlowSetting(key: keyof AiFlowSettings, value: boolean): void {
  writeBool(STORAGE_KEY_MAP[key], value);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { key } }));
}

export function isAnyAiProviderEnabled(): boolean {
  const s = getAiFlowSettings();
  return s.cloudLlm || s.browserModel;
}

export function subscribeAiFlowChange(cb: (changedKey?: keyof AiFlowSettings) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { key?: keyof AiFlowSettings } | undefined;
    cb(detail?.key);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

// ── Stream Quality ──

export type StreamQuality = 'auto' | 'small' | 'medium' | 'large' | 'hd720';

export const STREAM_QUALITY_OPTIONS: { value: StreamQuality; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'small', label: 'Low (360p)' },
  { value: 'medium', label: 'Medium (480p)' },
  { value: 'large', label: 'High (480p+)' },
  { value: 'hd720', label: 'HD (720p)' },
];

export function getStreamQuality(): StreamQuality {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STREAM_QUALITY);
    if (raw && ['auto', 'small', 'medium', 'large', 'hd720'].includes(raw)) return raw as StreamQuality;
  } catch { /* ignore */ }
  return 'auto';
}

export function setStreamQuality(quality: StreamQuality): void {
  try {
    localStorage.setItem(STORAGE_KEY_STREAM_QUALITY, quality);
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(STREAM_QUALITY_EVENT, { detail: { quality } }));
}

export function subscribeStreamQualityChange(cb: (quality: StreamQuality) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { quality: StreamQuality };
    cb(detail.quality);
  };
  window.addEventListener(STREAM_QUALITY_EVENT, handler);
  return () => window.removeEventListener(STREAM_QUALITY_EVENT, handler);
}
