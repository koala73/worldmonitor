const RETRY_AFTER_MIN_SEC = 1;
const RETRY_AFTER_MAX_SEC = 60;
const RETRY_AFTER_DEFAULT_SEC = 5;

export function isTemporaryCloudPrefsStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * Parse the `Retry-After` header per RFC 7231: either delta-seconds or an
 * HTTP-date. Returns a clamped number of seconds, with the configured
 * default for missing/malformed values.
 */
export function parseRetryAfterSeconds(headers: Headers): number {
  const raw = headers.get('Retry-After');
  if (!raw) return RETRY_AFTER_DEFAULT_SEC;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return RETRY_AFTER_DEFAULT_SEC;
    return Math.min(Math.max(n, RETRY_AFTER_MIN_SEC), RETRY_AFTER_MAX_SEC);
  }
  if (!/\b\d{4}\b/.test(trimmed) || !trimmed.includes(':')) return RETRY_AFTER_DEFAULT_SEC;
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return RETRY_AFTER_DEFAULT_SEC;
  const delta = Math.round((t - Date.now()) / 1000);
  return Math.min(Math.max(delta, RETRY_AFTER_MIN_SEC), RETRY_AFTER_MAX_SEC);
}

export interface TemporaryCloudPrefsRetryOptions {
  status: number;
  headers: Headers;
  myGeneration: number;
  getAuthGeneration: () => number;
  setPending: () => void;
  clearRetryTimer: () => void;
  setRetryTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  uploadNow: () => void | Promise<void>;
  setTimeoutFn?: typeof setTimeout;
}

export function rearmTemporaryCloudPrefsRetry(opts: TemporaryCloudPrefsRetryOptions): boolean {
  if (!isTemporaryCloudPrefsStatus(opts.status)) return false;

  const retryAfterSec = parseRetryAfterSeconds(opts.headers);
  if (opts.getAuthGeneration() !== opts.myGeneration) return true;

  opts.setPending();
  opts.clearRetryTimer();
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const timer = setTimeoutFn(() => {
    opts.setRetryTimer(null);
    if (opts.getAuthGeneration() !== opts.myGeneration) return;
    void opts.uploadNow();
  }, retryAfterSec * 1000);
  opts.setRetryTimer(timer);
  return true;
}
