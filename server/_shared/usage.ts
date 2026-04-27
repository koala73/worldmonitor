/**
 * Axiom-based API usage observability — emit-side primitives.
 *
 * - Builders accept allowlisted primitives only. Never accept Request, Response,
 *   or untyped objects: future field additions then leak by structural impossibility.
 * - emitUsageEvents fires via ctx.waitUntil so the Edge isolate cannot tear down
 *   the unflushed POST. Direct fetch, 1.5s timeout, no retry.
 * - Circuit breaker (5% failure / 5min sliding window) trips when delivery is broken.
 * - Tripping logs once via console.error; drops thereafter are 1%-sampled console.warn.
 * - Telemetry failure must not affect API availability or latency.
 *
 * Scoped to USAGE attribution. Sentry-edge already covers exceptions — do NOT
 * emit error tracebacks here. Cross-link via sentry_trace_id field instead.
 */

import type { AuthKind } from './usage-identity';

const AXIOM_DATASET = 'wm_api_usage';
// US region endpoint. EU workspaces would use api.eu.axiom.co.
const AXIOM_INGEST_URL = `https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`;
const TELEMETRY_TIMEOUT_MS = 1_500;

const CB_WINDOW_MS = 5 * 60 * 1_000;
const CB_TRIP_FAILURE_RATIO = 0.05;
const CB_MIN_SAMPLES = 20;
const SAMPLED_DROP_LOG_RATE = 0.01;

function isUsageEnabled(): boolean {
  return process.env.USAGE_TELEMETRY === '1';
}

function isDevHeaderEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// ---------- Event shapes ----------

export type CacheTier =
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slow-browser'
  | 'static'
  | 'daily'
  | 'no-store'
  | 'live';

export type CacheStatus = 'miss' | 'fresh' | 'stale-while-revalidate' | 'neg-sentinel';

export type ExecutionPlane = 'vercel-edge' | 'vercel-node' | 'railway-relay';

export type OriginKind =
  | 'browser-same-origin'
  | 'browser-cross-origin'
  | 'api-key'
  | 'oauth'
  | 'mcp'
  | 'internal-cron';

export type RequestReason =
  | 'ok'
  | 'origin_403'
  | 'rate_limit_429'
  | 'preflight'
  | 'auth_401'
  | 'auth_403'
  | 'tier_403';

export interface RequestEvent {
  _time: string;
  event_type: 'request';
  request_id: string;
  domain: string;
  route: string;
  method: string;
  status: number;
  duration_ms: number;
  req_bytes: number;
  res_bytes: number;
  customer_id: string | null;
  principal_id: string | null;
  auth_kind: AuthKind;
  tier: number;
  country: string | null;
  execution_region: string | null;
  execution_plane: ExecutionPlane;
  origin_kind: OriginKind | null;
  cache_tier: CacheTier | null;
  ua_hash: string | null;
  sentry_trace_id: string | null;
  reason: RequestReason;
}

export interface UpstreamEvent {
  _time: string;
  event_type: 'upstream';
  request_id: string;
  customer_id: string | null;
  route: string;
  tier: number;
  provider: string;
  operation: string;
  host: string;
  status: number;
  duration_ms: number;
  request_bytes: number;
  response_bytes: number;
  cache_status: CacheStatus;
}

export type UsageEvent = RequestEvent | UpstreamEvent;

// ---------- Builders (allowlisted primitives only) ----------

export function buildRequestEvent(p: {
  requestId: string;
  domain: string;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  reqBytes: number;
  resBytes: number;
  customerId: string | null;
  principalId: string | null;
  authKind: AuthKind;
  tier: number;
  country: string | null;
  executionRegion: string | null;
  executionPlane: ExecutionPlane;
  originKind: OriginKind | null;
  cacheTier: CacheTier | null;
  uaHash: string | null;
  sentryTraceId: string | null;
  reason: RequestReason;
}): RequestEvent {
  return {
    _time: new Date().toISOString(),
    event_type: 'request',
    request_id: p.requestId,
    domain: p.domain,
    route: p.route,
    method: p.method,
    status: p.status,
    duration_ms: p.durationMs,
    req_bytes: p.reqBytes,
    res_bytes: p.resBytes,
    customer_id: p.customerId,
    principal_id: p.principalId,
    auth_kind: p.authKind,
    tier: p.tier,
    country: p.country,
    execution_region: p.executionRegion,
    execution_plane: p.executionPlane,
    origin_kind: p.originKind,
    cache_tier: p.cacheTier,
    ua_hash: p.uaHash,
    sentry_trace_id: p.sentryTraceId,
    reason: p.reason,
  };
}

export function buildUpstreamEvent(p: {
  requestId: string;
  customerId: string | null;
  route: string;
  tier: number;
  provider: string;
  operation: string;
  host: string;
  status: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  cacheStatus: CacheStatus;
}): UpstreamEvent {
  return {
    _time: new Date().toISOString(),
    event_type: 'upstream',
    request_id: p.requestId,
    customer_id: p.customerId,
    route: p.route,
    tier: p.tier,
    provider: p.provider,
    operation: p.operation,
    host: p.host,
    status: p.status,
    duration_ms: p.durationMs,
    request_bytes: p.requestBytes,
    response_bytes: p.responseBytes,
    cache_status: p.cacheStatus,
  };
}

// ---------- Header-derived helpers (ok to take Request — these only read primitives) ----------

export function deriveRequestId(req: Request): string {
  return req.headers.get('x-vercel-id') ?? '';
}

export function deriveExecutionRegion(req: Request): string | null {
  const id = req.headers.get('x-vercel-id');
  if (!id) return null;
  const sep = id.indexOf('::');
  return sep > 0 ? id.slice(0, sep) : null;
}

export function deriveCountry(req: Request): string | null {
  return (
    req.headers.get('x-vercel-ip-country') ??
    req.headers.get('cf-ipcountry') ??
    null
  );
}

export function deriveReqBytes(req: Request): number {
  const len = req.headers.get('content-length');
  if (!len) return 0;
  const n = Number(len);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function deriveSentryTraceId(req: Request): string | null {
  return req.headers.get('sentry-trace') ?? null;
}

// ua_hash: SHA-256(UA + monthly-rotated pepper). Pepper key: USAGE_UA_PEPPER.
// If the pepper is unset we return null rather than a stable per-browser fingerprint.
export async function deriveUaHash(req: Request): Promise<string | null> {
  const pepper = process.env.USAGE_UA_PEPPER;
  if (!pepper) return null;
  const ua = req.headers.get('user-agent') ?? '';
  if (!ua) return null;
  const data = new TextEncoder().encode(`${pepper}|${ua}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function deriveOriginKind(req: Request): OriginKind | null {
  const origin = req.headers.get('origin') ?? '';
  const hasApiKey =
    req.headers.has('x-worldmonitor-key') || req.headers.has('x-api-key');
  const hasBearer = (req.headers.get('authorization') ?? '').startsWith('Bearer ');
  if (hasApiKey) return 'api-key';
  if (hasBearer) return 'oauth';
  if (!origin) return null;
  try {
    const host = new URL(origin).host;
    const reqHost = new URL(req.url).host;
    return host === reqHost ? 'browser-same-origin' : 'browser-cross-origin';
  } catch {
    return 'browser-cross-origin';
  }
}

// ---------- Circuit breaker ----------

interface BreakerSample {
  ts: number;
  ok: boolean;
}

const breakerSamples: BreakerSample[] = [];
let breakerTripped = false;
let breakerLastNotifyTs = 0;

function pruneOldSamples(now: number): void {
  while (breakerSamples.length > 0 && now - breakerSamples[0]!.ts > CB_WINDOW_MS) {
    breakerSamples.shift();
  }
}

function recordSample(ok: boolean): void {
  const now = Date.now();
  pruneOldSamples(now);
  breakerSamples.push({ ts: now, ok });

  if (breakerSamples.length < CB_MIN_SAMPLES) {
    breakerTripped = false;
    return;
  }
  let failures = 0;
  for (const s of breakerSamples) if (!s.ok) failures++;
  const ratio = failures / breakerSamples.length;
  const wasTripped = breakerTripped;
  breakerTripped = ratio > CB_TRIP_FAILURE_RATIO;

  if (breakerTripped && !wasTripped && now - breakerLastNotifyTs > CB_WINDOW_MS) {
    breakerLastNotifyTs = now;
    console.error('[usage-telemetry] circuit breaker tripped', {
      ratio: ratio.toFixed(3),
      samples: breakerSamples.length,
    });
  }
}

export function getTelemetryHealth(): 'ok' | 'degraded' | 'off' {
  if (!isUsageEnabled()) return 'off';
  return breakerTripped ? 'degraded' : 'ok';
}

export function maybeAttachDevHealthHeader(headers: Headers): void {
  if (!isDevHeaderEnabled()) return;
  headers.set('x-usage-telemetry', getTelemetryHealth());
}

// ---------- Implicit request scope (AsyncLocalStorage) ----------
//
// Per koala's review (#3381), this lets fetch helpers emit upstream events
// without leaf handlers having to thread a usage hook through every call.
// The gateway sets the scope before invoking matchedHandler; fetch helpers
// (fetchJson, cachedFetchJsonWithMeta) read from it lazily.
//
// AsyncLocalStorage is loaded defensively. If the runtime ever rejects the
// import (older Edge versions, sandboxed contexts), the scope helpers
// degrade to no-ops and telemetry simply skips. The gateway request event
// is unaffected — it never depended on ALS.

export interface UsageScope {
  ctx: WaitUntilCtx;
  requestId: string;
  customerId: string | null;
  route: string;
  tier: number;
}

type ALSLike<T> = {
  run: <R>(store: T, fn: () => R) => R;
  getStore: () => T | undefined;
};

let scopeStore: ALSLike<UsageScope> | null = null;

async function getScopeStore(): Promise<ALSLike<UsageScope> | null> {
  if (scopeStore) return scopeStore;
  try {
    const mod = await import('node:async_hooks');
    scopeStore = new mod.AsyncLocalStorage<UsageScope>();
    return scopeStore;
  } catch {
    return null;
  }
}

export async function runWithUsageScope<R>(scope: UsageScope, fn: () => R | Promise<R>): Promise<R> {
  const store = await getScopeStore();
  if (!store) return fn();
  return store.run(scope, fn) as R | Promise<R>;
}

export function getUsageScope(): UsageScope | undefined {
  return scopeStore?.getStore();
}

// ---------- Sink ----------

export async function sendToAxiom(events: UsageEvent[]): Promise<void> {
  if (!isUsageEnabled()) return;
  if (events.length === 0) return;
  const token = process.env.AXIOM_API_TOKEN;
  if (!token) {
    if (Math.random() < SAMPLED_DROP_LOG_RATE) {
      console.warn('[usage-telemetry] drop', { reason: 'no-token' });
    }
    return;
  }
  if (breakerTripped) {
    if (Math.random() < SAMPLED_DROP_LOG_RATE) {
      console.warn('[usage-telemetry] drop', { reason: 'breaker-open' });
    }
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    const resp = await fetch(AXIOM_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(events),
      signal: controller.signal,
    });
    if (!resp.ok) {
      recordSample(false);
      if (Math.random() < SAMPLED_DROP_LOG_RATE) {
        console.warn('[usage-telemetry] drop', { reason: `http-${resp.status}` });
      }
      return;
    }
    recordSample(true);
  } catch (err) {
    recordSample(false);
    if (Math.random() < SAMPLED_DROP_LOG_RATE) {
      const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'fetch-error';
      console.warn('[usage-telemetry] drop', { reason });
    }
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitUntilCtx {
  waitUntil: (p: Promise<unknown>) => void;
}

export function emitUsageEvents(ctx: WaitUntilCtx, events: UsageEvent[]): void {
  if (!isUsageEnabled() || events.length === 0) return;
  ctx.waitUntil(sendToAxiom(events));
}

// Variant that returns the in-flight delivery promise instead of registering
// it on a context. Use when the caller is already inside a single
// ctx.waitUntil() chain and wants to await delivery synchronously to avoid a
// nested waitUntil registration (which Edge runtimes may drop).
export function deliverUsageEvents(events: UsageEvent[]): Promise<void> {
  if (!isUsageEnabled() || events.length === 0) return Promise.resolve();
  return sendToAxiom(events);
}
