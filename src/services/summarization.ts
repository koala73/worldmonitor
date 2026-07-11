/**
 * Summarization Service with Fallback Chain
 * Server-side Redis caching handles cross-user deduplication
 * Fallback: Ollama -> Groq -> OpenRouter -> Browser T5
 *
 * Uses NewsServiceClient.summarizeArticle() RPC instead of legacy
 * per-provider fetch endpoints.
 */

import { mlWorker } from './ml-worker';
import { getRpcBaseUrl, getRpcErrorStatusCode } from '@/services/rpc-client';
import { SITE_VARIANT } from '@/config';
import { BETA_MODE } from '@/config/beta';
import { isFeatureAvailable, type RuntimeFeatureId } from './runtime-config';
import { trackLLMUsage, trackLLMFailure } from './analytics';
import { getCurrentLanguage } from './i18n';
import type { SummarizeArticleResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { buildSummaryCacheKey } from '@/utils/summary-cache-key';
import { NewsServiceClient } from '@/services/generated-rpc-clients';
import { premiumFetch } from '@/services/premium-fetch';
import {
  canAttemptServerSummarization,
  configureSummarizeGate,
  parseSummarizeRetryAfterMs,
  suppressServerSummarization,
  suppressServerSummarizationFor,
} from '@/services/summarize-gate';
import { hasPremiumAccess } from '@/services/panel-gating';

export type SummarizationProvider = 'ollama' | 'groq' | 'openrouter' | 'browser' | 'cache';

export interface SummarizationResult {
  summary: string;
  provider: SummarizationProvider;
  model: string;
  cached: boolean;
}

export type ProgressCallback = (step: number, total: number, message: string) => void;

export interface SummarizeOptions {
  skipCloudProviders?: boolean;  // true = skip Ollama/Groq/OpenRouter, go straight to browser T5
  skipBrowserFallback?: boolean; // true = skip browser T5 fallback
  /**
   * Optional article bodies paired 1:1 with `headlines`. When supplied and
   * non-empty, the server-side SummarizeArticle handler grounds each headline
   * with its paired Context line in the prompt. Empty / undefined → current
   * headline-only behavior (R6). Bodies are pre-sanitised server-side.
   */
  bodies?: string[];
}

// ── Sebuf client (replaces direct fetch to /api/{provider}-summarize) ──

const newsClient = new NewsServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const premiumNewsClient = new NewsServiceClient(getRpcBaseUrl(), {
  fetch: async (input, init) => {
    const response = await premiumFetch(input, { ...init, forcePremium: true });
    if (response.status === 429) {
      const retryAfterMs = parseSummarizeRetryAfterMs(response.headers.get('Retry-After'));
      if (retryAfterMs === null) {
        // The server normally supplies Retry-After. A malformed/missing value
        // must still stop this provider chain from multiplying the same 429.
        suppressServerSummarization();
      } else {
        suppressServerSummarizationFor(retryAfterMs);
      }
    }
    return response;
  },
});

// #4913: summarize-article LLM spend is premium-gated server-side (#4687).
// Gate every API-provider dispatch on the client-side entitlement signal so
// anon/free principals fall straight to the browser-T5 provider with ZERO
// network attempts — before this gate, every summarize attempt fanned out up
// to 3 doomed RPCs (ollama→openrouter→groq through the same gated endpoint).
// panel-gating's hasPremiumAccess is the dual-signal source of truth.
// translateText is deliberately NOT gated: it uses mode='translate' via the
// plain newsClient, which the server allows for non-premium callers.
configureSummarizeGate(() => hasPremiumAccess());
const summaryBreaker = createCircuitBreaker<SummarizeArticleResponse>({ name: 'News Summarization', cacheTtlMs: 0 });

const summaryResultBreaker = createCircuitBreaker<SummarizationResult | null>({
  name: 'SummaryResult',
  cacheTtlMs: 2 * 60 * 60 * 1000,
  persistCache: true,
  maxCacheEntries: 128,
});

const emptySummaryFallback: SummarizeArticleResponse = { summary: '', provider: '', model: '', fallback: true, tokens: 0, error: '', errorType: '', status: 'SUMMARIZE_STATUS_UNSPECIFIED', statusDetail: '' };

// ── Provider definitions ──

interface ApiProviderDef {
  featureId: RuntimeFeatureId;
  provider: SummarizationProvider;
  label: string;
}

// Order matches the server's default chain since #4944: OpenRouter
// (DeepSeek V4 Flash) ahead of Groq — the RPC honors the client-supplied
// provider, so the client's try-order decides which model summarizes.
const API_PROVIDERS: ApiProviderDef[] = [
  { featureId: 'aiOllama',      provider: 'ollama',     label: 'Ollama' },
  { featureId: 'aiOpenRouter',  provider: 'openrouter', label: 'OpenRouter' },
  { featureId: 'aiGroq',        provider: 'groq',       label: 'Groq AI' },
];

let lastAttemptedProvider = 'none';

// ── Unified API provider caller (via SummarizeArticle RPC) ──

async function tryApiProvider(
  providerDef: ApiProviderDef,
  headlines: string[],
  geoContext?: string,
  lang?: string,
  bodies?: string[],
): Promise<SummarizationResult | null> {
  if (!isFeatureAvailable(providerDef.featureId)) return null;
  // Entitlement/suppression gate BEFORE any network dispatch (#4913) — a
  // denial returns null so the chain falls through to browser T5.
  if (!canAttemptServerSummarization()) return null;
  lastAttemptedProvider = providerDef.provider;
  try {
    const resp: SummarizeArticleResponse = await summaryBreaker.execute(async () => {
      try {
        return await premiumNewsClient.summarizeArticle({
          provider: providerDef.provider,
          headlines,
          mode: 'brief',
          geoContext: geoContext || '',
          variant: SITE_VARIANT,
          lang: lang || 'en',
          systemAppend: '',
          bodies: bodies ?? [],
        });
      } catch (error) {
        // Entitlement drift: probe said entitled, server said no. Suppress
        // the whole provider chain for a window so drift can't recreate the
        // flood at news-refresh rate; the breaker still counts the failure.
        // Duck-typed via getRpcErrorStatusCode — a value import of the
        // generated client's ApiError would pull the RPC client chunk into
        // the main static graph (eager-chunk budget).
        if (getRpcErrorStatusCode(error) === 403) {
          suppressServerSummarization();
        }
        throw error;
      }
    }, emptySummaryFallback);

    // Provider skipped (credentials missing) or signaled fallback
    if (resp.status === 'SUMMARIZE_STATUS_SKIPPED' || resp.fallback) return null;

    const summary = typeof resp.summary === 'string' ? resp.summary.trim() : '';
    if (!summary) return null;

    const cached = resp.status === 'SUMMARIZE_STATUS_CACHED';
    const resultProvider = cached ? 'cache' : providerDef.provider;
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

async function tryBrowserT5(
  headlines: string[],
  modelId?: string,
  bodies?: string[],
): Promise<SummarizationResult | null> {
  try {
    if (!mlWorker.isAvailable) {
      return null;
    }
    lastAttemptedProvider = 'browser';

    const lang = getCurrentLanguage();
    // When bodies are supplied, interleave them with headlines so the local
    // T5-small model grounds on article context instead of headline metadata
    // alone. Mirrors the server-side `Context:` interleave in
    // buildArticlePrompts (U6). Clip each body to 200 chars so the combined
    // prompt stays inside T5-small's ~512-token context window.
    const topHeadlines = headlines.slice(0, 5);
    const hasBody = Array.isArray(bodies) && bodies.some(b => typeof b === 'string' && b.length > 0);
    const combinedText = hasBody
      ? topHeadlines.map((h, i) => {
          const b = typeof bodies![i] === 'string' ? bodies![i]!.slice(0, 200) : '';
          return b ? `${h.slice(0, 80)} — ${b}` : h.slice(0, 80);
        }).join('. ')
      : topHeadlines.map(h => h.slice(0, 80)).join('. ');
    const prompt = lang === 'fr'
      ? `Résumez le titre le plus important en 2 phrases concises (moins de 60 mots) : ${combinedText}`
      : `Summarize the most important headline in 2 concise sentences (under 60 words): ${combinedText}`;

    const [summary] = await mlWorker.summarize([prompt], modelId);

    if (!summary || summary.length < 20 || summary.toLowerCase().includes('summarize') || summary.toLowerCase().includes('résumez')) {
      return null;
    }

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
  bodies?: string[],
): Promise<SummarizationResult | null> {
  for (const [i, provider] of providers.entries()) {
    onProgress?.(stepOffset + i, totalSteps, `Connecting to ${provider.label}...`);
    const result = await tryApiProvider(provider, headlines, geoContext, lang, bodies);
    if (result) return result;
  }
  return null;
}

/**
 * Generate a summary using the fallback chain: Ollama -> Groq -> OpenRouter -> Browser T5
 * Server-side Redis caching is handled by the SummarizeArticle RPC handler.
 *
 * @param geoContext Optional geographic signal context to include in the prompt
 * @param options `bodies` threads paired RSS descriptions into the prompt for
 *   grounding. When omitted/empty, behavior is byte-identical to pre-U7
 *   (headline-only prompt + headline-only cache key), preserving R6.
 */
export async function generateSummary(
  headlines: string[],
  onProgress?: ProgressCallback,
  geoContext?: string,
  lang: string = 'en',
  options?: SummarizeOptions,
): Promise<SummarizationResult | null> {
  if (!headlines || headlines.length < 2) {
    return null;
  }

  const bodies = options?.bodies;
  const optionsSuffix = options?.skipCloudProviders || options?.skipBrowserFallback
    ? `:opts${options.skipCloudProviders ? 'C' : ''}${options.skipBrowserFallback ? 'B' : ''}`
    : '';
  const cacheKey = buildSummaryCacheKey(headlines, 'brief', geoContext, SITE_VARIANT, lang, undefined, bodies) + optionsSuffix;

  return summaryResultBreaker.execute(
    async () => {
      lastAttemptedProvider = 'none';
      const result = await generateSummaryInternal(headlines, onProgress, geoContext, lang, options);

      if (result) {
        trackLLMUsage(result.provider, result.model, result.cached);
      } else {
        trackLLMFailure(lastAttemptedProvider);
      }

      return result;
    },
    null,
    { cacheKey, shouldCache: (result) => result !== null },
  );
}

async function generateSummaryInternal(
  headlines: string[],
  onProgress: ProgressCallback | undefined,
  geoContext: string | undefined,
  lang: string,
  options?: SummarizeOptions,
): Promise<SummarizationResult | null> {
  const bodies = options?.bodies;
  // Only take the pre-chain cache-lookup shortcut when no body is present.
  // When bodies are RAW on the client but sanitised server-side before
  // keying, the keys diverge on injection content. The regular call chain
  // (tryApiProvider → server) still benefits from the server's
  // authoritative cachedFetchJsonWithMeta lookup when bodies are present.
  if (!options?.skipCloudProviders && !bodies?.some((b) => typeof b === 'string' && b.length > 0)) {
    try {
      const cacheKey = buildSummaryCacheKey(headlines, 'brief', geoContext, SITE_VARIANT, lang, undefined, bodies);
      const cached = await newsClient.getSummarizeArticleCache({ cacheKey });
      if (cached.summary) {
        return { summary: cached.summary, provider: 'cache', model: cached.model || '', cached: true };
      }
    } catch { /* cache lookup failed — proceed to provider chain */ }
  }

  if (BETA_MODE) {
    const modelReady = mlWorker.isAvailable && mlWorker.isModelLoaded('summarization-beta');

    if (modelReady) {
      const totalSteps = 1 + API_PROVIDERS.length;
      // Model already loaded -- use browser T5-small first
      if (!options?.skipBrowserFallback) {
        onProgress?.(1, totalSteps, 'Running local AI model (beta)...');
        const browserResult = await tryBrowserT5(headlines, 'summarization-beta', bodies);
        if (browserResult) {
          const groqProvider = API_PROVIDERS.find(p => p.provider === 'groq');
          if (groqProvider && !options?.skipCloudProviders) tryApiProvider(groqProvider, headlines, geoContext, undefined, bodies).catch(() => {});

          return browserResult;
        }
      }

      // Warm model failed inference -- fallback through API providers
      if (!options?.skipCloudProviders) {
        const chainResult = await runApiChain(API_PROVIDERS, headlines, geoContext, undefined, onProgress, 2, totalSteps, bodies);
        if (chainResult) return chainResult;
      }
    } else {
      const totalSteps = API_PROVIDERS.length + 2;
      if (mlWorker.isAvailable && !options?.skipBrowserFallback) {
        mlWorker.loadModel('summarization-beta').catch(() => {});
      }

      // API providers while model loads
      if (!options?.skipCloudProviders) {
        const chainResult = await runApiChain(API_PROVIDERS, headlines, geoContext, undefined, onProgress, 1, totalSteps, bodies);
        if (chainResult) {
          return chainResult;
        }
      }

      // Last resort: try browser T5 (may have finished loading by now)
      if (mlWorker.isAvailable && !options?.skipBrowserFallback) {
        onProgress?.(API_PROVIDERS.length + 1, totalSteps, 'Waiting for local AI model...');
        const browserResult = await tryBrowserT5(headlines, 'summarization-beta', bodies);
        if (browserResult) return browserResult;
      }

      onProgress?.(totalSteps, totalSteps, 'No providers available');
    }

    console.warn('[BETA] All providers failed');
    return null;
  }

  // Normal mode: API chain -> Browser T5
  const totalSteps = API_PROVIDERS.length + 1;
  let chainResult: SummarizationResult | null = null;

  if (!options?.skipCloudProviders) {
    chainResult = await runApiChain(API_PROVIDERS, headlines, geoContext, lang, onProgress, 1, totalSteps, bodies);
  }
  if (chainResult) return chainResult;

  if (!options?.skipBrowserFallback) {
    onProgress?.(totalSteps, totalSteps, 'Loading local AI model...');
    const browserResult = await tryBrowserT5(headlines, undefined, bodies);
    if (browserResult) return browserResult;
  }

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
          systemAppend: '',
          bodies: [],
        });
      }, emptySummaryFallback);

      if (resp.fallback || resp.status === 'SUMMARIZE_STATUS_SKIPPED') continue;
      const summary = typeof resp.summary === 'string' ? resp.summary.trim() : '';
      if (summary) return summary;
    } catch (e) {
      console.warn(`${providerDef.label} translation failed`, e);
    }
  }

  return null;
}
