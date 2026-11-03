import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

export const TENDER_RECEIPTS_KEY = 'economic:global-tenders:run-history:v1';
export const TENDER_RECEIPT_LIMIT = 72;
const REQUEST_LIMIT = 32;
const RECEIPT_TTL_SECONDS = 7 * 24 * 60 * 60;
const sourceContext = new AsyncLocalStorage();
const responseReceipts = new WeakMap();
const FAILURE_CODES = new Set([
  'TimeoutError', 'AbortError', 'SyntaxError', 'ETIMEDOUT', 'ECONNRESET',
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

function failureCode(error) {
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) return `HTTP_${error.status}`;
  for (const code of [error?.cause?.code, error?.code, error?.name]) {
    if (FAILURE_CODES.has(code)) return code;
  }
  return 'unknown';
}

export function createTenderReceipt(now = Date.now()) {
  return {
    schemaVersion: 1, runId: randomUUID(), startedAt: new Date(now).toISOString(),
    completedAt: null, publication: { state: 'unconfirmed', publishedAt: null, seedRunId: null }, sources: [],
  };
}

export async function observeTenderSource(source, fetchSource, options, receipt) {
  const entry = { source, startedAt: new Date().toISOString(), requestCount: 0, requestsTruncated: false, requests: [] };
  receipt.sources.push(entry);
  return sourceContext.run(entry, async () => {
    try {
      const result = await fetchSource(options);
      entry.outcome = result.status.paced ? 'paced' : result.status.state;
      entry.fetchedCount = entry.outcome === 'ok' ? result.records.length : 0;
      return result;
    } catch (error) {
      entry.outcome = 'error';
      entry.fetchedCount = 0;
      entry.failure = failureCode(error);
      throw error;
    } finally {
      entry.completedAt = new Date().toISOString();
    }
  });
}

export function recordTenderBucket(bucket) {
  const entry = sourceContext.getStore();
  if (entry) entry.bucket = structuredClone(bucket);
}

export async function observeTenderRequest(url, options, transport) {
  const entry = sourceContext.getStore();
  if (!entry) return transport(url, options);
  entry.requestCount += 1;
  const request = {
    attempt: entry.requestCount, host: new URL(url).hostname,
    startedAt: new Date().toISOString(), timeoutMs: options.timeoutMs, phase: 'headers', status: null,
  };
  if (entry.requests.length < REQUEST_LIMIT) entry.requests.push(request);
  else entry.requestsTruncated = true;
  try {
    const response = await transport(url, options);
    request.status = response.status;
    if (response.ok) {
      responseReceipts.set(response, request);
      request.phase = 'body';
    } else {
      request.failure = `HTTP_${response.status}`;
      request.completedAt = new Date().toISOString();
    }
    return response;
  } catch (error) {
    request.failure = failureCode(error);
    request.completedAt = new Date().toISOString();
    throw error;
  }
}

export async function readTenderBody(response, kind) {
  const request = responseReceipts.get(response);
  try {
    const body = await response[kind]();
    if (request) request.phase = 'complete';
    return body;
  } catch (error) {
    if (request) request.failure = failureCode(error);
    throw error;
  } finally {
    if (request) request.completedAt = new Date().toISOString();
  }
}

export function completeTenderReceipt(receipt, snapshot) {
  receipt.completedAt = new Date().toISOString();
  for (const entry of receipt.sources) {
    const status = snapshot.sourceStatuses.find((status) => status.source === entry.source);
    entry.effectiveState = status?.state;
    entry.lastSuccessfulAt = status?.lastSuccessfulAt || null;
    entry.retainedCount = entry.outcome === 'ok' ? 0
      : snapshot.tenders.filter((tender) => tender.source === entry.source).length;
  }
}

const UPSERT_RECEIPT = `
local entries = redis.call('LRANGE', KEYS[1], 0, -1)
for index, value in ipairs(entries) do
  if cjson.decode(value).runId == ARGV[1] then
    redis.call('LSET', KEYS[1], index - 1, ARGV[2])
    redis.call('EXPIRE', KEYS[1], ARGV[4])
    return 1
  end
end
redis.call('LPUSH', KEYS[1], ARGV[2])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[3]) - 1)
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

export async function writeTenderReceipt(receipt) {
  const creds = getOptionalUpstashCreds();
  if (!creds) throw new Error('Procurement run history requires Redis credentials');
  try {
    await upstashCommand(creds, ['EVAL', UPSERT_RECEIPT, '1', TENDER_RECEIPTS_KEY,
      receipt.runId, JSON.stringify(receipt), String(TENDER_RECEIPT_LIMIT), String(RECEIPT_TTL_SECONDS)]);
  } catch (error) {
    // Retrying an observation write must not repeat provider requests.
    error.nonRetryable = true;
    throw error;
  }
}
