import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { isIP } from 'node:net';

const requests = new AsyncLocalStorage();
const ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function responseMetadata(response) {
  const get = name => response.headers?.get?.(name) ?? response.headers?.[name];
  const server = get('server');
  const type = String(get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ray = get('cf-ray');
  return {
    status: Number.isInteger(response.status) ? response.status : null,
    server: server == null ? null : /^cloudflare$/i.test(server) ? 'cloudflare' : 'other',
    contentType: ['text/html', 'application/json', 'application/xml', 'application/atom+xml', 'text/xml', 'text/plain'].includes(type) ? type : null,
    cfRay: typeof ray === 'string' && /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(ray) ? ray : null,
    challenge: get('cf-mitigated') === 'challenge',
  };
}

// Observes the existing operation; it never changes its signal, retries or result.
export async function withSourceRequestDiagnostics({ source, stage = null, route = 'direct', attempt = 0 }, operation) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const record = {
    event: 'source_request_diagnostic', requestId: randomUUID(), source, stage, route, attempt,
    phase: 'fetch', createdMs: null, writeStartedMs: null, sentMs: null, headersMs: null,
    status: null, remoteAddress: null, localPort: null,
  };
  const owned = new WeakSet();
  const listeners = [
    ['undici:request:create', ({ request }) => {
      if (requests.getStore() !== record) return;
      owned.add(request);
      record.createdMs = elapsed();
      record.phase = 'request_created';
    }],
    ['undici:client:sendHeaders', ({ request, socket }) => {
      if (!owned.has(request)) return;
      record.writeStartedMs = elapsed();
      record.phase = 'request_write_started';
      record.remoteAddress = isIP(socket?.remoteAddress || '') ? socket.remoteAddress : null;
      record.localPort = Number.isInteger(socket?.localPort) ? socket.localPort : null;
    }],
    ['undici:request:bodySent', ({ request }) => {
      if (!owned.has(request)) return;
      record.sentMs = elapsed();
      record.phase = 'request_sent';
    }],
    ['undici:request:headers', ({ request }) => {
      if (!owned.has(request)) return;
      record.headersMs = elapsed();
      record.phase = 'response_headers';
    }],
  ];
  for (const [name, listener] of listeners) channel(name).subscribe(listener);
  let failed = false;
  const observe = response => {
    record.headersMs ??= elapsed();
    record.phase = 'response_headers';
    try { Object.assign(record, responseMetadata(response)); } catch { /* Ignore unavailable response metadata. */ }
  };
  try {
    return await requests.run(record, () => operation(observe));
  } catch (error) {
    failed = true;
    const causes = [error, error?.cause, error?.cause?.cause];
    record.errorCode = causes.map(cause => cause?.code).find(code => ERROR_CODES.has(code)) ?? null;
    record.errorName = causes.map(cause => cause?.name).find(name => ['TimeoutError', 'AbortError', 'TypeError', 'SyntaxError'].includes(name)) ?? 'Error';
    record.proxyConnect = error?.proxyConnect === true;
    if (record.proxyConnect && Number.isInteger(error.status)) record.status = error.status;
    if (route === 'proxy' && error?.proxyFailure?.stage === 'response_body') {
      record.phase = 'response_body';
      const status = error.proxyFailure.httpStatus;
      if (Number.isInteger(status) && status >= 100 && status <= 599) record.status = status;
    }
    throw error;
  } finally {
    for (const [name, listener] of listeners) channel(name).unsubscribe(listener);
    if (failed || source === 'nrcan' || record.status >= 400) {
      try { console.warn(JSON.stringify({ ...record, elapsedMs: elapsed(), outcome: failed ? 'error' : 'response' })); }
      catch { /* Diagnostics must not alter publication or retry behavior. */ }
    }
  }
}
