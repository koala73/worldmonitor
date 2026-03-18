export function formatTime(date: Date): string {
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  const lang = getCurrentLanguage();

  // Safe fallback if Intl is not available (though it is in all modern browsers)
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });

    if (diff < 60) return rtf.format(-Math.round(diff), 'second');
    if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
    if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
    return rtf.format(-Math.round(diff / 86400), 'day');
  } catch (e) {
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
}

export function formatPrice(price: number): string {
  if (price >= 1000) {
    return `$${price.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  }
  return `$${price.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatChange(change: number): string {
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

export function getChangeClass(change: number): string {
  return change >= 0 ? 'up' : 'down';
}

export function getHeatmapClass(change: number): string {
  const abs = Math.abs(change);
  const direction = change >= 0 ? 'up' : 'down';

  if (abs >= 2) return `${direction}-3`;
  if (abs >= 1) return `${direction}-2`;
  return `${direction}-1`;
}

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) & { cancel(): void } {
  let timeoutId: ReturnType<typeof setTimeout>;
  const debounced = (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => { clearTimeout(timeoutId); };
  return debounced;
}

export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  // Time-based throttling for non-visual work where a fixed minimum interval is desired.
  let inThrottle = false;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => { inThrottle = false; }, limit);
    }
  };
}

export function rafSchedule<T extends (...args: unknown[]) => void>(fn: T): ((...args: Parameters<T>) => void) & { cancel(): void } {
  // Frame-synchronized scheduling for visual updates; batches repeated calls into one render frame.
  let scheduled = false;
  let rafId = 0;
  let lastArgs: Parameters<T> | null = null;
  const wrapped = (...args: Parameters<T>) => {
    lastArgs = args;
    if (!scheduled) {
      scheduled = true;
      rafId = requestAnimationFrame(() => {
        scheduled = false;
        if (lastArgs) {
          fn(...lastArgs);
          lastArgs = null;
        }
      });
    }
  };
  wrapped.cancel = () => {
    cancelAnimationFrame(rafId);
    scheduled = false;
    lastArgs = null;
  };
  return wrapped;
}

export function loadFromStorage<T>(key: string, defaultValue: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as T;
      // Merge with defaults for object types to handle new properties
      if (typeof defaultValue === 'object' && defaultValue !== null && !Array.isArray(defaultValue)) {
        return { ...defaultValue, ...parsed };
      }
      return parsed;
    }
  } catch (e) {
    console.warn(`Failed to load ${key} from storage:`, e);
  }
  return defaultValue;
}

let _storageQuotaExceeded = false;

export function isStorageQuotaExceeded(): boolean {
  return _storageQuotaExceeded;
}

export function isQuotaError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
}

export function markStorageQuotaExceeded(): void {
  if (!_storageQuotaExceeded) {
    _storageQuotaExceeded = true;
    console.warn('[Storage] Quota exceeded — disabling further writes');
  }
}

export function saveToStorage<T>(key: string, value: T): void {
  if (_storageQuotaExceeded) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    if (isQuotaError(e)) {
      markStorageQuotaExceeded();
    } else {
      console.warn(`Failed to save ${key} to storage:`, e);
    }
  }
}

export function generateId(): string {
  return `id-${crypto.randomUUID()}`;
}

/** Breakpoint (px): below this width the app uses the simplified mobile layout. Must match CSS @media (max-width: …). */
export const MOBILE_BREAKPOINT_PX = 768;

/** True when viewport is below mobile breakpoint. Touch-capable notebooks keep desktop layout. */
export function isMobileDevice(): boolean {
  return window.innerWidth <= MOBILE_BREAKPOINT_PX;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export function toUniqueSorted(items: string[]): string[] {
  return Array.from(new Set(items)).sort();
}

export function toUniqueSortedLowercase(items: string[]): string[] {
  return toUniqueSorted(items.map((item) => item.toLowerCase()));
}

export { proxyUrl, fetchWithProxy, rssProxyUrl } from './proxy';
export { exportToJSON, exportToCSV, ExportPanel } from './export';
export { buildMapUrl, parseMapUrlState } from './urlState';
export type { ParsedMapUrlState } from './urlState';
export { CircuitBreaker, createCircuitBreaker, getCircuitBreakerStatus, getCircuitBreakerCooldownInfo } from './circuit-breaker';
export type { CircuitBreakerOptions } from './circuit-breaker';
export * from './analysis-constants';
export { getCSSColor, invalidateColorCache } from './theme-colors';
export { getStoredTheme, getCurrentTheme, setTheme, applyStoredTheme, getThemePreference, setThemePreference } from './theme-manager';
export type { Theme, ThemePreference } from './theme-manager';
export { toFlagEmoji } from './country-flag';

import { getCurrentLanguage } from '../services/i18n';
