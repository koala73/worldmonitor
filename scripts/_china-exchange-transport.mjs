// Shared transport primitives for the mainland Chinese exchange hosts
// (query.sse.com.cn, www.szse.cn), extracted from
// china-corporate-disclosures/adapters.mjs so a second consumer --
// china-stock-connect -- reuses the proxy hop, the bounded reads, and the
// failure classification instead of reimplementing them.

import { createRequire } from 'node:module';

const {
  parseProxyConfigForAttempt,
  proxyFetch,
} = createRequire(import.meta.url)('./_proxy-utils.cjs');

export { proxyFetch };

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
