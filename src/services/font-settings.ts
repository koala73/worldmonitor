import { saveToStorage, loadFromStorage } from '@/utils';

export type FontFamily = 'system' | 'inter' | 'roboto-mono' | 'geist';

const STORAGE_KEY = 'worldmonitor-font-family';

export function getFontFamily(): FontFamily {
  return loadFromStorage<FontFamily>(STORAGE_KEY, 'system');
}

export function setFontFamily(font: FontFamily): void {
  saveToStorage(STORAGE_KEY, font);
  applyFontFamily(font);
}

export function applyFontFamily(font: FontFamily): void {
  document.documentElement.setAttribute('data-font', font);
  
  // Update CSS variable based on font
  const root = document.documentElement;
  switch (font) {
    case 'inter':
      root.style.setProperty('--font-body', "'Inter', var(--font-fallback-sans)");
      break;
    case 'roboto-mono':
      root.style.setProperty('--font-body', "'Roboto Mono', var(--font-fallback-mono)");
      break;
    case 'geist':
      root.style.setProperty('--font-body', "'Geist', var(--font-fallback-sans)");
      break;
    default:
      // system is handled by default CSS or reset
      root.style.removeProperty('--font-body');
      break;
  }
}
