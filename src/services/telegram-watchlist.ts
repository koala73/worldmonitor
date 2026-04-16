export interface TelegramWatchlistEntry {
  username: string;
  title?: string;
}

const STORAGE_KEY = 'telegram:watchlist:v1';
export const TELEGRAM_WATCHLIST_EVENT = 'wm-telegram-watchlist-changed';
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
    .replace(/\/+$/, '')
    .replace(/[?#].*$/, '')
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

function dispatch(entries: TelegramWatchlistEntry[]): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TELEGRAM_WATCHLIST_EVENT, { detail: { entries } }));
}

export function getTelegramWatchlistEntries(): TelegramWatchlistEntry[] {
  try {
    const parsed = safeParseJson<unknown>(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(parsed)) return [];

    const entries: TelegramWatchlistEntry[] = [];
    for (const item of parsed) {
      const entry = coerceEntry(item);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

export function setTelegramWatchlistEntries(entries: TelegramWatchlistEntry[]): void {
  const seen = new Set<string>();
  const next: TelegramWatchlistEntry[] = [];

  for (const raw of entries || []) {
    const entry = coerceEntry(raw);
    if (!entry || seen.has(entry.username)) continue;
    seen.add(entry.username);
    next.push(entry);
    if (next.length >= 20) break;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota/storage failures
  }

  dispatch(next);
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
    setTelegramWatchlistEntries(current);
    return current;
  }

  const next = [...current, normalized];
  setTelegramWatchlistEntries(next);
  return next;
}

export function removeTelegramWatchlistEntry(username: string): TelegramWatchlistEntry[] {
  const normalized = normalizeTelegramUsername(username);
  const next = getTelegramWatchlistEntries().filter(entry => entry.username !== normalized);
  setTelegramWatchlistEntries(next);
  return next;
}

export function subscribeTelegramWatchlistChange(cb: (entries: TelegramWatchlistEntry[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail as { entries?: unknown } | undefined;
    if (!Array.isArray(detail?.entries)) {
      cb(getTelegramWatchlistEntries());
      return;
    }

    const entries: TelegramWatchlistEntry[] = [];
    for (const item of detail.entries) {
      const entry = coerceEntry(item);
      if (entry) entries.push(entry);
    }
    cb(entries);
  };

  window.addEventListener(TELEGRAM_WATCHLIST_EVENT, handler);
  return () => window.removeEventListener(TELEGRAM_WATCHLIST_EVENT, handler);
}
