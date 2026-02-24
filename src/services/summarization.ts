/**
 * Summarization Service with Fallback Chain
 * Server-side Redis caching handles cross-user deduplication
 * Fallback: Ollama -> Groq -> OpenRouter -> Browser T5
 *
 * Uses NewsServiceClient.summarizeArticle() RPC instead of legacy
 * per-provider fetch endpoints.
 */

import { mlWorker } from './ml-worker';
import { SITE_VARIANT } from '@/config';
import { BETA_MODE } from '@/config/beta';
import { isFeatureAvailable, type RuntimeFeatureId } from './runtime-config';
import { trackLLMUsage, trackLLMFailure } from './analytics';
import { NewsServiceClient, type SummarizeArticleResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { createCircuitBreaker } from '@/utils';

export type SummarizationProvider = 'ollama' | 'groq' | 'openrouter' | 'browser' | 'cache';

export interface SummarizationResult {
  summary: string;
  provider: SummarizationProvider;
  model: string;
  cached: boolean;
}

export type ProgressCallback = (step: number, total: number, message: string) => void;

// ── Sebuf client (replaces direct fetch to /api/{provider}-summarize) ──

const newsClient = new NewsServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const summaryBreaker = createCircuitBreaker<SummarizeArticleResponse>({ name: 'News Summarization' });

const emptySummaryFallback: SummarizeArticleResponse = { summary: '', provider: '', model: '', cached: false, skipped: false, fallback: true, tokens: 0, reason: '', error: '', errorType: '' };

// ── Provider definitions ──

interface ApiProviderDef {
  featureId: RuntimeFeatureId;
  provider: SummarizationProvider;
  label: string;
}

const API_PROVIDERS: ApiProviderDef[] = [
  { featureId: 'aiOllama',      provider: 'ollama',     label: 'Ollama' },
  { featureId: 'aiGroq',        provider: 'groq',       label: 'Groq AI' },
  { featureId: 'aiOpenRouter',  provider: 'openrouter', label: 'OpenRouter' },
];

let lastAttemptedProvider = 'none';

// ── Unified API provider caller (via SummarizeArticle RPC) ──

async function tryApiProvider(
  providerDef: ApiProviderDef,
  headlines: string[],
  geoContext?: string,
  lang?: string,
): Promise<SummarizationResult | null> {
  if (!isFeatureAvailable(providerDef.featureId)) return null;
  lastAttemptedProvider = providerDef.provider;
  try {
    const resp: SummarizeArticleResponse = await summaryBreaker.execute(async () => {
      return newsClient.summarizeArticle({
        provider: providerDef.provider,
        headlines,
        mode: 'brief',
        geoContext: geoContext || '',
        variant: SITE_VARIANT,
        lang: lang || 'en',
      });
    }, emptySummaryFallback);

    // Provider skipped (credentials missing) or signaled fallback
    if (resp.skipped || resp.fallback) return null;

    const summary = typeof resp.summary === 'string' ? resp.summary.trim() : '';
    if (!summary) return null;

    const cached = Boolean(resp.cached);
    const resultProvider = cached ? 'cache' : providerDef.provider;
    console.log(`[Summarization] ${cached ? 'Redis cache hit' : `${providerDef.label} success`}:`, resp.model);
    return {
      summary,
      provider: resultProvider as SummarizationProvider,
      model: resp.model || providerDef.provider,
      cached,
    };
  } catch (error) {
    console.warn(`[Summarization] ${providerDef.label} failed:`, error);
    return null;
  }
}

// ── Browser T5 provider (different interface -- no API call) ──

async function tryBrowserT5(headlines: string[], modelId?: string): Promise<SummarizationResult | null> {
  try {
    if (!mlWorker.isAvailable) {
      console.log('[Summarization] Browser ML not available');
      return null;
    }
    lastAttemptedProvider = 'browser';

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
      model: modelId || 't5-small',
      cached: false,
    };
  } catch (error) {
    console.warn('[Summarization] Browser T5 failed:', error);
    return null;
  }
}

// ── Fallback chain runner ──

async function runApiChain(
  providers: ApiProviderDef[],
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
 * Server-side Redis caching is handled by the SummarizeArticle RPC handler
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

  lastAttemptedProvider = 'none';
  const result = await generateSummaryInternal(headlines, onProgress, geoContext, lang);

  // Track at generateSummary return only (not inside tryApiProvider) to avoid
  // double-counting beta comparison traffic. Only the winning provider is recorded.
  if (result) {
    trackLLMUsage(result.provider, result.model, result.cached);
  } else {
    trackLLMFailure(lastAttemptedProvider);
  }

  return result;
}

async function generateSummaryInternal(
  headlines: string[],
  onProgress: ProgressCallback | undefined,
  geoContext: string | undefined,
  lang: string,
): Promise<SummarizationResult | null> {
  if (BETA_MODE) {
    const modelReady = mlWorker.isAvailable && mlWorker.isModelLoaded('summarization-beta');

    if (modelReady) {
      const totalSteps = 1 + API_PROVIDERS.length;
      // Model already loaded -- use browser T5-small first
      onProgress?.(1, totalSteps, 'Running local AI model (beta)...');
      const browserResult = await tryBrowserT5(headlines, 'summarization-beta');
      if (browserResult) {
        console.log('[BETA] Browser T5-small:', browserResult.summary);
        const groqProvider = API_PROVIDERS.find(p => p.provider === 'groq');
        if (groqProvider) tryApiProvider(groqProvider, headlines, geoContext).then(r => {
          if (r) console.log('[BETA] Groq comparison:', r.summary);
        }).catch(() => {});

        return browserResult;
      }

      // Warm model failed inference -- fallback through API providers
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

  // Normal mode: API chain -> Browser T5
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
 * Translate text using the fallback chain (via SummarizeArticle RPC with mode='translate')
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
  for (const [i, providerDef] of API_PROVIDERS.entries()) {
    if (!isFeatureAvailable(providerDef.featureId)) continue;

    onProgress?.(i + 1, totalSteps, `Translating with ${providerDef.label}...`);
    try {
      const resp = await summaryBreaker.execute(async () => {
        return newsClient.summarizeArticle({
          provider: providerDef.provider,
          headlines: [text],
          mode: 'translate',
          geoContext: '',
          variant: targetLang,
          lang: '',
        });
      }, emptySummaryFallback);

      if (resp.fallback || resp.skipped) continue;
      const summary = typeof resp.summary === 'string' ? resp.summary.trim() : '';
      if (summary) return summary;
    } catch (e) {
      console.warn(`${providerDef.label} translation failed`, e);
    }
  }

  return null;
}
