const CACHE_PREFIX = 'wm-content-translation:v1';
const STORAGE_PREFIX = `${CACHE_PREFIX}:`;
const MAX_STORED_TRANSLATIONS = 500;

const memoryCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

interface CachedTranslationEntry {
  source: string;
  translated: string;
  savedAt?: number;
}

function normalizeLanguage(language: string): string {
  return String(language || '').trim().toLowerCase().split('-')[0] || '';
}

function normalizeText(text: string): string {
  return String(text || '').trim();
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function memoryKey(text: string, targetLang: string): string {
  return `${normalizeLanguage(targetLang)}\u0000${normalizeText(text)}`;
}

function storageKey(text: string, targetLang: string): string {
  const normalizedText = normalizeText(text);
  const normalizedLang = normalizeLanguage(targetLang);
  return `${STORAGE_PREFIX}${normalizedLang}:${hashText(normalizedText)}:${normalizedText.length}`;
}

function removeStorageKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage cleanup failures.
  }
}

function readStoredEntry(key: string): CachedTranslationEntry | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CachedTranslationEntry;
    if (typeof parsed?.source !== 'string' || typeof parsed.translated !== 'string') {
      removeStorageKey(key);
      return undefined;
    }
    if (parsed.savedAt !== undefined && !Number.isFinite(parsed.savedAt)) {
      removeStorageKey(key);
      return undefined;
    }
    return parsed;
  } catch {
    removeStorageKey(key);
    return undefined;
  }
}

function trimStoredTranslations(maxEntries = MAX_STORED_TRANSLATIONS): void {
  try {
    const entries: Array<{ key: string; savedAt: number }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const entry = readStoredEntry(key);
      if (!entry) continue;
      entries.push({ key, savedAt: Number.isFinite(entry.savedAt) ? entry.savedAt ?? 0 : 0 });
    }

    if (entries.length <= maxEntries) return;

    entries
      .sort((a, b) => b.savedAt - a.savedAt || a.key.localeCompare(b.key))
      .slice(maxEntries)
      .forEach((entry) => removeStorageKey(entry.key));
  } catch {
    // Ignore localStorage iteration failures and keep in-memory cache hot.
  }
}

function readStoredTranslation(text: string, targetLang: string): string | undefined {
  const key = storageKey(text, targetLang);
  const normalizedText = normalizeText(text);
  try {
    const parsed = readStoredEntry(key);
    if (!parsed) return undefined;
    if (parsed.source !== normalizedText) {
      removeStorageKey(key);
      return undefined;
    }
    return parsed.translated;
  } catch {
    return undefined;
  }
}

function persistTranslation(text: string, targetLang: string, translated: string): void {
  try {
    const normalizedText = normalizeText(text);
    localStorage.setItem(storageKey(normalizedText, targetLang), JSON.stringify({
      source: normalizedText,
      translated,
      savedAt: Date.now(),
    } satisfies CachedTranslationEntry));
    trimStoredTranslations();
  } catch {
    // Ignore storage failures and keep the in-memory cache hot.
  }
}

export function shouldTranslateContent(targetLang: string, sourceLang?: string): boolean {
  const normalizedTarget = normalizeLanguage(targetLang);
  if (!normalizedTarget || normalizedTarget === 'en') return false;
  const normalizedSource = normalizeLanguage(sourceLang || '');
  return !normalizedSource || normalizedSource !== normalizedTarget;
}

export function getCachedContentTranslation(text: string, targetLang: string): string | undefined {
  const normalizedText = normalizeText(text);
  const normalizedLang = normalizeLanguage(targetLang);
  if (!normalizedText || !normalizedLang) return undefined;

  const key = memoryKey(normalizedText, normalizedLang);
  const memoryHit = memoryCache.get(key);
  if (memoryHit !== undefined) return memoryHit;

  const stored = readStoredTranslation(normalizedText, normalizedLang);
  if (stored === undefined) return undefined;

  memoryCache.set(key, stored);
  return stored;
}

export async function translateContentText(
  text: string,
  targetLang: string,
  options?: {
    sourceLang?: string;
    translator?: (input: string, lang: string) => Promise<string | null>;
  },
): Promise<string | null> {
  const normalizedText = normalizeText(text);
  const normalizedLang = normalizeLanguage(targetLang);

  if (!normalizedText) return null;
  if (!shouldTranslateContent(normalizedLang, options?.sourceLang)) return normalizedText;

  const cached = getCachedContentTranslation(normalizedText, normalizedLang);
  if (cached !== undefined) return cached;

  const key = memoryKey(normalizedText, normalizedLang);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const translator = options?.translator ?? (await import('./summarization')).translateText;
  const request = (async () => {
    const translated = await translator(normalizedText, normalizedLang);
    const normalizedTranslated = normalizeText(translated || '');
    if (!normalizedTranslated) return null;
    memoryCache.set(key, normalizedTranslated);
    persistTranslation(normalizedText, normalizedLang, normalizedTranslated);
    return normalizedTranslated;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, request);
  return request;
}

export function resetContentTranslationCacheForTests(): void {
  memoryCache.clear();
  inFlight.clear();
}
