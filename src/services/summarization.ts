/**
 * Summarization Service with Fallback Chain
 * Server-side Redis caching handles cross-user deduplication
 * Fallback: AI4U primary model -> AI4U fallback model -> Browser T5
 */

import { mlWorker } from './ml-worker';
import { SITE_VARIANT } from '@/config';
import { BETA_MODE } from '@/config/beta';
import { isFeatureAvailable } from './runtime-config';

export type SummarizationProvider = 'ai4u' | 'browser' | 'cache';

export interface SummarizationResult {
  summary: string;
  provider: SummarizationProvider;
  cached: boolean;
}

const TRANSLATION_CACHE_PREFIX = 'wm-translation-v1';
const TRANSLATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const translationMemoryCache = new Map<string, { value: string; expiresAt: number }>();
const translationPending = new Map<string, Promise<string | null>>();

function hashTranslationText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function getTranslationCacheKey(text: string, targetLang: string): string {
  const normalizedText = text.trim();
  const normalizedLang = targetLang.trim().toLowerCase();
  return `${normalizedLang}:${normalizedText.length}:${hashTranslationText(normalizedText)}`;
}

function readCachedTranslation(key: string): string | null {
  const now = Date.now();
  const mem = translationMemoryCache.get(key);
  if (mem && mem.expiresAt > now) return mem.value;

  if (typeof window === 'undefined') return null;

  try {
    const raw = localStorage.getItem(`${TRANSLATION_CACHE_PREFIX}:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: string; expiresAt?: number };
    if (!parsed?.value || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now) {
      localStorage.removeItem(`${TRANSLATION_CACHE_PREFIX}:${key}`);
      return null;
    }
    translationMemoryCache.set(key, { value: parsed.value, expiresAt: parsed.expiresAt });
    return parsed.value;
  } catch {
    return null;
  }
}

function writeCachedTranslation(key: string, value: string): void {
  const expiresAt = Date.now() + TRANSLATION_CACHE_TTL_MS;
  translationMemoryCache.set(key, { value, expiresAt });

  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      `${TRANSLATION_CACHE_PREFIX}:${key}`,
      JSON.stringify({ value, expiresAt })
    );
  } catch {
    // ignore storage failures
  }
}

export type ProgressCallback = (step: number, total: number, message: string) => void;

async function tryGroq(headlines: string[], geoContext?: string, lang?: string): Promise<SummarizationResult | null> {
  if (!isFeatureAvailable('aiGroq')) return null;
  try {
    const response = await fetch('/api/groq-summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headlines, mode: 'brief', geoContext, variant: SITE_VARIANT, lang }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.fallback) return null;
      throw new Error(`AI4U primary error: ${response.status}`);
    }

    const data = await response.json();
    const provider = data.cached ? 'cache' : 'ai4u';
    console.log(`[Summarization] ${provider === 'cache' ? 'Redis cache hit' : 'AI4U primary success'}:`, data.model);
    return {
      summary: data.summary,
      provider: provider as SummarizationProvider,
      cached: !!data.cached,
    };
  } catch (error) {
    console.warn('[Summarization] AI4U primary failed:', error);
    return null;
  }
}

async function tryOpenRouter(headlines: string[], geoContext?: string, lang?: string): Promise<SummarizationResult | null> {
  if (!isFeatureAvailable('aiGroq')) return null;
  try {
    const response = await fetch('/api/openrouter-summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headlines, mode: 'brief', geoContext, variant: SITE_VARIANT, lang }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.fallback) return null;
      throw new Error(`AI4U fallback error: ${response.status}`);
    }

    const data = await response.json();
    const provider = data.cached ? 'cache' : 'ai4u';
    console.log(`[Summarization] ${provider === 'cache' ? 'Redis cache hit' : 'AI4U fallback success'}:`, data.model);
    return {
      summary: data.summary,
      provider: provider as SummarizationProvider,
      cached: !!data.cached,
    };
  } catch (error) {
    console.warn('[Summarization] AI4U fallback failed:', error);
    return null;
  }
}

async function tryBrowserT5(headlines: string[], modelId?: string): Promise<SummarizationResult | null> {
  try {
    if (!mlWorker.isAvailable) {
      console.log('[Summarization] Browser ML not available');
      return null;
    }

    const combinedText = headlines.slice(0, 6).map(h => h.slice(0, 80)).join('. ');
    const prompt = `Summarize the main themes from these news headlines in 2 sentences: ${combinedText}`;

    const [summary] = await mlWorker.summarize([prompt], modelId);

    if (!summary || summary.length < 20 || summary.toLowerCase().includes('summarize')) {
      return null;
    }

    console.log('[Summarization] Browser T5 success');
    return {
      summary,
      provider: 'browser',
      cached: false,
    };
  } catch (error) {
    console.warn('[Summarization] Browser T5 failed:', error);
    return null;
  }
}

/**
 * Generate a summary using fallback chain: AI4U primary -> AI4U fallback -> Browser T5
 * Server-side Redis caching is handled by the API endpoints
 * @param geoContext Optional geographic signal context to include in the prompt
 */
export async function generateSummary(
  headlines: string[],
  onProgress?: ProgressCallback,
  geoContext?: string,
  lang: string = 'en'
): Promise<SummarizationResult | null> {
  if (!headlines || headlines.length < 2) {
    return null;
  }

  if (BETA_MODE) {
    const modelReady = mlWorker.isAvailable && mlWorker.isModelLoaded('summarization-beta');

    if (modelReady) {
      const totalSteps = 3;
      // Model already loaded — use browser T5-small first
      onProgress?.(1, totalSteps, 'Running local AI model (beta)...');
      const browserResult = await tryBrowserT5(headlines, 'summarization-beta');
      if (browserResult) {
        console.log('[BETA] Browser T5-small:', browserResult.summary);
        tryGroq(headlines, geoContext).then(r => {
          if (r) console.log('[BETA] AI4U comparison:', r.summary);
        }).catch(() => {});
        return browserResult;
      }

      // Warm model failed inference — cloud fallback
      onProgress?.(2, totalSteps, 'Connecting to AI4U...');
      const groqResult = await tryGroq(headlines, geoContext);
      if (groqResult) return groqResult;

      onProgress?.(3, totalSteps, 'Trying AI4U fallback model...');
      const openRouterResult = await tryOpenRouter(headlines, geoContext);
      if (openRouterResult) return openRouterResult;
    } else {
      const totalSteps = 4;
      console.log('[BETA] T5-small not loaded yet, using cloud providers first');
      // Kick off model load in background for next time
      if (mlWorker.isAvailable) {
        mlWorker.loadModel('summarization-beta').catch(() => {});
      }

      // Cloud providers while model loads
      onProgress?.(1, totalSteps, 'Connecting to AI4U...');
      const groqResult = await tryGroq(headlines, geoContext);
      if (groqResult) {
        console.log('[BETA] AI4U primary:', groqResult.summary);
        return groqResult;
      }

      onProgress?.(2, totalSteps, 'Trying AI4U fallback model...');
      const openRouterResult = await tryOpenRouter(headlines, geoContext);
      if (openRouterResult) return openRouterResult;

      // Last resort: try browser T5 (may have finished loading by now)
      if (mlWorker.isAvailable) {
        onProgress?.(3, totalSteps, 'Waiting for local AI model...');
        const browserResult = await tryBrowserT5(headlines, 'summarization-beta');
        if (browserResult) return browserResult;
      }

      onProgress?.(4, totalSteps, 'No providers available');
    }

    console.warn('[BETA] All providers failed');
    return null;
  }

  const totalSteps = 3;

  // Step 1: Try AI4U primary model
  onProgress?.(1, totalSteps, 'Connecting to AI4U...');
  const groqResult = await tryGroq(headlines, geoContext, lang);
  if (groqResult) {
    return groqResult;
  }

  // Step 2: Try AI4U fallback model
  onProgress?.(2, totalSteps, 'Trying AI4U fallback model...');
  const openRouterResult = await tryOpenRouter(headlines, geoContext, lang);
  if (openRouterResult) {
    return openRouterResult;
  }

  // Step 3: Try Browser T5 (local, unlimited but slower)
  onProgress?.(3, totalSteps, 'Loading local AI model...');
  const browserResult = await tryBrowserT5(headlines);
  if (browserResult) {
    return browserResult;
  }

  console.warn('[Summarization] All providers failed');
  return null;
}


/**
 * Translate text using the fallback chain
 * @param text Text to translate
 * @param targetLang Target language code (e.g., 'fr', 'es')
 */
export async function translateText(
  text: string,
  targetLang: string,
  onProgress?: ProgressCallback
): Promise<string | null> {
  if (!text) return null;

  // Step 1: Try AI4U primary model endpoint
  if (isFeatureAvailable('aiGroq')) {
    onProgress?.(1, 2, 'Translating with AI4U...');
    try {
      const response = await fetch('/api/groq-summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headlines: [text],
          mode: 'translate',
          variant: targetLang
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.summary;
      }
    } catch (e) {
      console.warn('AI4U primary translation failed', e);
    }
  }

  // Step 2: Try AI4U fallback model endpoint
  if (isFeatureAvailable('aiGroq')) {
    onProgress?.(2, 2, 'Translating with AI4U fallback model...');
    try {
      const response = await fetch('/api/openrouter-summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headlines: [text],
          mode: 'translate',
          variant: targetLang
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.summary;
      }
    } catch (e) {
      console.warn('AI4U fallback translation failed', e);
    }
  }

  return null;
}

export async function translateTextCached(
  text: string,
  targetLang: string,
  onProgress?: ProgressCallback
): Promise<string | null> {
  const normalizedText = String(text || '').trim();
  const normalizedLang = String(targetLang || '').trim().toLowerCase();
  if (!normalizedText || !normalizedLang || normalizedLang === 'en') return null;

  const cacheKey = getTranslationCacheKey(normalizedText, normalizedLang);
  const cached = readCachedTranslation(cacheKey);
  if (cached) return cached;

  const pending = translationPending.get(cacheKey);
  if (pending) return pending;

  const task = (async () => {
    const translated = await translateText(normalizedText, normalizedLang, onProgress);
    if (translated && translated.trim()) {
      writeCachedTranslation(cacheKey, translated.trim());
      return translated.trim();
    }
    return null;
  })().finally(() => {
    translationPending.delete(cacheKey);
  });

  translationPending.set(cacheKey, task);
  return task;
}
