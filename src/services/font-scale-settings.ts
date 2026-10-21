import type { PanelConfig } from '@/types';

export type FontScale = NonNullable<PanelConfig['fontScale']>;

export const FONT_SCALE_STEPS = [0.9, 1, 1.1, 1.25, 1.5, 2] as const satisfies readonly FontScale[];
export const DEFAULT_FONT_SCALE: FontScale = 1;
export const FONT_SCALE_STORAGE_KEY = 'wm-font-scale';
export const FONT_SCALE_CHANGED_EVENT = 'wm:font-scale-changed';

export interface FontScaleChangedDetail {
  scale: FontScale;
}

export function isFontScale(value: unknown): value is FontScale {
  return typeof value === 'number' && FONT_SCALE_STEPS.some(step => step === value);
}

export function parseFontScale(value: unknown): FontScale | undefined {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  return isFontScale(numeric) ? numeric : undefined;
}

export function normalizeFontScale(value: unknown): FontScale {
  return parseFontScale(value) ?? DEFAULT_FONT_SCALE;
}

export function getFontScale(): FontScale {
  try {
    return normalizeFontScale(localStorage.getItem(FONT_SCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}

export function applyFontScale(scale?: FontScale): void {
  if (typeof document === 'undefined') return;
  const resolved = scale ?? getFontScale();
  if (document.documentElement.style.getPropertyValue('--wm-font-scale') === String(resolved)) return;
  document.documentElement.style.setProperty('--wm-font-scale', String(resolved));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<FontScaleChangedDetail>(FONT_SCALE_CHANGED_EVENT, {
      detail: { scale: resolved },
    }));
  }
}

export function setFontScale(scale: FontScale): void {
  const safe = normalizeFontScale(scale);
  try {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(safe));
  } catch {
    // Storage can be unavailable in private mode. Keep the live preference.
  }
  applyFontScale(safe);
}

export function applyPanelFontScale(element: HTMLElement, panelScale: FontScale | undefined): void {
  if (isFontScale(panelScale)) {
    const next = String(panelScale);
    if (element.style.getPropertyValue('--wm-panel-font-scale') !== next) {
      element.style.setProperty('--wm-panel-font-scale', next);
    }
    return;
  }
  if (element.style.getPropertyValue('--wm-panel-font-scale')) {
    element.style.removeProperty('--wm-panel-font-scale');
  }
}

export function fontScaleLabel(scale: FontScale): string {
  return `${Math.round(scale * 100)}%`;
}
