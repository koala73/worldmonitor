const RESPONSE_HEADER_ALLOWLIST = ['cf-ray', 'x-vercel-id', 'retry-after', 'content-type'];
const MAX_ERROR_DEPTH = 3;
const MAX_ERROR_ENTRIES = 3;
const MAX_ERROR_STRING_LENGTH = 320;

function boundedText(value) {
  const text = String(value ?? '')
    .replace(/https?:\/\/[^\s]+/gi, '[url redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/\b(authorization|cookie|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ');
  return text.length > MAX_ERROR_STRING_LENGTH ? `${text.slice(0, MAX_ERROR_STRING_LENGTH)}…` : text;
}

function safeHeaderSnapshot(headers) {
  return Object.fromEntries(
    RESPONSE_HEADER_ALLOWLIST
      .map((name) => [name, headers.get(name)])
      .filter(([, value]) => value !== null),
  );
}

function boundedRpcMethod(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return boundedText(value).slice(0, 120);
}

export function safeUrlLabel(value) {
  try {
    const target = new URL(String(value));
    return `${target.protocol}//${target.host}${target.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

export function serializeSafeError(error, seen = new WeakSet(), depth = 0) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return { name: 'Error', message: boundedText(error) };
  }
  if (seen.has(error)) return { cycle: true };
  if (depth >= MAX_ERROR_DEPTH) return { truncated: true };
  seen.add(error);

  const record = {
    name: boundedText(error.name || error.constructor?.name || 'Error'),
    message: boundedText(error.message || String(error)),
  };
  if (typeof error.code === 'string' || typeof error.code === 'number') record.code = boundedText(error.code);
  if (error.cause !== undefined) record.cause = serializeSafeError(error.cause, seen, depth + 1);
  if (error.error !== undefined) record.error = serializeSafeError(error.error, seen, depth + 1);

  const nested = error.errors;
  if (nested && typeof nested[Symbol.iterator] === 'function') {
    record.errors = [];
    for (const entry of nested) {
      record.errors.push(serializeSafeError(entry, seen, depth + 1));
      if (record.errors.length === MAX_ERROR_ENTRIES) break;
    }
  }
  return record;
}

export function formatSafeError(error) {
  const safe = serializeSafeError(error);
  const parts = [safe.name, safe.code, safe.message].filter(Boolean);
  return parts.join(': ') || 'Unknown error';
}

export function createTimedFetch({
  deadlineMs,
  fetchImpl = globalThis.fetch,
  onRecord = () => {},
  userAgent,
} = {}) {
  if (!(Number.isFinite(deadlineMs) && deadlineMs > 0)) throw new Error('deadlineMs must be a positive number');
  let sequence = 0;

  return async function timedFetch(url, init = {}, context = {}) {
    const startedAt = Date.now();
    const rpcMethod = boundedRpcMethod(context.rpcMethod);
    const record = {
      sequence: ++sequence,
      group: boundedText(context.group || 'unclassified'),
      hostname: null,
      pathname: null,
      method: String(init.method || 'GET').toUpperCase(),
      ...(rpcMethod ? { rpcMethod } : {}),
      elapsedMs: 0,
      deadlineMs,
      stage: 'parse',
      status: null,
      outcome: 'transport_error',
      responseHeaders: {},
    };

    let target;
    try {
      target = new URL(url);
      record.hostname = target.hostname;
      record.pathname = target.pathname;
      record.stage = 'headers';
    } catch (error) {
      record.elapsedMs = Date.now() - startedAt;
      record.error = serializeSafeError(error);
      onRecord(record);
      throw error;
    }

    const controller = new AbortController();
    let deadlineFired = false;
    const timer = setTimeout(() => {
      deadlineFired = true;
      controller.abort();
    }, deadlineMs);

    try {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        ...init,
        headers: { ...(userAgent ? { 'User-Agent': userAgent } : {}), ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      record.status = response.status;
      record.responseHeaders = safeHeaderSnapshot(response.headers);
      record.stage = 'body';
      const text = await response.text();
      record.stage = 'complete';
      record.outcome = 'response';
      record.elapsedMs = Date.now() - startedAt;
      onRecord(record);
      return { res: response, text, ms: record.elapsedMs };
    } catch (error) {
      record.elapsedMs = Date.now() - startedAt;
      record.outcome = deadlineFired ? 'timeout' : 'transport_error';
      record.error = serializeSafeError(error);
      onRecord(record);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function validateMalformedOAuthResponse(response, text) {
  if (response.status !== 400) return { ok: false, detail: `expected HTTP 400 JSON OAuth error, got HTTP ${response.status}` };
  if (!/application\/json/i.test(response.headers.get('content-type') ?? '')) {
    return { ok: false, detail: 'HTTP 400 OAuth response lacks application/json content-type' };
  }
  try {
    const body = JSON.parse(text);
    if (typeof body?.error !== 'string' || body.error.trim() === '') {
      return { ok: false, detail: 'HTTP 400 OAuth response has no nonempty error code' };
    }
    return { ok: true, detail: `HTTP 400 ${boundedText(body.error)}` };
  } catch {
    return { ok: false, detail: 'HTTP 400 OAuth response body is not JSON' };
  }
}
