export interface TelegramWatchlistEntry {
  username: string;
  title?: string;
}

const STORAGE_KEY = 'telegram:watchlist:v1';
export const TELEGRAM_WATCHLIST_EVENT = 'wm-telegram-watchlist-changed';
export const TELEGRAM_WATCHLIST_MAX_ENTRIES = 20;
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function normalizeTelegramUsername(raw: string): string {
  let value = (raw || '').trim();
  if (!value) return '';

  value = value
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@+/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .trim();

  if (!USERNAME_RE.test(value)) return '';
  return value.toLowerCase();
}

function normalizeTitle(raw: string | undefined): string | undefined {
  const value = (raw || '').trim();
  return value ? value : undefined;
}

function coerceEntry(value: unknown): TelegramWatchlistEntry | null {
  if (typeof value === 'string') {
    const username = normalizeTelegramUsername(value);
    return username ? { username } : null;
  }

  if (!value || typeof value !== 'object') return null;

  const entry = value as Record<string, unknown>;
  const username = normalizeTelegramUsername(String(entry.username || ''));
  if (!username) return null;

  const title = normalizeTitle(typeof entry.title === 'string' ? entry.title : undefined);
  return { username, ...(title ? { title } : {}) };
}

function normalizeEntries(values: unknown[]): TelegramWatchlistEntry[] {
  const seen = new Set<string>();
  const entries: TelegramWatchlistEntry[] = [];

  for (const value of values) {
    const entry = coerceEntry(value);
    if (!entry || seen.has(entry.username)) continue;
    seen.add(entry.username);
    entries.push(entry);
    if (entries.length >= TELEGRAM_WATCHLIST_MAX_ENTRIES) break;
  }

  return entries;
}

function dispatch(entries: TelegramWatchlistEntry[]): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TELEGRAM_WATCHLIST_EVENT, { detail: { entries } }));
}

export function getTelegramWatchlistEntries(): TelegramWatchlistEntry[] {
  try {
    const parsed = safeParseJson<unknown>(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(parsed)) return [];

    return normalizeEntries(parsed);
  } catch {
    return [];
  }
}

export function setTelegramWatchlistEntries(entries: TelegramWatchlistEntry[]): TelegramWatchlistEntry[] {
  const next = normalizeEntries(entries || []);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    throw new Error('Telegram watchlist could not be saved');
  }

  dispatch(next);
  return next;
}

export function addTelegramWatchlistEntry(entry: TelegramWatchlistEntry): TelegramWatchlistEntry[] {
  const normalized = coerceEntry(entry);
  if (!normalized) return getTelegramWatchlistEntries();

  const current = getTelegramWatchlistEntries();
  const existing = current.findIndex(item => item.username === normalized.username);
  if (existing >= 0) {
    const existingEntry = current[existing];
    if (!existingEntry) return current;
    current[existing] = normalized.title
      ? { username: existingEntry.username, title: normalized.title }
      : existingEntry;
    return setTelegramWatchlistEntries(current);
  }

  // normalizeEntries truncates at the cap, and the appended entry is exactly
  // the one it drops — so without this guard the add silently no-ops while
  // returning normally and dispatching a change event. The panel guards the cap
  // before calling, but the store must not depend on one caller doing that.
  if (current.length >= TELEGRAM_WATCHLIST_MAX_ENTRIES) return current;

  return setTelegramWatchlistEntries([...current, normalized]);
}

export function removeTelegramWatchlistEntry(username: string): TelegramWatchlistEntry[] {
  const normalized = normalizeTelegramUsername(username);
  const next = getTelegramWatchlistEntries().filter(entry => entry.username !== normalized);
  return setTelegramWatchlistEntries(next);
}

export function subscribeTelegramWatchlistChange(cb: (entries: TelegramWatchlistEntry[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail as { entries?: unknown } | undefined;
    if (!Array.isArray(detail?.entries)) {
      cb(getTelegramWatchlistEntries());
      return;
    }

    cb(normalizeEntries(detail.entries));
  };
  const storageHandler = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    cb(getTelegramWatchlistEntries());
  };

  window.addEventListener(TELEGRAM_WATCHLIST_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(TELEGRAM_WATCHLIST_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}
