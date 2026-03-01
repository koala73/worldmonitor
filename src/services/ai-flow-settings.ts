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
const STORAGE_KEY_HEADLINE_MEMORY = 'wm-headline-memory';
const STORAGE_KEY_BADGE_ANIMATION = 'wm-badge-animation';
const STORAGE_KEY_STREAM_QUALITY = 'wm-stream-quality';
const STORAGE_KEY_FONT_SIZE = 'wm-font-size';
const EVENT_NAME = 'ai-flow-changed';
const STREAM_QUALITY_EVENT = 'stream-quality-changed';
const FONT_SIZE_EVENT = 'font-size-changed';

export interface AiFlowSettings {
  browserModel: boolean;
  cloudLlm: boolean;
  mapNewsFlash: boolean;
  headlineMemory: boolean;
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
  headlineMemory: STORAGE_KEY_HEADLINE_MEMORY,
  badgeAnimation: STORAGE_KEY_BADGE_ANIMATION,
};

const DEFAULTS: AiFlowSettings = {
  browserModel: false,
  cloudLlm: true,
  mapNewsFlash: true,
  headlineMemory: false,
  badgeAnimation: false,
};

export function getAiFlowSettings(): AiFlowSettings {
  return {
    browserModel: readBool(STORAGE_KEY_BROWSER_MODEL, DEFAULTS.browserModel),
    cloudLlm: readBool(STORAGE_KEY_CLOUD_LLM, DEFAULTS.cloudLlm),
    mapNewsFlash: readBool(STORAGE_KEY_MAP_NEWS_FLASH, DEFAULTS.mapNewsFlash),
    headlineMemory: readBool(STORAGE_KEY_HEADLINE_MEMORY, DEFAULTS.headlineMemory),
    badgeAnimation: readBool(STORAGE_KEY_BADGE_ANIMATION, DEFAULTS.badgeAnimation),
  };
}

export function isHeadlineMemoryEnabled(): boolean {
  return readBool(STORAGE_KEY_HEADLINE_MEMORY, DEFAULTS.headlineMemory);
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

// ── Font Size ──

export type FontSize = 'small' | 'normal' | 'large' | 'xlarge';

export const FONT_SIZE_OPTIONS: { value: FontSize; label: string; scale: number }[] = [
  { value: 'small', label: 'Small', scale: 0.875 },
  { value: 'normal', label: 'Normal', scale: 1 },
  { value: 'large', label: 'Large', scale: 1.125 },
  { value: 'xlarge', label: 'Extra Large', scale: 1.25 },
];

export function getFontSize(): FontSize {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FONT_SIZE);
    if (raw && ['small', 'normal', 'large', 'xlarge'].includes(raw)) return raw as FontSize;
  } catch { /* ignore */ }
  return 'normal';
}

export function getFontScale(): number {
  const size = getFontSize();
  return FONT_SIZE_OPTIONS.find(opt => opt.value === size)?.scale ?? 1;
}

export function setFontSize(size: FontSize): void {
  try {
    localStorage.setItem(STORAGE_KEY_FONT_SIZE, size);
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(FONT_SIZE_EVENT, { detail: { size } }));
  // Apply font size to document
  applyFontSize(size);
}

export function applyFontSize(size: FontSize): void {
  const scale = FONT_SIZE_OPTIONS.find(opt => opt.value === size)?.scale ?? 1;
  document.documentElement.style.setProperty('--user-font-scale', String(scale));
}

export function subscribeFontSizeChange(cb: (size: FontSize) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { size: FontSize };
    cb(detail.size);
  };
  window.addEventListener(FONT_SIZE_EVENT, handler);
  return () => window.removeEventListener(FONT_SIZE_EVENT, handler);
}

// Initialize font size on load
if (typeof window !== 'undefined') {
  applyFontSize(getFontSize());
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
