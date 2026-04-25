/**
 * Axiom-based API usage observability.
 *
 * Emits structured events to the wm_api_usage Axiom dataset behind the
 * USAGE_TELEMETRY=1 env var gate. Events are fire-and-forget via ctx.waitUntil
 * to avoid adding latency to the hot path.
 *
 * Circuit breaker trips at ~5% failure rate over a 5-minute sliding window.
 * A 1% sample of telemetry drops are logged to console.warn for debugging.
 */

const AXIOM_DATASET = 'wm_api_usage';
const AXIOM_INGEST_URL = `https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`;
const AXIOM_TOKEN = process.env.AXIOM_API_TOKEN;

const USAGE_ENABLED = process.env.USAGE_TELEMETRY === '1';
const TIMEOUT_MS = 2_000;

const CB_WINDOW_MS = 5 * 60 * 1_000;
const CB_FAILURE_THRESHOLD = 0.05;

const cbFailures = new Map<number, number>();
let cbLastCleanup = 0;

function circuitBreakerOpen(): boolean {
  const now = Date.now();
  if (now - cbLastCleanup > CB_WINDOW_MS) {
    cbLastCleanup = now;
    for (const [ts] of cbFailures) {
      if (now - ts > CB_WINDOW_MS) cbFailures.delete(ts);
    }
  }
  if (cbFailures.size === 0) return false;
  const total = cbFailures.size;
  const failures = Array.from(cbFailures.values()).reduce((a, b) => a + b, 0);
  return failures / total > CB_FAILURE_THRESHOLD;
}

function recordFailure(): void {
  cbFailures.set(Date.now(), 1);
}

export interface RequestEvent {
  request_id: string;
  country: string;
  execution_region: string;
  req_bytes: number;
  res_bytes: number;
  cache_tier: 'fast' | 'medium' | 'slow' | 'slow-browser' | 'static' | 'daily' | 'no-store';
  cache_status: 'miss' | 'fresh' | 'stale-while-revalidate' | 'neg-sentinel';
  sentry_trace_id?: string;
  rpc: string;
  method: string;
  status: number;
  duration_ms: number;
  auth_kind: string;
  principal_id: string | null;
  customer_id: string | null;
  tier: number;
  reason?: 'origin_403' | 'rate_limit_429';
}

export interface CacheEvent {
  request_id: string;
  provider: string;
  operation: string;
  status: 'hit' | 'miss' | 'error';
  duration_ms: number;
  cache_tier?: string;
}

function buildRequestEvent(params: {
  request: Request;
  identity: import('./usage-identity').UsageIdentity;
  rpc: string;
  status: number;
  duration_ms: number;
  cacheTier: string;
  cacheStatus: 'miss' | 'fresh' | 'stale-while-revalidate' | 'neg-sentinel';
  reason?: 'origin_403' | 'rate_limit_429';
  sentryTraceId?: string;
}): RequestEvent {
  const req = params.request;
  const id = params.identity;

  const reqId = req.headers.get('x-vercel-id') ?? '';
  const region = reqId.includes('::') ? reqId.split('::')[0]! : reqId;

  const country =
    req.headers.get('x-vercel-ip-country') ??
    req.headers.get('cf-ipcountry') ??
    '';

  const contentLen = req.headers.get('Content-Length');
  const reqBytes = contentLen ? parseInt(contentLen, 10) : 0;

  return {
    request_id: reqId,
    country,
    execution_region: region,
    req_bytes: reqBytes,
    res_bytes: 0,
    cache_tier: params.cacheTier as RequestEvent['cache_tier'],
    cache_status: params.cacheStatus,
    sentry_trace_id: params.sentryTraceId,
    rpc: params.rpc,
    method: req.method,
    status: params.status,
    duration_ms: params.duration_ms,
    auth_kind: id.auth_kind,
    principal_id: id.principal_id,
    customer_id: id.customer_id,
    tier: id.tier,
    reason: params.reason,
  };
}

function buildCacheEvent(params: {
  requestId: string;
  provider: string;
  operation: string;
  status: 'hit' | 'miss' | 'error';
  duration_ms: number;
  cacheTier?: string;
}): CacheEvent {
  return {
    request_id: params.requestId,
    provider: params.provider,
    operation: params.operation,
    status: params.status,
    duration_ms: params.duration_ms,
    cache_tier: params.cacheTier,
  };
}

async function sendToAxiom(events: unknown[]): Promise<void> {
  if (!USAGE_ENABLED || !AXIOM_TOKEN || events.length === 0) return;
  if (circuitBreakerOpen()) {
    if (Math.random() < 0.01) {
      console.warn('[usage] circuit breaker open, dropping telemetry');
    }
    return;
  }

  const body = JSON.stringify(events);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await globalThis.fetch(AXIOM_INGEST_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AXIOM_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'worldmonitor-gateway/1.0',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        recordFailure();
      }
    } catch {
      clearTimeout(timer);
      recordFailure();
      if (Math.random() < 0.01) {
        console.warn('[usage] Axiom fetch failed, event drop sampled');
      }
    }
  } catch {
    recordFailure();
  }
}

export function emitUsageEvents(
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  events: RequestEvent[] | CacheEvent[],
): void {
  if (!USAGE_ENABLED) return;
  ctx.waitUntil(sendToAxiom(events));
}

export { buildRequestEvent, buildCacheEvent };