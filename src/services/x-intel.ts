import { proxyUrl } from '@/utils';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

export interface XItem {
  id: string;
  source: 'x';
  account: string;
  accountTitle: string;
  url: string;
  ts: string;
  text: string;
  topic: string;
  tags: string[];
  earlySignal: boolean;
  hasMedia?: boolean;
  lang?: string;
  contentState?: string;
}

export interface XFeedResponse {
  source: string;
  earlySignal: boolean;
  enabled: boolean;
  count: number;
  updatedAt: string | null;
  lastHealthyAt?: string | null;
  degraded?: boolean;
  coverage?: {
    expected: number;
    polled: number;
    failed: number;
    attempted: number;
    complete: boolean;
  };
  items: XItem[];
}

export const X_TOPICS = [
  { id: 'all', labelKey: 'components.xIntel.filterAll' },
  { id: 'breaking', labelKey: 'components.xIntel.filterBreaking' },
  { id: 'conflict', labelKey: 'components.xIntel.filterConflict' },
  { id: 'geopolitics', labelKey: 'components.xIntel.filterGeopolitics' },
  { id: 'middleeast', labelKey: 'components.xIntel.filterMiddleeast' },
  { id: 'osint', labelKey: 'components.xIntel.filterOsint' },
  { id: 'cyber', labelKey: 'components.xIntel.filterCyber' },
] as const;

let cachedResponse: XFeedResponse | null = null;
let cachedAt = 0;
let cachedLimit = 0;
interface InFlightEntry {
  promise: Promise<XFeedResponse>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

const inFlight = new Map<number, InFlightEntry>();
const CACHE_TTL = 30_000;
export const X_HYDRATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MISSING_TIMESTAMP_ISO = new Date(0).toISOString();

function xFeedUrl(limit: number): string {
  const path = `/api/x-feed?limit=${limit}`;
  return isDesktopRuntime() ? proxyUrl(path) : toApiUrl(path);
}

export async function fetchXFeed(limit = 50, signal?: AbortSignal): Promise<XFeedResponse> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  if (cachedResponse && cachedLimit >= limit && Date.now() - cachedAt < CACHE_TTL) return cachedResponse;
  let entry = inFlight.get(limit);
  if (!entry) {
    const controller = new AbortController();
    const newEntry: InFlightEntry = {
      controller,
      subscribers: 0,
      settled: false,
      promise: undefined as unknown as Promise<XFeedResponse>,
    };
    newEntry.promise = (async () => {
      const res = await fetch(xFeedUrl(limit), { signal: controller.signal });
      if (!res.ok) throw new Error(`X feed ${res.status}`);

      const json: XFeedResponse = await res.json();
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
      cachedResponse = json;
      cachedAt = Date.now();
      cachedLimit = limit;
      return json;
    })().finally(() => {
      newEntry.settled = true;
      if (inFlight.get(limit) === newEntry) inFlight.delete(limit);
    });
    inFlight.set(limit, newEntry);
    entry = newEntry;
  }
  entry.subscribers += 1;
  return new Promise<XFeedResponse>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers === 0 && !entry.settled && inFlight.get(limit) === entry) {
        inFlight.delete(limit);
        entry.controller.abort();
      }
    };
    const onAbort = () => {
      release();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      release();
    };
    entry.promise.then(
      (value) => { finish(); resolve(value); },
      (error) => { finish(); reject(error); },
    );
  });
}

export function isUsableHydratedXFeed(response: XFeedResponse | undefined, now = Date.now()): boolean {
  if (!response || !Array.isArray(response.items)) return false;
  const updatedAt = Date.parse(response.updatedAt || '');
  return Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt <= X_HYDRATION_MAX_AGE_MS;
}

export function formatXTime(ts: string): string {
  const time = new Date(ts).getTime();
  if (!Number.isFinite(time) || ts === MISSING_TIMESTAMP_ISO) return 'unknown';

  const diff = Date.now() - time;
  if (diff < 0) return 'now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
