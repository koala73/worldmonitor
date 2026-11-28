export type FontFamily = 'mono' | 'system';

const STORAGE_KEY = 'wm-font-family';
const EVENT_NAME = 'wm-font-changed';

const ALLOWED: FontFamily[] = ['mono', 'system'];

export function getFontFamily(): FontFamily {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && ALLOWED.includes(raw as FontFamily)) return raw as FontFamily;
  } catch {
    // ignore
  }
  return 'mono';
}

export function setFontFamily(font: FontFamily): void {
  const safe = ALLOWED.includes(font) ? font : 'mono';
  try {
    localStorage.setItem(STORAGE_KEY, safe);
  } catch {
    // ignore
  }
  applyFont(safe);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { font: safe } }));
}

export function applyFont(font?: FontFamily): void {
  const resolved = font ?? getFontFamily();
  if (resolved === 'system') {
    document.documentElement.dataset.font = 'system';
  } else {
    delete document.documentElement.dataset.font;
  }
}
