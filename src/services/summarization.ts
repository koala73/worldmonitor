/**
 * Summarization Service with Fallback Chain
 * Server-side Redis caching handles cross-user deduplication
 * Fallback: Ollama -> Groq -> OpenRouter -> Browser T5
 */

import { mlWorker } from './ml-worker';
import { SITE_VARIANT } from '@/config';
import { BETA_MODE } from '@/config/beta';
import { isFeatureAvailable, type RuntimeFeatureId } from './runtime-config';

export type SummarizationProvider = 'ollama' | 'groq' | 'openrouter' | 'browser' | 'cache';

export interface SummarizationResult {
  summary: string;
  provider: SummarizationProvider;
  cached: boolean;
}

export type ProgressCallback = (step: number, total: number, message: string) => void;

// ── Provider interface ──

interface ApiProviderConfig {
  featureId: RuntimeFeatureId;
  endpoint: string;
  name: SummarizationProvider;
  label: string;  // Human-readable name for progress messages
}

interface ProviderApiPayload {
  summary?: unknown;
  cached?: unknown;
  fallback?: unknown;
  model?: unknown;
}

const API_PROVIDERS: ApiProviderConfig[] = [
  { featureId: 'aiOllama',      endpoint: '/api/ollama-summarize',     name: 'ollama',     label: 'Ollama' },
  { featureId: 'aiGroq',        endpoint: '/api/groq-summarize',       name: 'groq',       label: 'Groq AI' },
  { featureId: 'aiOpenRouter',  endpoint: '/api/openrouter-summarize', name: 'openrouter',  label: 'OpenRouter' },
];

// ── Unified API provider caller ──

async function tryApiProvider(
  provider: ApiProviderConfig,
  headlines: string[],
  geoContext?: string,
  lang?: string,
): Promise<SummarizationResult | null> {
  if (!isFeatureAvailable(provider.featureId)) return null;
  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headlines, mode: 'brief', geoContext, variant: SITE_VARIANT, lang }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.fallback) return null;
      throw new Error(`${provider.label} error: ${response.status}`);
    }

    const payload = await response.json() as ProviderApiPayload;
    if (payload.fallback) return null;
    const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
    if (!summary) return null;

    const cached = Boolean(payload.cached);
    const resultProvider = cached ? 'cache' : provider.name;
    console.log(`[Summarization] ${cached ? 'Redis cache hit' : `${provider.label} success`}:`, payload.model);
    return {
      summary,
      provider: resultProvider as SummarizationProvider,
      cached,
    };
  } catch (error) {
    console.warn(`[Summarization] ${provider.label} failed:`, error);
    return null;
  }
}

// ── Browser T5 provider (different interface — no API call) ──

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

// ── Fallback chain runner ──

async function runApiChain(
  providers: ApiProviderConfig[],
  headlines: string[],
  geoContext: string | undefined,
  lang: string | undefined,
  onProgress: ProgressCallback | undefined,
  stepOffset: number,
  totalSteps: number,
): Promise<SummarizationResult | null> {
  for (const [i, provider] of providers.entries()) {
    onProgress?.(stepOffset + i, totalSteps, `Connecting to ${provider.label}...`);
    const result = await tryApiProvider(provider, headlines, geoContext, lang);
    if (result) return result;
  }
  return null;
}

/**
 * Generate a summary using the fallback chain: Ollama -> Groq -> OpenRouter -> Browser T5
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
      const totalSteps = 1 + API_PROVIDERS.length;
      // Model already loaded — use browser T5-small first
      onProgress?.(1, totalSteps, 'Running local AI model (beta)...');
      const browserResult = await tryBrowserT5(headlines, 'summarization-beta');
      if (browserResult) {
        console.log('[BETA] Browser T5-small:', browserResult.summary);
        const groqProvider = API_PROVIDERS.find(p => p.name === 'groq');
        if (groqProvider) tryApiProvider(groqProvider, headlines, geoContext).then(r => {
          if (r) console.log('[BETA] Groq comparison:', r.summary);
        }).catch(() => {});

        return browserResult;
      }

      // Warm model failed inference — fallback through API providers
      const chainResult = await runApiChain(API_PROVIDERS, headlines, geoContext, undefined, onProgress, 2, totalSteps);
      if (chainResult) return chainResult;
    } else {
      const totalSteps = API_PROVIDERS.length + 2;
      console.log('[BETA] T5-small not loaded yet, using cloud providers first');
      if (mlWorker.isAvailable) {
        mlWorker.loadModel('summarization-beta').catch(() => {});
      }

      // API providers while model loads
      const chainResult = await runApiChain(API_PROVIDERS, headlines, geoContext, undefined, onProgress, 1, totalSteps);
      if (chainResult) {
        if (chainResult.provider === 'groq') console.log('[BETA] Groq:', chainResult.summary);
        return chainResult;
      }

      // Last resort: try browser T5 (may have finished loading by now)
      if (mlWorker.isAvailable) {
        onProgress?.(API_PROVIDERS.length + 1, totalSteps, 'Waiting for local AI model...');
        const browserResult = await tryBrowserT5(headlines, 'summarization-beta');
        if (browserResult) return browserResult;
      }

      onProgress?.(totalSteps, totalSteps, 'No providers available');
    }

    console.warn('[BETA] All providers failed');
    return null;
  }

  // Normal mode: API chain → Browser T5
  const totalSteps = API_PROVIDERS.length + 1;

  const chainResult = await runApiChain(API_PROVIDERS, headlines, geoContext, lang, onProgress, 1, totalSteps);
  if (chainResult) return chainResult;

  onProgress?.(totalSteps, totalSteps, 'Loading local AI model...');
  const browserResult = await tryBrowserT5(headlines);
  if (browserResult) return browserResult;

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

  const totalSteps = API_PROVIDERS.length;
  for (const [i, provider] of API_PROVIDERS.entries()) {
    if (!isFeatureAvailable(provider.featureId)) continue;

    onProgress?.(i + 1, totalSteps, `Translating with ${provider.label}...`);
    try {
      const response = await fetch(provider.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headlines: [text],
          mode: 'translate',
          variant: targetLang,
        }),
      });

      if (response.ok) {
        const payload = await response.json() as ProviderApiPayload;
        if (payload.fallback) continue;
        const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
        if (summary) return summary;
      }
    } catch (e) {
      console.warn(`${provider.label} translation failed`, e);
    }
  }

  return null;
}
