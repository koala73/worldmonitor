export type FontFamily = 'mono' | 'system';

const STORAGE_KEY = 'wm-font-family';
const EVENT_NAME = 'wm-font-changed';

const ALLOWED: FontFamily[] = ['mono', 'system'];

const SYSTEM_FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

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
    document.documentElement.style.setProperty('--font-body', SYSTEM_FONT_STACK);
  } else {
    document.documentElement.style.removeProperty('--font-body');
  }
}

export function subscribeFontChange(cb: (font: FontFamily) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { font?: FontFamily } | undefined;
    cb(detail?.font ?? getFontFamily());
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
