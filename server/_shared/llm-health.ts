// server/_shared/llm-health.ts
// Lightweight LLM provider health gate.
// Probes provider URLs with a fast request, caches results.
// All LLM call sites check this before attempting expensive fetch calls.

const PROBE_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 60_000; // re-probe every 60s

interface HealthEntry {
  available: boolean;
  checkedAt: number;
}

const cache = new Map<string, HealthEntry>();
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Probe a provider URL to check if it's reachable.
 * Uses a lightweight GET to the base origin (most OpenAI-compat servers
 * return 200 or 404 on root, either confirms reachability).
 */
async function probe(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin;
    await fetch(origin, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an LLM provider endpoint is available.
 * Returns cached result if fresh (< CACHE_TTL_MS old).
 * Otherwise probes and caches the result.
 */
export async function isProviderAvailable(apiUrl: string): Promise<boolean> {
  const origin = new URL(apiUrl).origin;
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.available;
  }

  // Coalesce concurrent probes to the same origin
  const existing = inFlight.get(origin);
  if (existing) return existing;

  const promise = probe(apiUrl).then(available => {
    cache.set(origin, { available, checkedAt: Date.now() });
    inFlight.delete(origin);
    if (!available) {
      console.warn(`[llm-health] Provider unreachable: ${origin}`);
    }
    return available;
  });
  inFlight.set(origin, promise);
  return promise;
}

/**
 * Get current health status for all probed providers.
 * Used by /api/health to expose LLM status.
 */
export function getLlmHealthStatus(): Record<string, { available: boolean; checkedAt: number }> {
  const status: Record<string, { available: boolean; checkedAt: number }> = {};
  for (const [origin, entry] of cache) {
    status[origin] = { available: entry.available, checkedAt: entry.checkedAt };
  }
  return status;
}

/**
 * Force a re-probe of all cached providers.
 * Called on startup or when a provider comes back online.
 */
export async function reprobeAll(): Promise<void> {
  const origins = [...cache.keys()];
  await Promise.all(origins.map(async (origin) => {
    const available = await probe(origin);
    cache.set(origin, { available, checkedAt: Date.now() });
  }));
}

/**
 * Warm the health cache on startup by probing configured providers.
 * Fire-and-forget — does not block the caller.
 */
export function warmHealthCache(): void {
  const providerUrls: string[] = [];

  const ollamaUrl = typeof process !== 'undefined'
    ? (process.env?.OLLAMA_API_URL || process.env?.LLM_API_URL)
    : undefined;
  if (ollamaUrl) providerUrls.push(ollamaUrl);

  if (typeof process !== 'undefined' && process.env?.GROQ_API_KEY) {
    providerUrls.push('https://api.groq.com/openai/v1/chat/completions');
  }
  if (typeof process !== 'undefined' && process.env?.OPENROUTER_API_KEY) {
    providerUrls.push('https://openrouter.ai/api/v1/chat/completions');
  }

  for (const url of providerUrls) {
    void isProviderAvailable(url);
  }
}
