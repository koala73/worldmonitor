export function formatTime(date: Date): string {
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
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
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
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

export function saveToStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn(`Failed to save ${key} to storage:`, e);
  }
}

export function generateId(): string {
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export { proxyUrl, fetchWithProxy } from './proxy';
export { exportToJSON, exportToCSV, ExportPanel } from './export';
export { buildMapUrl, parseMapUrlState } from './urlState';
export type { ParsedMapUrlState } from './urlState';
export { CircuitBreaker, createCircuitBreaker, getCircuitBreakerStatus, getCircuitBreakerCooldownInfo } from './circuit-breaker';
export type { CircuitBreakerOptions } from './circuit-breaker';
