export type GlobeRenderScale = 'auto' | '1' | '1.5' | '2' | '3';

const STORAGE_KEY = 'wm-globe-render-scale';
const EVENT_NAME = 'wm-globe-render-scale-changed';

export const GLOBE_RENDER_SCALE_OPTIONS: {
  value: GlobeRenderScale;
  labelKey: string;
  fallbackLabel: string;
}[] = [
  { value: 'auto', labelKey: 'components.insights.globeRenderScaleOptions.auto', fallbackLabel: 'Auto (device)' },
  { value: '1', labelKey: 'components.insights.globeRenderScaleOptions.1', fallbackLabel: 'Eco (1x)' },
  { value: '1.5', labelKey: 'components.insights.globeRenderScaleOptions.1_5', fallbackLabel: 'Sharp (1.5x)' },
  { value: '2', labelKey: 'components.insights.globeRenderScaleOptions.2', fallbackLabel: '4K (2x)' },
  { value: '3', labelKey: 'components.insights.globeRenderScaleOptions.3', fallbackLabel: 'Insane (3x)' },
];

export function getGlobeRenderScale(): GlobeRenderScale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && ['auto', '1', '1.5', '2', '3'].includes(raw)) return raw as GlobeRenderScale;
  } catch {
    // ignore
  }
  return 'auto';
}

export function setGlobeRenderScale(scale: GlobeRenderScale): void {
  try {
    localStorage.setItem(STORAGE_KEY, scale);
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { scale } }));
}

export function subscribeGlobeRenderScaleChange(cb: (scale: GlobeRenderScale) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { scale?: GlobeRenderScale } | undefined;
    cb(detail?.scale ?? getGlobeRenderScale());
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

export function resolveGlobePixelRatio(scale: GlobeRenderScale): number {
  const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  if (scale === 'auto') return Math.min(2, Math.max(1, dpr));
  const num = Number(scale);
  if (!Number.isFinite(num) || num <= 0) return 1;
  return Math.min(3, Math.max(1, num));
}
