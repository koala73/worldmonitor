/**
 * Headline auto-translation with a local per-headline cache.
 *
 * Sits on top of translateTexts() (SummarizeArticle mode='translate', which
 * the server serves per-headline from Redis and only LLM-translates misses).
 * This layer adds what panels need to translate whole feeds cheaply:
 *   - an in-memory + localStorage cache with a SYNC getter, so render paths
 *     can substitute translations inline (works with windowed/virtual lists)
 *     and re-renders/reloads cost zero RPCs
 *   - chunking (server accepts up to 10 headlines per request)
 *   - a global sequential queue so a cold dashboard with many news panels
 *     paces itself under the 30/min endpoint rate limit instead of bursting
 *   - in-flight dedup so overlapping panels don't double-translate
 *   - a short cooldown after total failure so a dead provider chain doesn't
 *     get re-hammered on every feed refresh
 */

import { hashString } from '@/utils/hash';
import { translateTextsInBrowser } from './browser-translator';
import { translateTexts } from './summarization';

const STORE_KEY = 'wm-headline-translations-v1';
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 800;
const CHUNK_SIZE = 10;
const FAILURE_COOLDOWN_MS = 60 * 1000;

interface StoreEntry {
  /** translated text */
  t: string;
  /** last-used timestamp (refreshed on read → LRU eviction) */
  ts: number;
}

type Store = Record<string, StoreEntry>;

let memCache: Store | null = null;
let lastTotalFailureTs = 0;
/** headline-hash → resolves when the chunk containing it settles */
const inFlight = new Map<string, Promise<void>>();
/** serializes chunk RPCs across all panels */
let queueTail: Promise<void> = Promise.resolve();

function entryKey(text: string, lang: string): string {
  return hashString(`${lang}:${text}`);
}

function getStore(): Store {
  if (memCache) return memCache;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    memCache = parsed && typeof parsed === 'object' ? parsed as Store : {};
  } catch {
    memCache = {};
  }
  return memCache;
}

function persistStore(): void {
  const store = getStore();
  try {
    const now = Date.now();
    let entries = Object.entries(store).filter(([, v]) =>
      v && typeof v.t === 'string' && typeof v.ts === 'number' && now - v.ts < ENTRY_TTL_MS);
    if (entries.length > MAX_ENTRIES) {
      entries = entries.sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX_ENTRIES);
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota / private browsing — translations just won't persist.
  }
}

function readEntry(text: string, lang: string): string | null {
  const store = getStore();
  const entry = store[entryKey(text, lang)];
  if (!entry || typeof entry.t !== 'string' || typeof entry.ts !== 'number') return null;
  if (Date.now() - entry.ts >= ENTRY_TTL_MS) return null;
  return entry.t;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function translateChunk(texts: string[], lang: string): Promise<void> {
  // Zero-setup path first: the browser's built-in on-device translator
  // (Chromium). Free and local, so it beats the server LLM chain whenever
  // the language pack is available; otherwise fall back to the server.
  let results = await translateTextsInBrowser(texts, lang);
  if (!results || !results.some((r) => r && r.trim().length > 0)) {
    results = await translateTexts(texts, lang);
  }
  if (!results.some((r) => r && r.trim().length > 0)) {
    lastTotalFailureTs = Date.now();
    return;
  }
  const store = getStore();
  const now = Date.now();
  for (const [i, text] of texts.entries()) {
    const translated = results[i]?.trim();
    if (!translated) continue;
    store[entryKey(text, lang)] = { t: translated, ts: now };
  }
  persistStore();
}

/**
 * Synchronous cache-only lookup for render paths. Refreshes the entry's
 * LRU timestamp in memory (persisted on the next write).
 */
export function getCachedHeadlineTranslation(text: string, lang: string): string | null {
  if (!lang || lang === 'en') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const translated = readEntry(trimmed, lang);
  if (translated !== null) {
    const entry = getStore()[entryKey(trimmed, lang)];
    if (entry) entry.ts = Date.now();
  }
  return translated;
}

/**
 * Translate headlines into `lang`, serving from cache where possible.
 * Returns a map of original → translated containing only the headlines that
 * have a translation (callers keep the original text for the rest).
 * Failures are silent — auto-translation must never break feed rendering.
 */
export async function translateHeadlines(
  texts: string[],
  lang: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!lang || lang === 'en') return result;

  const wanted = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
  if (wanted.length === 0) return result;

  const misses: string[] = [];
  const waits: Promise<void>[] = [];

  for (const text of wanted) {
    const cached = getCachedHeadlineTranslation(text, lang);
    if (cached !== null) {
      result.set(text, cached);
      continue;
    }
    const pending = inFlight.get(entryKey(text, lang));
    if (pending) {
      waits.push(pending);
    } else {
      misses.push(text);
    }
  }

  if (misses.length > 0 && Date.now() - lastTotalFailureTs > FAILURE_COOLDOWN_MS) {
    for (const group of chunk(misses, CHUNK_SIZE)) {
      const run = queueTail.then(() => translateChunk(group, lang)).catch(() => {
        lastTotalFailureTs = Date.now();
      });
      queueTail = run;
      for (const text of group) {
        const key = entryKey(text, lang);
        inFlight.set(key, run);
        void run.finally(() => {
          if (inFlight.get(key) === run) inFlight.delete(key);
        });
      }
      waits.push(run);
    }
  }

  if (waits.length > 0) {
    await Promise.all(waits);
    // Chunk completions (ours and other panels') have landed in the store.
    for (const text of wanted) {
      if (result.has(text)) continue;
      const translated = readEntry(text, lang);
      if (translated !== null) result.set(text, translated);
    }
  }

  return result;
}
