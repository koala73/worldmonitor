import { ExaProvider } from './exa.js';
import { FirecrawlProvider } from './firecrawl.js';
import { P0Provider } from './p0.js';
import { PlaywrightProvider } from './playwright.js';
import type { AcquisitionConfig, AcquisitionProvider, AcquisitionProviderName, FetchOptions, FetchResult } from './types.js';

const _providers = new Map<AcquisitionProviderName, AcquisitionProvider>();

export function initProviders(env: Record<string, string | undefined>) {
  _providers.set('playwright', new PlaywrightProvider());

  if (env.EXA_API_KEY) {
    _providers.set('exa', new ExaProvider(env.EXA_API_KEY));
  }
  if (env.FIRECRAWL_API_KEY) {
    _providers.set('firecrawl', new FirecrawlProvider(env.FIRECRAWL_API_KEY));
  }
  if (env.P0_API_KEY) {
    _providers.set('p0', new P0Provider(env.P0_API_KEY, env.P0_BASE_URL));
  }
}

export function getProvider(name: AcquisitionProviderName): AcquisitionProvider {
  const p = _providers.get(name);
  if (!p) throw new Error(`Acquisition provider '${name}' is not configured. Set the required API key env var.`);
  return p;
}

export async function teardownAll(): Promise<void> {
  for (const p of _providers.values()) {
    await p.teardown?.();
  }
  _providers.clear();
}

/**
 * Fetch a URL using the provider chain defined in config.
 * Tries primary provider first; on failure, tries fallback.
 */
export async function fetchWithFallback(
  url: string,
  config: AcquisitionConfig,
  opts?: FetchOptions,
): Promise<FetchResult> {
  const primary = getProvider(config.provider);
  const mergedOpts = { ...config.options, ...opts };

  try {
    return await primary.fetch(url, mergedOpts);
  } catch (err) {
    if (!config.fallback) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[acquisition] ${config.provider} failed for ${url}: ${msg}. Falling back to ${config.fallback}.`);

    const fallback = getProvider(config.fallback);
    return fallback.fetch(url, mergedOpts);
  }
}
