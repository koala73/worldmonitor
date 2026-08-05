import { timingSafeEqualSecret } from '../_crypto.js';
import { jsonResponse } from '../_json-response.js';

export const config = { runtime: 'edge' };

const SZSE_METADATA_URL = 'https://www.szse.cn/api/disc/announcement/annList?random=0.5';
const SZSE_REQUEST_TIMEOUT_MS = 12_000;
const MAX_REQUEST_BYTES = 2_048;
const MAX_WINDOW_DAYS = 92;
const DAY_MS = 86_400_000;
const EXPECTED_BODY_KEYS = Object.freeze([
  'channelCode',
  'pageNum',
  'pageSize',
  'seDate',
  'stock',
]);

export const SZSE_EGRESS_MAX_RESPONSE_BYTES = 131_072;

function isPlainObject(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function parseIsoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ''))) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

function isValidSzseEgressRequest(body) {
  if (!isPlainObject(body)) return false;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(EXPECTED_BODY_KEYS)) return false;
  if (
    !Array.isArray(body.seDate)
    || body.seDate.length !== 2
    || !Array.isArray(body.channelCode)
    || body.channelCode.length !== 1
    || body.channelCode[0] !== 'listedNotice_disc'
    || !Array.isArray(body.stock)
    || body.stock.length !== 1
    || body.stock[0] !== '300750'
    || body.pageSize !== 50
    || body.pageNum !== 1
  ) {
    return false;
  }

  const begin = parseIsoDay(body.seDate[0]);
  const end = parseIsoDay(body.seDate[1]);
  return begin != null
    && end != null
    && begin <= end
    && end - begin <= MAX_WINDOW_DAYS * DAY_MS;
}

async function readBoundedBody(message, maxBytes) {
  const contentLength = Number(message.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;

  if (!message.body?.getReader) {
    const bytes = new Uint8Array(await message.arrayBuffer());
    return bytes.byteLength <= maxBytes ? bytes : null;
  }

  const reader = message.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
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

function internalHeaders(contentType = 'application/json') {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  };
}

function upstreamFailureResponse(error) {
  const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
  return jsonResponse(
    { error: timeout ? 'upstream_timeout' : 'upstream_fetch_failed' },
    timeout ? 504 : 502,
    internalHeaders(),
  );
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse(
      { error: 'method_not_allowed' },
      405,
      { ...internalHeaders(), Allow: 'POST' },
    );
  }

  const expected = process.env.RELAY_SHARED_SECRET ?? '';
  const authorization = req.headers.get('authorization') ?? '';
  if (!expected || !(await timingSafeEqualSecret(authorization, `Bearer ${expected}`))) {
    return jsonResponse({ error: 'unauthorized' }, 401, internalHeaders());
  }

  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: 'invalid_request' }, 400, internalHeaders());
  }

  let body;
  try {
    const bytes = await readBoundedBody(req, MAX_REQUEST_BYTES);
    if (!bytes) {
      return jsonResponse({ error: 'invalid_request' }, 400, internalHeaders());
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonResponse({ error: 'invalid_request' }, 400, internalHeaders());
  }
  if (!isValidSzseEgressRequest(body)) {
    return jsonResponse({ error: 'invalid_request' }, 400, internalHeaders());
  }

  let upstream;
  try {
    upstream = await fetch(SZSE_METADATA_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Referer: 'https://www.szse.cn/',
        'Content-Type': 'application/json',
        'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(SZSE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return upstreamFailureResponse(error);
  }

  let bytes;
  try {
    bytes = await readBoundedBody(upstream, SZSE_EGRESS_MAX_RESPONSE_BYTES);
  } catch (error) {
    return upstreamFailureResponse(error);
  }
  if (!bytes) {
    return jsonResponse(
      { error: 'upstream_response_too_large' },
      502,
      internalHeaders(),
    );
  }

  return new Response(bytes, {
    status: upstream.status,
    headers: internalHeaders(upstream.headers.get('content-type') || 'application/json'),
  });
}
