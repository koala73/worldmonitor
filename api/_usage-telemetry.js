// Edge-safe wm_api_usage emission for standalone API routes that do not pass
// through server/gateway.ts. Keep this helper in api/: root-level .js Edge
// functions cannot import server/_shared modules at runtime.

import { getClientIp, hasCloudflareTransitProof, UNKNOWN_CLIENT_IP } from './_client-ip.js';

const AXIOM_INGEST_URL = 'https://api.axiom.co/v1/datasets/wm_api_usage/ingest';
const MAX_HEADER_FIELD_LEN = 512;
const TELEMETRY_TIMEOUT_MS = 1_500;
const CB_WINDOW_MS = 5 * 60 * 1_000;
const CB_TRIP_FAILURE_RATIO = 0.05;
const CB_MIN_SAMPLES = 20;

const breakerSamples = [];
let breakerTripped = false;
let breakerOpenUntil = 0;
let breakerProbeInFlight = false;

function capHeader(value) {
  if (value == null) return null;
  return value.length > MAX_HEADER_FIELD_LEN ? value.slice(0, MAX_HEADER_FIELD_LEN) : value;
}

function sanitizedReferer(req) {
  const raw = req.headers.get('referer');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return capHeader(`${url.origin}${url.pathname}`);
  } catch {
    return null;
  }
}

function requestBytes(req) {
  const parsed = Number(req.headers.get('content-length'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function responseBytes(res) {
  const parsed = Number(res.headers.get('content-length'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function originKind(req) {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  try {
    return new URL(origin).host === new URL(req.url).host
      ? 'browser-same-origin'
      : 'browser-cross-origin';
  } catch {
    return 'browser-cross-origin';
  }
}

export function deriveExecutionRegion(req) {
  const requestId = req.headers.get('x-vercel-id') ?? '';
  return requestId.includes('::') ? requestId.split('::', 1)[0] : null;
}

function deriveCountry(req) {
  // cf-ipcountry is client geography only on requests proved to have
  // transited Cloudflare; otherwise it is forgeable and Vercel's peer-country
  // metadata remains the safe fallback.
  if (hasCloudflareTransitProof(req)) {
    const country = req.headers.get('cf-ipcountry');
    return (country && country !== 'T1' ? country : null) ?? req.headers.get('x-vercel-ip-country') ?? null;
  }
  return req.headers.get('x-vercel-ip-country') ?? null;
}

function recordDelivery(ok, isProbe) {
  const now = Date.now();
  if (isProbe) {
    breakerProbeInFlight = false;
    if (ok) {
      breakerSamples.length = 0;
      breakerTripped = false;
      breakerOpenUntil = 0;
    } else {
      breakerOpenUntil = now + CB_WINDOW_MS;
    }
    return;
  }
  while (breakerSamples.length > 0 && now - breakerSamples[0].ts > CB_WINDOW_MS) breakerSamples.shift();
  breakerSamples.push({ ts: now, ok });
  if (breakerSamples.length < CB_MIN_SAMPLES) {
    breakerTripped = false;
    breakerOpenUntil = 0;
    return;
  }
  breakerTripped = breakerSamples.filter((sample) => !sample.ok).length / breakerSamples.length > CB_TRIP_FAILURE_RATIO;
  breakerOpenUntil = breakerTripped ? now + CB_WINDOW_MS : 0;
}

function deliveryMode() {
  if (!breakerTripped) return 'normal';
  if (Date.now() < breakerOpenUntil || breakerProbeInFlight) return null;
  breakerProbeInFlight = true;
  return 'probe';
}

function isBootstrapR2Event(event) {
  return event?.event_type === 'bootstrap_r2_shadow' || event?.event_type === 'bootstrap_r2';
}

function logBootstrapR2DeliveryHealth(failureClass) {
  console.warn(JSON.stringify({
    event_type: 'bootstrap_r2_telemetry_delivery',
    failure_class: failureClass,
    breaker_state: breakerTripped ? 'open' : 'closed',
  }));
}

function recordEventDelivery(event, ok, isProbe, failureClass = null) {
  const wasTripped = breakerTripped;
  recordDelivery(ok, isProbe);
  if (!isBootstrapR2Event(event)) return;
  if (failureClass) logBootstrapR2DeliveryHealth(failureClass);
  if (wasTripped !== breakerTripped) logBootstrapR2DeliveryHealth('breaker_transition');
}

async function deliver(event) {
  if (process.env.USAGE_TELEMETRY !== '1') return;
  const token = process.env.AXIOM_API_TOKEN;
  if (!token) {
    if (isBootstrapR2Event(event)) logBootstrapR2DeliveryHealth('missing_token');
    return;
  }
  const mode = deliveryMode();
  if (!mode) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    const response = await fetch(AXIOM_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([event]),
      signal: controller.signal,
    });
    recordEventDelivery(
      event,
      response.ok,
      mode === 'probe',
      response.ok ? null : 'http_error',
    );
  } catch {
    recordEventDelivery(
      event,
      false,
      mode === 'probe',
      controller.signal.aborted ? 'timeout' : 'network_error',
    );
    // Observability must never alter the session-mint response path.
  } finally {
    clearTimeout(timer);
  }
}

export function __resetWmSessionTelemetryForTests() {
  breakerSamples.length = 0;
  breakerTripped = false;
  breakerOpenUntil = 0;
  breakerProbeInFlight = false;
}

/**
 * Queue one bootstrap-R2 shadow result. This emitter deliberately receives no
 * Request object and constructs a fresh event from a closed allowlist so
 * request, user, credential, and payload fields cannot leak into the dataset.
 */
function bootstrapR2ShadowDelivery(input) {
  return deliver({
    event_type: 'bootstrap_r2_shadow',
    route: '/api/bootstrap',
    r2_outcome: input.r2Outcome,
    r2_reason: input.r2Reason,
    bootstrap_tier: input.bootstrapTier,
    r2_duration_ms: input.r2DurationMs,
    redis_duration_ms: input.redisDurationMs,
    execution_region: input.executionRegion,
    execution_cold: input.executionCold,
    status: input.status,
  });
}

export function deliverBootstrapR2Shadow(input) {
  if (process.env.USAGE_TELEMETRY !== '1') return Promise.resolve();
  return bootstrapR2ShadowDelivery(input);
}

export function emitBootstrapR2Shadow(ctx, input) {
  if (!ctx?.waitUntil || process.env.USAGE_TELEMETRY !== '1') return;
  try {
    ctx.waitUntil(deliverBootstrapR2Shadow(input));
  } catch {
    // Observability must never alter the bootstrap response path.
  }
}

/**
 * Queue one terminal mint outcome. The event intentionally contains only
 * allowlisted request metadata; never add cookies or request/response bodies.
 */
export function emitWmSessionUsage(ctx, req, res, startedAt, reason) {
  if (!ctx?.waitUntil || process.env.USAGE_TELEMETRY !== '1') return;
  try {
    const requestId = req.headers.get('x-vercel-id') ?? '';
    ctx.waitUntil(deliver({
      _time: new Date().toISOString(),
      event_type: 'request',
      request_id: requestId,
      domain: 'auth',
      route: '/api/wm-session',
      method: req.method,
      status: res.status,
      duration_ms: Math.max(0, Date.now() - startedAt),
      req_bytes: requestBytes(req),
      res_bytes: responseBytes(res),
      customer_id: null,
      principal_id: null,
      auth_kind: 'anon',
      tier: 0,
      plan_key: null,
      country: deriveCountry(req),
      ip_city: req.headers.get('x-vercel-ip-city') ?? null,
      ip_region: req.headers.get('x-vercel-ip-country-region') ?? null,
      execution_region: deriveExecutionRegion(req),
      execution_plane: 'vercel-edge',
      origin_kind: originKind(req),
      cache_tier: 'no-store',
      ip: (() => {
        const ip = getClientIp(req);
        return ip === UNKNOWN_CLIENT_IP ? null : ip;
      })(),
      user_agent: capHeader(req.headers.get('user-agent')),
      ua_hash: null,
      referer: sanitizedReferer(req),
      accept_language: capHeader(req.headers.get('accept-language')),
      host: capHeader(req.headers.get('host')),
      sentry_trace_id: req.headers.get('sentry-trace') ?? null,
      reason,
    }));
  } catch {
    // Request metadata parsing must not alter the mint response path.
  }
}
