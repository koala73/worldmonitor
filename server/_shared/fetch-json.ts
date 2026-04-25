import { CHROME_UA } from './constants';
import type { UsageHook } from './redis';
import { buildUpstreamEvent, getUsageScope, sendToAxiom } from './usage';

interface FetchJsonOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /**
   * Provider attribution for usage telemetry. When set, an upstream event
   * is emitted for this call. Leaves request_id / customer_id / route / tier
   * to flow implicitly from the gateway-set UsageScope (issue #3381).
   */
  provider?: string;
  operation?: string;
  /** Escape hatch for callers outside a request scope. Rarely needed. */
  usage?: UsageHook;
}

export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T | null> {
  const t0 = Date.now();
  let status = 0;
  let responseBytes = 0;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': CHROME_UA,
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    status = response.status;
    if (!response.ok) return null;
    const text = await response.text();
    responseBytes = text.length;
    return JSON.parse(text) as T;
  } catch {
    return null;
  } finally {
    // Emit only when the caller has labeled the provider — avoids polluting
    // the dataset with "unknown" rows from internal/utility fetches.
    const provider = options.usage?.provider ?? options.provider;
    const operation = options.usage?.operation ?? options.operation ?? 'fetch';
    if (provider) {
      const durationMs = Date.now() - t0;
      const explicit = options.usage;
      const host = explicit?.host ?? safeHost(url);
      // Single waitUntil() registered synchronously here — no nested
      // ctx.waitUntil() inside the Axiom delivery (Edge runtimes may drop
      // the outer registration after the response phase ends). Static
      // import keeps the emit path on the hot path.
      const scope = getUsageScope();
      const ctx = explicit?.ctx ?? scope?.ctx;
      if (ctx) {
        const event = buildUpstreamEvent({
          requestId: explicit?.requestId ?? scope?.requestId ?? '',
          customerId: explicit?.customerId ?? scope?.customerId ?? null,
          route: explicit?.route ?? scope?.route ?? '',
          tier: explicit?.tier ?? scope?.tier ?? 0,
          provider,
          operation,
          host,
          status,
          durationMs,
          requestBytes: 0,
          responseBytes,
          cacheStatus: 'miss',
        });
        try {
          ctx.waitUntil(sendToAxiom([event]));
        } catch {
          /* telemetry must never throw */
        }
      }
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
