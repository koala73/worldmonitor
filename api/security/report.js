export const config = { runtime: 'edge' };

import { jsonResponse } from '../_json-response.js';
import { checkRateLimit } from '../_rate-limit.js';

const MAX_REPORT_BYTES = 32 * 1024;
const MAX_REPORT_ITEMS = 20;

const RESPONSE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function isSupportedContentType(value) {
  const type = value.split(';', 1)[0]?.trim().toLowerCase();
  return type === 'application/reports+json' || type === 'application/report+json' || type === 'application/json';
}

function safeOrigin(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function shortString(value, max = 120) {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function summarizeReportItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { malformed: true };
  }

  const body = item.body && typeof item.body === 'object' && !Array.isArray(item.body)
    ? item.body
    : {};

  return {
    type: shortString(item.type, 80),
    age: typeof item.age === 'number' ? item.age : undefined,
    urlOrigin: safeOrigin(item.url),
    bodyType: shortString(body.type, 80),
    disposition: shortString(body.disposition, 40),
    effectivePolicy: shortString(body.effectivePolicy, 120),
    blockedURLOrigin: safeOrigin(body.blockedURL),
    destination: shortString(body.destination, 80),
  };
}

function summarizeReports(payload) {
  const reports = Array.isArray(payload) ? payload : [payload];
  return {
    count: reports.length,
    truncated: reports.length > MAX_REPORT_ITEMS,
    reports: reports.slice(0, MAX_REPORT_ITEMS).map(summarizeReportItem),
  };
}

async function readBodyWithLimit(req) {
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REPORT_BYTES) {
    throw new Error('payload_too_large');
  }

  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > MAX_REPORT_BYTES) {
      await reader.cancel();
      throw new Error('payload_too_large');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: RESPONSE_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, RESPONSE_HEADERS);
  }

  const limited = await checkRateLimit(req, RESPONSE_HEADERS);
  if (limited) return limited;

  if (!isSupportedContentType(req.headers.get('content-type') ?? '')) {
    return jsonResponse({ error: 'Unsupported media type' }, 415, RESPONSE_HEADERS);
  }

  let text;
  try {
    text = await readBodyWithLimit(req);
  } catch (err) {
    if (err instanceof Error && err.message === 'payload_too_large') {
      return jsonResponse({ error: 'Payload too large' }, 413, RESPONSE_HEADERS);
    }
    return jsonResponse({ error: 'Invalid request body' }, 400, RESPONSE_HEADERS);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, RESPONSE_HEADERS);
  }

  console.info('[security/report]', JSON.stringify(summarizeReports(payload)));

  return new Response(null, { status: 204, headers: RESPONSE_HEADERS });
}
