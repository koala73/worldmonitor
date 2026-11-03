import { randomUUID } from 'node:crypto';

const REDACTED_RE = /(https?:\/\/)[^\s/]*@/gi;
const REDACTED_RE_2 = /\b(Bearer|Basic)\s+[^\s,;"']+/gi;
const REDACTED_RE_3 = /([?&])([^=\s?&#"']+)=([^\s&#"']*)/g;
const REDACTED_RE_4 = /(["']?(?:token|api[_-]?key|access_token|password|secret|signature)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi;


const QUERY_FIELDS = [
  'where', 'outFields', 'orderByFields', 'resultOffset', 'resultRecordCount',
  'outStatistics', 'returnGeometry', 'outSR', 'f',
];
const RESPONSE_HEADERS = ['content-type', 'date', 'retry-after', 'x-esri-request-id', 'x-request-id', 'cf-ray'];
const MAX_ERROR_BODY_BYTES = 64 * 1024;

function safeText(value, maxBytes = 256) {
  const redacted = String(value ?? '')
    .replace(REDACTED_RE, '$1[redacted]@')
    .replace(REDACTED_RE_2, '$1 [redacted]')
    .replace(REDACTED_RE_3, (match, separator, name) =>
      QUERY_FIELDS.includes(name) ? match : `${separator}${name}=[redacted]`)
    .replace(REDACTED_RE_4, '$1[redacted]');
  const buffer = Buffer.from(redacted);
  return buffer.length > maxBytes
    ? `${buffer.subarray(0, maxBytes).toString('utf8')} [truncated]` : redacted;
}

function errorCauses(error) {
  const causes = [];
  const pending = [{ error, parent: null }];
  const seen = new Set();
  while (pending.length && causes.length < 4) {
    const { error: current, parent } = pending.shift();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    const index = causes.length;
    const entry = {
      parent,
      name: safeText(current.name, 64),
      message: safeText(current.message ?? current),
      code: safeText(current.code, 64),
      stage: safeText(current.stage, 64),
    };
    if (current.proxyFailure) {
      entry.proxyFailure = {
        stage: safeText(current.proxyFailure.stage, 64),
        httpStatus: current.proxyFailure.httpStatus ?? null,
        proxyConnectStatus: current.proxyFailure.proxyConnectStatus ?? null,
      };
    }
    causes.push(entry);
    if (current.cause) pending.push({ error: current.cause, parent: index });
    if (Array.isArray(current.errors)) {
      for (const child of current.errors.slice(0, 3)) pending.push({ error: child, parent: index });
    }
  }
  return causes;
}

export function createPortwatchRequestTrace(url, route) {
  const started = Date.now();
  const requestId = randomUUID();
  let endpoint;
  const query = {};
  try {
    const parsed = new URL(url);
    endpoint = safeText(`${parsed.origin}${parsed.pathname}`);
    for (const name of QUERY_FIELDS) {
      if (parsed.searchParams.has(name)) query[name] = safeText(parsed.searchParams.get(name), 384);
    }
  } catch {
    endpoint = 'invalid-url';
  }

  return {
    fail(error, { phase, response, arcgisError } = {}) {
      try {
        if (arcgisError == null && Buffer.isBuffer(response?.buffer) && response.buffer.length <= MAX_ERROR_BODY_BYTES) {
          try {
            arcgisError = JSON.parse(response.buffer.toString('utf8'))?.error;
          } catch {
            arcgisError = undefined;
          }
        }
        const finished = Date.now();
        const headers = {};
        for (const name of RESPONSE_HEADERS) {
          const value = typeof response?.headers?.get === 'function'
            ? response.headers.get(name) : response?.headers?.[name];
          if (value != null) headers[name] = safeText(value, 128);
        }
        const record = {
          event: 'portwatch_request_failure',
          requestId, route, phase, endpoint, query,
          startedAt: new Date(started).toISOString(),
          finishedAt: new Date(finished).toISOString(),
          durationMs: Math.max(0, finished - started),
          status: response?.status ?? (error?.proxyConnect ? null : error?.status ?? null),
          headers,
          causes: errorCauses(error),
        };
        if (arcgisError != null) {
          record.arcgisError = {
            code: typeof arcgisError.code === 'number' ? arcgisError.code : safeText(arcgisError.code, 64),
            message: safeText(arcgisError.message),
            details: Array.isArray(arcgisError.details)
              ? arcgisError.details.slice(0, 4).map((detail) => safeText(detail)) : [],
          };
        }
        console.warn(JSON.stringify(record));
      } catch {
        return;
      }
    },
  };
}
