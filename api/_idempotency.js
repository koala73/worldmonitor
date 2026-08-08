import { redisPipeline } from './_upstash-json.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

const KEY_MAX_LENGTH = 255;
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const PROCESSING_TTL_SECONDS = 180;
const DEFAULT_COMPLETED_TTL_SECONDS = 24 * 60 * 60;
const MAX_STORED_BODY_BYTES = 256 * 1024;
const PROCESSING_MARKER = JSON.stringify({ state: 'processing' });

export function isValidIdempotencyKey(key) {
  return typeof key === 'string' && key.length <= KEY_MAX_LENGTH && KEY_PATTERN.test(key);
}

async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function anonScope(request) {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() ||
    'unknown';
  return `ip:${ip}`;
}

function jsonResponse(status, body, corsHeaders, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function isReplayableTextBody(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('json') || ct.startsWith('text/');
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function getRequestHashAndRedisKey(request, pathname, scope, idempotencyKey) {
  try {
    const bodyBuf = await request.clone().arrayBuffer();
    const reqHash = await sha256Hex(bodyBuf);
    const effectiveScope = scope || anonScope(request);
    const redisKey = `idem:v1:${await sha256Hex(`${effectiveScope}\n${pathname}\n${idempotencyKey}`)}`;
    return { reqHash, redisKey };
  } catch {
    return null;
  }
}

function outcomeFromStoredRecord(raw, reqHash, idempotencyKey, corsHeaders) {
  if (raw == null) return { kind: 'miss' };

  let record = null;
  if (typeof raw === 'string') {
    try {
      record = JSON.parse(raw);
    } catch {
      record = null;
    }
  }

  if (!record || typeof record !== 'object') return { kind: 'disabled' };

  if (record.state === 'processing') {
    return {
      kind: 'conflict',
      response: jsonResponse(
        409,
        {
          error: 'idempotency_conflict',
          message: `A request with this ${IDEMPOTENCY_HEADER} is still being processed. Retry shortly.`,
        },
        corsHeaders,
        { 'Retry-After': '2', [IDEMPOTENCY_HEADER]: idempotencyKey },
      ),
    };
  }

  if (record.state !== 'completed') return { kind: 'disabled' };

  if (record.reqHash !== reqHash) {
    return {
      kind: 'mismatch',
      response: jsonResponse(
        422,
        {
          error: 'idempotency_key_reused',
          message: `This ${IDEMPOTENCY_HEADER} was already used with a different request body.`,
        },
        corsHeaders,
        { [IDEMPOTENCY_HEADER]: idempotencyKey },
      ),
    };
  }

  return {
    kind: 'replay',
    response: new Response(record.body, {
      status: record.status,
      headers: {
        'Content-Type': record.contentType ?? 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders,
        [IDEMPOTENCY_HEADER]: idempotencyKey,
        [IDEMPOTENT_REPLAYED_HEADER]: 'true',
      },
    }),
  };
}

async function releaseProcessingLock(redisKey) {
  await redisPipeline([['DEL', redisKey]]);
}

export async function peekStandaloneIdempotency({
  request,
  pathname,
  scope,
  idempotencyKey,
  corsHeaders,
}) {
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return {
      kind: 'invalid',
      response: jsonResponse(
        400,
        {
          error: 'invalid_idempotency_key',
          message: `The ${IDEMPOTENCY_HEADER} header must be 1-${KEY_MAX_LENGTH} printable ASCII characters.`,
        },
        corsHeaders,
      ),
    };
  }

  const resolved = await getRequestHashAndRedisKey(request, pathname, scope, idempotencyKey);
  if (!resolved) return { kind: 'disabled' };

  const pipeline = await redisPipeline([['GET', resolved.redisKey]]);
  if (!pipeline || pipeline.length < 1) return { kind: 'disabled' };

  const entry = pipeline[0];
  if (entry?.error) return { kind: 'disabled' };

  return outcomeFromStoredRecord(entry?.result, resolved.reqHash, idempotencyKey, corsHeaders);
}

export async function beginStandaloneIdempotency({
  request,
  pathname,
  scope,
  idempotencyKey,
  corsHeaders,
  completedTtlSeconds = DEFAULT_COMPLETED_TTL_SECONDS,
}) {
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return {
      kind: 'invalid',
      response: jsonResponse(
        400,
        {
          error: 'invalid_idempotency_key',
          message: `The ${IDEMPOTENCY_HEADER} header must be 1-${KEY_MAX_LENGTH} printable ASCII characters.`,
        },
        corsHeaders,
      ),
    };
  }

  const resolved = await getRequestHashAndRedisKey(request, pathname, scope, idempotencyKey);
  if (!resolved) return { kind: 'disabled' };

  const pipeline = await redisPipeline([
    ['SET', resolved.redisKey, PROCESSING_MARKER, 'NX', 'EX', String(PROCESSING_TTL_SECONDS)],
    ['GET', resolved.redisKey],
  ]);
  if (!pipeline || pipeline.length < 2) return { kind: 'disabled' };

  const claim = pipeline[0];
  if (claim?.error) return { kind: 'disabled' };

  if (claim?.result === 'OK') {
    return {
      kind: 'proceed',
      key: idempotencyKey,
      store: (status, body, contentType) =>
        storeStandaloneResult(resolved.redisKey, status, body, contentType, resolved.reqHash, completedTtlSeconds),
    };
  }

  const outcome = outcomeFromStoredRecord(pipeline[1]?.result, resolved.reqHash, idempotencyKey, corsHeaders);
  return outcome.kind === 'miss' ? { kind: 'disabled' } : outcome;
}

export function getIdempotencyKey(request) {
  return request.headers.get(IDEMPOTENCY_HEADER);
}

export async function completeStandaloneIdempotency(idempotency, response) {
  if (!idempotency || idempotency.kind !== 'proceed') return response;

  const body = await response.arrayBuffer();
  await idempotency.store(response.status, body, response.headers.get('content-type'));

  const headers = new Headers(response.headers);
  headers.set(IDEMPOTENCY_HEADER, idempotency.key);
  headers.set(IDEMPOTENT_REPLAYED_HEADER, 'false');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function storeStandaloneResult(redisKey, status, body, contentType, reqHash, completedTtlSeconds) {
  try {
    if (
      isRetryableStatus(status) ||
      body.byteLength > MAX_STORED_BODY_BYTES ||
      !isReplayableTextBody(contentType)
    ) {
      await releaseProcessingLock(redisKey);
      return;
    }

    const record = {
      state: 'completed',
      status,
      contentType,
      reqHash,
      body: new TextDecoder().decode(body),
    };
    const pipeline = await redisPipeline([
      ['SET', redisKey, JSON.stringify(record), 'EX', String(completedTtlSeconds)],
    ]);
    const setResult = pipeline?.[0];
    if (setResult?.error || setResult?.result !== 'OK') await releaseProcessingLock(redisKey);
  } catch {
    try {
      await releaseProcessingLock(redisKey);
    } catch {
      // Ignore release failures; the processing marker has a short TTL.
    }
  }
}
