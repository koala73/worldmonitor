import { markLcpDebug, type LcpMarkSnapshot } from '@/utils/lcp-debug';
import { sanitizeWebVitalUrl } from '@/bootstrap/web-vitals-utils';

type LcpElementSnapshot = {
  className: string;
  closest: string;
  id: string;
  selector: string;
  tagName: string;
  // Redacted by default ('') — the LCP element's textContent can hold user/PII
  // content. Populated only when the explicit wm_lcp_text flag is set. Use
  // textLength to see whether the candidate was a text node without exposing it.
  text: string;
  textLength: number;
};

type LcpResourceGroup = {
  category: string;
  count: number;
  encodedBodySize: number;
  transferSize: number;
  largest?: {
    duration: number;
    initiatorType: string;
    name: string;
    startTime: number;
    transferSize: number;
  };
};

type LcpContextSnapshot = {
  devicePixelRatio: number;
  theme: string;
  variant: string;
  viewport: {
    height: number;
    width: number;
  };
  visibilityState: string;
};

type LcpEntrySnapshot = {
  context: LcpContextSnapshot;
  element: LcpElementSnapshot | null;
  loadTime: number;
  renderTime: number;
  resources: LcpResourceGroup[];
  size: number;
  startTime: number;
  url: string;
};

export type WmLcpDebugState = {
  enabled: true;
  entries: LcpEntrySnapshot[];
  getSnapshot: () => {
    context: LcpContextSnapshot;
    entries: LcpEntrySnapshot[];
    marks: LcpMarkSnapshot[];
    resources: LcpResourceGroup[];
  };
  marks: LcpMarkSnapshot[];
  observerInstalled: boolean;
};

declare global {
  interface Window {
    __wmLcpDebug?: WmLcpDebugState;
  }
}

const DEBUG_QUERY_PARAM = 'wm_lcp_debug';
const DEBUG_STORAGE_KEYS = ['wm_lcp_debug', 'wm-lcp-debug'];
// Raw LCP element text is opt-in via a SEPARATE, louder flag. The LCP element is
// frequently a content block (a headline, a personalized greeting, a selected
// place name), so its textContent can hold user/PII content. Attribution only
// needs structure (tag/selector/closest/size), so by default we capture the
// text *length* and leave the text itself redacted. (#4512 review)
const DEBUG_TEXT_QUERY_PARAM = 'wm_lcp_text';
const DEBUG_TEXT_STORAGE_KEYS = ['wm_lcp_text', 'wm-lcp-text'];
const MAX_ENTRIES = 20;
const MAX_RESOURCE_GROUPS = 12;
const MAX_TEXT_LENGTH = 140;

type LcpPerformanceEntry = PerformanceEntry & {
  element?: Element;
  loadTime?: number;
  renderTime?: number;
  size?: number;
  url?: string;
};

function capText(value: string, maxLength = MAX_TEXT_LENGTH): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function getWindowStorage(kind: 'localStorage' | 'sessionStorage'): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window[kind];
  } catch {
    return undefined;
  }
}

function getStorageFlag(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function isTruthyDebugFlag(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function isFlagEnabled(queryParam: string, storageKeys: string[]): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URL(window.location.href).searchParams;
    if (isTruthyDebugFlag(params.get(queryParam))) return true;
  } catch {
    // Ignore URL parsing failures in unusual embedded runtimes.
  }

  const sessionStorage = getWindowStorage('sessionStorage');
  const localStorage = getWindowStorage('localStorage');
  for (const key of storageKeys) {
    if (
      isTruthyDebugFlag(getStorageFlag(sessionStorage, key))
      || isTruthyDebugFlag(getStorageFlag(localStorage, key))
    ) {
      return true;
    }
  }
  return false;
}

function isLcpDebugEnabled(): boolean {
  return isFlagEnabled(DEBUG_QUERY_PARAM, DEBUG_STORAGE_KEYS);
}

function isLcpTextCaptureEnabled(): boolean {
  return isFlagEnabled(DEBUG_TEXT_QUERY_PARAM, DEBUG_TEXT_STORAGE_KEYS);
}

function getClassName(element: Element): string {
  const className = element.className;
  if (typeof className === 'string') return className;
  if (className && typeof className === 'object' && 'baseVal' in className) {
    return String((className as SVGAnimatedString).baseVal ?? '');
  }
  return '';
}

function escapeClassName(name: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(name);
  }
  return name.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function buildSelector(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const classes = getClassName(element)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((name) => `.${escapeClassName(name)}`)
    .join('');
  return `${tag}${id}${classes}`.slice(0, 180);
}

function closestAttributionLabel(element: Element): string {
  const panel = element.closest<HTMLElement>('[data-panel-id]');
  if (panel?.dataset.panelId) return `panel:${panel.dataset.panelId}`;
  if (element.closest('[data-shell-lcp]')) return 'shell-lcp';
  if (element.closest('.skeleton-shell')) return 'shell';
  if (element.closest('#mapContainer')) return 'map-container';
  if (element.closest('#mapSection')) return 'map-section';
  if (element.closest('.map-renderer-shell')) return 'map-renderer-shell';
  if (element.closest('.panel')) return 'panel';
  return '';
}

function snapshotElement(element: Element | undefined): LcpElementSnapshot | null {
  if (!element) return null;
  const rawText = capText(element.textContent ?? '');
  return {
    className: capText(getClassName(element), 240),
    closest: closestAttributionLabel(element),
    id: element.id,
    selector: buildSelector(element),
    tagName: element.tagName.toLowerCase(),
    text: isLcpTextCaptureEnabled() ? rawText : '',
    textLength: rawText.length,
  };
}

function classifyCriticalResource(name: string, initiatorType: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('/api/bootstrap')) return 'bootstrap';
  if (lower.includes('/api/news/v1/list-feed-digest')) return 'feed-digest';
  if (lower.includes('/data/countries.geojson')) return 'country-geometry';
  if (lower.includes('/data/countries-50m.json') || lower.includes('/data/countries-110m.json')) return 'map-topology';
  if (
    lower.includes('mapcontainer')
    || lower.includes('deckglmap')
    || lower.includes('globemap')
    || lower.includes('maplibre')
    || lower.includes('deck-stack')
    || lower.includes('protomaps')
  ) {
    return 'map-chunk';
  }
  if (lower.includes('sentry') || lower.includes('clerk') || lower.includes('vercel') || lower.includes('analytics')) {
    return 'secondary-startup';
  }
  if (initiatorType === 'script' || lower.endsWith('.js')) return 'script';
  if (initiatorType === 'css' || lower.endsWith('.css')) return 'style';
  if (lower.includes('/api/')) return 'api';
  if (lower.includes('/assets/') || lower.includes('/data/')) return 'static';
  return 'other';
}

function summarizeCriticalResources(upToStartTime = Number.POSITIVE_INFINITY): LcpResourceGroup[] {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return [];
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const groups = new Map<string, LcpResourceGroup>();

  for (const resource of resources) {
    if (resource.startTime > upToStartTime + 1) continue;
    const category = classifyCriticalResource(resource.name, resource.initiatorType);
    if (category === 'other') continue;
    const group = groups.get(category) ?? {
      category,
      count: 0,
      encodedBodySize: 0,
      transferSize: 0,
    };
    const transferSize = Math.max(0, resource.transferSize || 0);
    group.count += 1;
    group.encodedBodySize += Math.max(0, resource.encodedBodySize || 0);
    group.transferSize += transferSize;
    if (!group.largest || transferSize > group.largest.transferSize) {
      group.largest = {
        duration: Math.round(resource.duration),
        initiatorType: resource.initiatorType,
        name: sanitizeWebVitalUrl(resource.name),
        startTime: Math.round(resource.startTime),
        transferSize,
      };
    }
    groups.set(category, group);
  }

  return Array.from(groups.values())
    .sort((a, b) => b.transferSize - a.transferSize || b.encodedBodySize - a.encodedBodySize || a.category.localeCompare(b.category))
    .slice(0, MAX_RESOURCE_GROUPS);
}

function snapshotContext(): LcpContextSnapshot {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  return {
    devicePixelRatio: Math.round((typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1) * 100) / 100,
    theme: root?.dataset.theme ?? '',
    variant: root?.dataset.variant ?? '',
    viewport: {
      height: Math.round(typeof window !== 'undefined' ? window.innerHeight || root?.clientHeight || 0 : root?.clientHeight || 0),
      width: Math.round(typeof window !== 'undefined' ? window.innerWidth || root?.clientWidth || 0 : root?.clientWidth || 0),
    },
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : '',
  };
}

function getOrCreateDebugState(): WmLcpDebugState {
  const existing = window.__wmLcpDebug;
  if (existing?.enabled) return existing;

  const state: WmLcpDebugState = {
    enabled: true,
    entries: [],
    getSnapshot: () => ({
      context: snapshotContext(),
      entries: state.entries.slice(),
      marks: state.marks.slice(),
      resources: summarizeCriticalResources(),
    }),
    marks: [],
    observerInstalled: false,
  };
  window.__wmLcpDebug = state;
  return state;
}

function pushCapped<T>(items: T[], item: T, cap: number): void {
  items.push(item);
  if (items.length > cap) items.splice(0, items.length - cap);
}

function recordLcpEntry(entry: LcpPerformanceEntry): void {
  const state = window.__wmLcpDebug;
  if (!state?.enabled) return;
  pushCapped(state.entries, {
    context: snapshotContext(),
    element: snapshotElement(entry.element),
    loadTime: Math.round(entry.loadTime ?? 0),
    renderTime: Math.round(entry.renderTime ?? 0),
    resources: summarizeCriticalResources(entry.startTime),
    size: Math.round(entry.size ?? 0),
    startTime: Math.round(entry.startTime),
    url: sanitizeWebVitalUrl(entry.url),
  }, MAX_ENTRIES);
}

export function installLcpAttributionDebug(): void {
  if (typeof window === 'undefined' || !isLcpDebugEnabled()) return;
  const state = getOrCreateDebugState();
  if (state.observerInstalled) return;
  state.observerInstalled = true;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordLcpEntry(entry as LcpPerformanceEntry);
      }
    });
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    markLcpDebug('wm:lcp-debug:observer-unavailable');
  }

  document.addEventListener('visibilitychange', () => {
    markLcpDebug(`wm:visibility:${document.visibilityState}`);
  }, { passive: true });
  window.addEventListener('pagehide', () => {
    markLcpDebug('wm:pagehide');
  }, { passive: true });

  markLcpDebug('wm:lcp-debug:installed');
}

export const __testing__ = {
  capText,
  classifyCriticalResource,
  isLcpDebugEnabled,
  isLcpTextCaptureEnabled,
  isTruthyDebugFlag,
  sanitizeResourceUrl: sanitizeWebVitalUrl,
  snapshotContext,
};
