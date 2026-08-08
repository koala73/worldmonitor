/**
 * RPC: executeBatch -- Runs up to 20 documented GET operations in one request.
 *
 * The generic REST batch endpoint (POST /api/batch/v1/execute): agents acting
 * on many items send an array of operations instead of looping single calls.
 * Each operation is re-dispatched as a same-origin GET through the public
 * gateway, so per-endpoint auth, entitlements, rate limits, caching, and usage
 * telemetry all apply to every sub-request exactly as if it were sent directly
 * (a batch is a transport optimization, not a quota bypass).
 */

import type {
  ServerContext,
  ExecuteBatchRequest,
  ExecuteBatchResponse,
  BatchOperation,
  BatchOperationBody,
  BatchOperationResult,
  FieldViolation,
} from '../../../../src/generated/server/worldmonitor/batch/v1/service_server';
import {
  ApiError,
  ValidationError,
} from '../../../../src/generated/server/worldmonitor/batch/v1/service_server';

export const MAX_BATCH_OPERATIONS = 20;
export const MAX_OPERATION_ID_LENGTH = 64;
export const MAX_OPERATION_PATH_LENGTH = 2048;
export const SUB_REQUEST_TIMEOUT_MS = 10_000;
// Per-operation response ceiling. Callers needing large payloads should batch
// fewer operations or trim each body with a ?jmespath= projection.
export const MAX_SUB_RESPONSE_BYTES = 1_048_576;
// Marks gateway-bound sub-requests so a batched /api/batch/* call can never
// recurse even if path validation regresses.
export const BATCH_MARKER_HEADER = 'x-wm-batch';

// Only credentials + content negotiation cross into sub-requests. Everything
// else (cookies, tracing, internal trust markers) is dropped by allowlist —
// the gateway re-derives what it needs per sub-request.
const FORWARDED_HEADERS = ['authorization', 'x-worldmonitor-key', 'x-api-key', 'accept-language'] as const;

// A batched path must name a documented RPC: /api/<domain>/v<N>/<rpc> (proto
// domains) or /api/v2/<domain>/<rpc> (partner v2). Query strings are allowed
// and pass through untouched (filters, pagination, ?jmespath= projections).
const RPC_PATH_RE = /^\/api\/[a-z][a-z0-9-]*\/v\d+\/[a-z][a-z0-9-]*$/;
const V2_PATH_RE = /^\/api\/v2\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

// The Cloudflare WAF in front of api.worldmonitor.app rejects generic
// user agents, so sub-requests always carry a descriptive one.
const DEFAULT_SUB_REQUEST_USER_AGENT =
  'WorldMonitor-Batch/1.0 (+https://www.worldmonitor.app/openapi.json)';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type ValidatedOperation = {
  id: string;
  /** Fully resolved same-origin URL, or null when the path was rejected. */
  target: URL | null;
  /** Per-operation failure reason when target is null. */
  error: 'invalid_path' | 'nested_batch' | null;
};

function validateOperations(operations: BatchOperation[], origin: string): {
  validated: ValidatedOperation[];
  violations: FieldViolation[];
} {
  const validated: ValidatedOperation[] = [];
  const violations: FieldViolation[] = [];
  const seenIds = new Set<string>();

  operations.forEach((op, index) => {
    const rawId = typeof op.id === 'string' ? op.id.trim() : '';
    const id = rawId || String(index);
    if (id.length > MAX_OPERATION_ID_LENGTH) {
      violations.push({
        field: `operations[${index}].id`,
        description: `must be at most ${MAX_OPERATION_ID_LENGTH} characters`,
      });
      return;
    }
    if (seenIds.has(id)) {
      violations.push({
        field: `operations[${index}].id`,
        description: `duplicate id "${id}" — results would be ambiguous`,
      });
      return;
    }
    seenIds.add(id);

    const path = typeof op.path === 'string' ? op.path : '';
    if (!path || path.length > MAX_OPERATION_PATH_LENGTH || !path.startsWith('/')) {
      validated.push({ id, target: null, error: 'invalid_path' });
      return;
    }

    let target: URL;
    try {
      target = new URL(path, origin);
    } catch {
      validated.push({ id, target: null, error: 'invalid_path' });
      return;
    }
    // `new URL('//evil.com/x', origin)` resolves to a foreign origin — the
    // origin equality check is the SSRF guard, the regexes are the contract.
    if (target.origin !== origin) {
      validated.push({ id, target: null, error: 'invalid_path' });
      return;
    }
    if (target.pathname.startsWith('/api/batch/')) {
      validated.push({ id, target: null, error: 'nested_batch' });
      return;
    }
    if (!RPC_PATH_RE.test(target.pathname) && !V2_PATH_RE.test(target.pathname)) {
      validated.push({ id, target: null, error: 'invalid_path' });
      return;
    }
    validated.push({ id, target, error: null });
  });

  return { validated, violations };
}

function buildSubRequestHeaders(inbound: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = inbound.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('accept', 'application/json');
  headers.set('user-agent', inbound.get('user-agent') ?? DEFAULT_SUB_REQUEST_USER_AGENT);
  headers.set(BATCH_MARKER_HEADER, '1');
  return headers;
}

async function runOperation(
  op: ValidatedOperation,
  headers: Headers,
  fetchImpl: FetchLike,
): Promise<BatchOperationResult> {
  if (!op.target) {
    return { id: op.id, status: 0, error: op.error ?? 'invalid_path' };
  }

  let response: Response;
  try {
    response = await fetchImpl(op.target.toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(SUB_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { id: op.id, status: 0, error: isTimeout ? 'timeout' : 'fetch_failed' };
  }

  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_SUB_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* already drained */ }
    return { id: op.id, status: response.status, error: 'response_too_large' };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { id: op.id, status: response.status, error: 'fetch_failed' };
  }
  if (text.length > MAX_SUB_RESPONSE_BYTES) {
    return { id: op.id, status: response.status, error: 'response_too_large' };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { id: op.id, status: response.status, error: 'invalid_json' };
  }

  return { id: op.id, status: response.status, body: body as BatchOperationBody, error: '' };
}

export function createExecuteBatch(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
) {
  return async function executeBatch(
    ctx: ServerContext,
    req: ExecuteBatchRequest,
  ): Promise<ExecuteBatchResponse> {
    // Recursion guard: the gateway forwards the marker untouched, so a batch
    // arriving with it was issued BY a batch — refuse regardless of the
    // per-path nested_batch check below.
    if (ctx.request.headers.has(BATCH_MARKER_HEADER)) {
      throw new ApiError(400, 'Nested batch requests are not allowed', '');
    }

    const operations = Array.isArray(req.operations) ? req.operations : [];
    if (operations.length < 1 || operations.length > MAX_BATCH_OPERATIONS) {
      throw new ValidationError([{
        field: 'operations',
        description: `must contain between 1 and ${MAX_BATCH_OPERATIONS} operations`,
      }]);
    }

    const origin = new URL(ctx.request.url).origin;
    const { validated, violations } = validateOperations(operations, origin);
    if (violations.length > 0) {
      throw new ValidationError(violations);
    }

    const headers = buildSubRequestHeaders(ctx.request.headers);
    const results = await Promise.all(
      validated.map((op) => runOperation(op, headers, fetchImpl)),
    );

    const succeeded = results.filter((r) => r.status >= 200 && r.status < 300 && !r.error).length;
    return { results, succeeded, failed: results.length - succeeded };
  };
}

export const executeBatch = createExecuteBatch();
