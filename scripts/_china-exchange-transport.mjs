// Shared transport PRIMITIVES for the mainland Chinese exchange hosts
// (query.sse.com.cn, www.szse.cn), extracted from
// china-corporate-disclosures/adapters.mjs so a second consumer --
// china-stock-connect -- reuses the proxy hop, the edge hop, the bounded reads
// and the failure classification instead of reimplementing them. Behaviour is
// unchanged; china-corporate-disclosures re-exports the two names that were
// already part of its public surface.
//
// SCOPE: the primitives are shared, the CASCADE is not. Each consumer still
// sequences direct -> proxy -> edge itself, because their shapes differ (a
// single request per issuer vs a bounded walk over candidate trade dates with a
// sticky hop and a shared wall-clock budget). That leaves the fallback ORDER
// written in two places; consolidating it means rewriting a launched seeder's
// cascade and is deliberately not done here. If you change retry or fallback
// semantics, change both.

import { createRequire } from 'node:module';

const {
  parseProxyConfigForAttempt,
  proxyFetch,
} = createRequire(import.meta.url)('./_proxy-utils.cjs');

export { proxyFetch };

export const CHINA_EXCHANGE_EDGE_EGRESS_URL = 'https://api.worldmonitor.app/api/internal/china-exchange-egress';
export const CHINA_EXCHANGE_EDGE_ERROR_CODES = new Set([
  'upstream_timeout',
  'upstream_fetch_failed',
  'upstream_response_too_large',
]);

export function sourceError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function readBoundedResponseBytes(response, maxBytes) {
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    // Cancel before throwing, matching the chunked path below. Leaving the body
    // unread holds the socket until GC, and china-stock-connect reaches this
    // arm routinely: a dateless SZSE report answers with the whole series since
    // 2010 (~438 KiB) and a declared content-length, once per date probe.
    try {
      await response?.body?.cancel?.();
    } catch {
      // A size rejection must not be masked by a cancel that failed.
    }
    throw sourceError('RESPONSE_TOO_LARGE');
  }
  if (!response?.body?.getReader) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > maxBytes) throw sourceError('RESPONSE_TOO_LARGE');
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw sourceError('RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedJsonResponse(response, maxBytes) {
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw sourceError('MALFORMED_RESPONSE', error);
  }
}

export function assertMetadataResponse(response, contract) {
  if (!response?.ok) throw sourceError(`HTTP_${Number(response?.status) || 0}`);
  if (response.redirected) throw sourceError('REDIRECT_BLOCKED');
  if (response.url) {
    const resolved = new URL(response.url);
    if (resolved.protocol !== 'https:' || resolved.hostname !== contract.metadataHost) {
      throw sourceError('REDIRECT_BLOCKED');
    }
  }
}

export function errorCodeFor(error) {
  if (typeof error?.code === 'string') return error.code;
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP_${status}`;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'TIMEOUT';
  if (/timeout/i.test(String(error?.message))) return 'TIMEOUT';
  return 'FETCH_FAILED';
}

export function transportFailureReason(error) {
  const causeCode = String(error?.cause?.code ?? '');
  return /^[A-Z][A-Z0-9_]+$/u.test(causeCode)
    ? causeCode
    : errorCodeFor(error);
}

export function isRetryableExchangeHttpStatus(code) {
  const status = Number(/^HTTP_(\d{3})$/u.exec(code)?.[1]);
  return status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

const RETRYABLE_EXCHANGE_PROXY_FAILURE_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function shouldProxyExchangeFailure(error) {
  const code = errorCodeFor(error);
  if (code === 'FETCH_FAILED' || code === 'TIMEOUT') return true;
  return code === 'HTTP_403' || isRetryableExchangeHttpStatus(code);
}

export function shouldRetryExchangeProxyFailure(error) {
  const reason = transportFailureReason(error);
  // A CONNECT-layer rejection is the gateway refusing the tunnel -- proxy auth,
  // an exhausted account traffic limit, a provider policy block. Every sticky
  // port on the same account answers identically, so retrying only burns the
  // bounded budget. Socket-level codes still retry: those are transient.
  if (error?.cause?.proxyConnect === true || error?.proxyConnect === true) {
    return RETRYABLE_EXCHANGE_PROXY_FAILURE_CODES.has(reason);
  }
  return reason === 'FETCH_FAILED'
    || reason === 'TIMEOUT'
    || RETRYABLE_EXCHANGE_PROXY_FAILURE_CODES.has(reason)
    // The origin blocking this exit IP is the one failure a different sticky
    // session can actually fix, and shouldProxyExchangeFailure already classifies
    // HTTP_403 that way for the direct hop.
    || reason === 'HTTP_403'
    || isRetryableExchangeHttpStatus(reason);
}

export async function fetchViaConfiguredProxy(input, init, {
  proxyUrl,
  attempt,
  maxBytes,
  timeoutMs,
  proxyRequestFn,
  onExitPort,
}) {
  const proxyConfig = parseProxyConfigForAttempt(proxyUrl, attempt);
  if (!proxyConfig) throw sourceError('PROXY_NOT_CONFIGURED');
  onExitPort?.(Number(proxyConfig.port));
  // init.headers carries the same Referer/User-Agent/Content-Type the direct
  // request used (requestInit() below), deliberately: we're routing the exact
  // same declared client through a different egress point, not masquerading
  // as a browser, which matches the source's terms-of-use posture.
  const result = await proxyRequestFn(String(input), proxyConfig, {
    accept: 'application/json',
    headers: init?.headers,
    method: init?.method,
    body: init?.body,
    maxResponseBytes: maxBytes,
    // signal already enforces the caller's timeout; timeoutMs here is a
    // second, independent backstop inside proxyFetch's own socket/tunnel
    // handling in case the AbortSignal doesn't propagate through a stalled
    // CONNECT tunnel. Both are pinned to the source-specific timeout.
    timeoutMs,
    signal: init?.signal,
  });
  if (result.buffer.byteLength > maxBytes) throw sourceError('RESPONSE_TOO_LARGE');
  return new Response(result.buffer, {
    status: result.status,
    headers: {
      'Content-Length': String(result.buffer.byteLength),
      'Content-Type': result.contentType || 'application/octet-stream',
    },
  });
}

export function resolveChinaExchangeEdgeEgress(env = process.env) {
  const isRailwayProduction = env.RAILWAY_ENVIRONMENT === 'production'
    || env.RAILWAY_ENVIRONMENT_NAME === 'production';
  const secret = String(env.RELAY_SHARED_SECRET || '');
  if (!isRailwayProduction || !secret) return null;
  return { url: CHINA_EXCHANGE_EDGE_EGRESS_URL, secret };
}

function normalizedResponseContentType(response) {
  return String(response?.headers?.get?.('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

function edgeFailureDiagnostic(response, rawContentType = normalizedResponseContentType(response)) {
  const cfRay = String(response?.headers?.get?.('cf-ray') || '');
  const vercelId = String(response?.headers?.get?.('x-vercel-id') || '');
  const rawServer = String(response?.headers?.get?.('server') || '').toLowerCase();
  const server = rawServer === 'cloudflare' || rawServer === 'vercel'
    ? rawServer
    : null;
  const safeCfRay = /^[a-f0-9]{8,32}-[A-Z]{3}$/u.test(cfRay) ? cfRay : null;
  const safeVercelId = /^[A-Za-z0-9:_-]{1,96}$/u.test(vercelId) ? vercelId : null;
  // contentType is emitted even when no intermediary identifies itself: it is
  // already collapsed to the enum below, so it carries no intermediary-controlled
  // text, and an unrecognised box terminating the connection is exactly the case
  // where "did this come from our handler?" is hardest to answer from the code.
  const contentType = ['application/json', 'text/html', 'text/plain'].includes(rawContentType)
    ? rawContentType
    : rawContentType
      ? 'other'
      : 'missing';
  return {
    contentType,
    ...(server ? { server } : {}),
    ...(safeCfRay ? { cfRay: safeCfRay } : {}),
    ...(safeVercelId ? { vercelId: safeVercelId } : {}),
  };
}

async function readEdgeEgressFailure(response, maxBytes, diagnostic) {
  const fallback = `HTTP_${Number(response?.status) || 0}`;
  const contentType = normalizedResponseContentType(response);
  if (contentType !== 'application/json') {
    try {
      await response?.body?.cancel?.();
    } catch {
      // A diagnostic must never fail because an intermediary body could not be cancelled.
    }
    return { code: fallback, diagnostic };
  }
  try {
    const bytes = await readBoundedResponseBytes(response, maxBytes);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return {
      code: CHINA_EXCHANGE_EDGE_ERROR_CODES.has(payload?.error)
        ? payload.error
        : fallback,
      diagnostic,
    };
  } catch {
    return { code: fallback, diagnostic };
  }
}

export async function fetchViaEdgeEgress(_input, init, {
  edgeEgress,
  maxBytes,
  edgeRequestFn,
  onDiagnostic,
}) {
  const response = await edgeRequestFn(edgeEgress.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${edgeEgress.secret}`,
      'Content-Type': 'application/json',
      'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
    },
    body: init?.body,
    redirect: 'error',
    signal: init?.signal,
  });
  // Captured before branching on status. A 2xx interstitial -- an HTML challenge
  // page, or a 200 whose body is not the JSON envelope -- fails downstream in the
  // caller's parser as MALFORMED_RESPONSE, and reporting it through onDiagnostic
  // here is the only way that error reaches the decision log carrying the routing
  // metadata that separates an intermediary from our own handler.
  const diagnostic = edgeFailureDiagnostic(response);
  if (diagnostic) onDiagnostic?.(diagnostic);
  if (!response.ok) {
    const failure = await readEdgeEgressFailure(response, maxBytes, diagnostic);
    const error = sourceError(failure.code);
    if (failure.diagnostic) error.edgeFailureDiagnostic = failure.diagnostic;
    throw error;
  }
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  return new Response(bytes, {
    status: response.status,
    headers: {
      'Content-Length': String(bytes.byteLength),
      'Content-Type': response.headers.get('content-type') || 'application/json',
    },
  });
}
