/**
 * Idempotency-Key support for mutation (POST) endpoints.
 *
 * Agents retry on network failures. Without idempotency a retry can duplicate a
 * side effect — a second scenario job enqueued, a baseline observation applied
 * twice, a duplicate lead created. This module lets a client opt in by sending
 * an `Idempotency-Key` header on a POST: the first request executes and its
 * response is cached; a retry carrying the same key replays the original
 * response instead of executing again.
 *
 * Semantics (a subset of the Stripe / IETF `Idempotency-Key` conventions):
 *   - First request with a key         → execute, cache the response, echo the
 *                                         key + `Idempotent-Replayed: false`.
 *   - Retry, original completed         → replay cached status+body,
 *                                         `Idempotent-Replayed: true`.
 *   - Retry, original still in-flight   → 409 (a concurrent duplicate).
 *   - Same key, different request body  → 422 (accidental key reuse).
 *   - Malformed key                     → 400.
 *
 * Scope: keys are namespaced by the resolved caller principal so one caller's
 * key can never replay another caller's response. Storage is Upstash Redis via
 * the shared {@link runRedisPipeline} (uniform env key-prefixing + fail-open).
 *
 * Fail-open: any Redis unavailability degrades to executing the request without
 * idempotency rather than blocking it. Idempotency is a retry-safety
 * convenience, not an auth gate — a Redis outage must not 500 legitimate
 * traffic. 5xx responses are never cached (they release the lock) so a retry
 * after a transient upstream failure can still succeed.
 */

import { runRedisPipeline } from './redis';

/** Canonical header name. Matched case-insensitively by `Headers.get`. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** Header echoed on the response indicating whether it was replayed. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

// Printable-ASCII, 1..255 chars — matches the `maxLength: 255` we publish in
// the OpenAPI spec (scripts/openapi-inject-idempotency.mjs). UUIDs, ULIDs, and
// opaque tokens all fit; control chars / whitespace / oversized keys are
// rejected so a malformed header can't poison the keyspace.
const KEY_MAX_LENGTH = 255;
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

// In-flight lock TTL. Must exceed the slowest mutation handler's own timeout
// (deduct-situation caps at 120s) so the lock never lapses mid-execution and
// let a concurrent retry re-run. If a handler crashes without storing, the
// lock auto-expires and a later retry re-executes.
const PROCESSING_TTL_SECONDS = 180;
// Replay window for a completed response — the standard 24h idempotency window.
const COMPLETED_TTL_SECONDS = 24 * 60 * 60;
// Don't cache oversized bodies (the documented POST responses are small JSON);
// above this we release the lock so a retry re-executes rather than storing MB
// in Redis.
const MAX_STORED_BODY_BYTES = 256 * 1024;

const PROCESSING_MARKER = JSON.stringify({ state: 'processing' });

// The replay contract is intentionally: same status + body + Content-Type.
// Other handler-set response headers (e.g. an ad-hoc X-Request-Id) are NOT
// reproduced on replay — the documented POST mutations carry their result in
// the JSON body, and replaying stale per-request headers would be misleading.
// This mirrors the "status + body" guarantee of typical Idempotency-Key layers.
interface CompletedRecord {
  state: 'completed';
  status: number;
  contentType: string | null;
  reqHash: string;
  body: string;
}

/**
 * Result of {@link beginIdempotency}. The gateway returns `response` directly
 * for the terminal kinds; for `proceed` it must call `store()` with the final
 * response once the handler has run, and for `disabled` it proceeds unchanged.
 */
export type IdempotencyOutcome =
  | { kind: 'disabled' }
  | { kind: 'invalid'; response: Response }
  | { kind: 'replay'; response: Response }
  | { kind: 'conflict'; response: Response }
  | { kind: 'mismatch'; response: Response }
  | {
      kind: 'proceed';
      key: string;
      /**
       * Persist the completed response for replay (or release the lock on a
       * 5xx / oversized body). Best-effort; never throws.
       */
      store: (status: number, body: ArrayBuffer, contentType: string | null) => Promise<void>;
    };

type IdempotencyTerminalOutcome = Exclude<IdempotencyOutcome, { kind: 'proceed' }>;

export type IdempotencyPeekOutcome = IdempotencyTerminalOutcome | { kind: 'miss' };

export interface BeginIdempotencyArgs {
  /** The matched POST request. Its body is read via `.clone()` for hashing. */
  request: Request;
  /** Normalized route path — part of the Redis key namespace. */
  pathname: string;
  /** Resolved caller principal, or null for anonymous (falls back to IP). */
  scope: string | null;
  /** Raw `Idempotency-Key` header value. */
  idempotencyKey: string;
  /** CORS headers to attach to any short-circuit response. */
  corsHeaders: Record<string, string>;
}

export function isValidIdempotencyKey(key: string): boolean {
  return key.length <= KEY_MAX_LENGTH && KEY_PATTERN.test(key);
}

export const IDEMPOTENCY_KEY_PATTERN = '^[\\x21-\\x7e]{1,255}$';

async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isReplayableTextBody(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  // Only round-trip bodies we can faithfully store as a JS string. Every
  // documented POST returns JSON; anything else is skipped (lock released) so a
  // retry re-executes rather than replaying a corrupted (mis-decoded) body.
  return ct.includes('json') || ct.startsWith('text/');
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Best-effort anonymous scope from edge IP headers (Cloudflare → Vercel).
 * Public POST mutations (leads/submit-contact, leads/register-interest) have no
 * principal, so two anon callers behind the same NAT could share a scope — but
 * a same-key/same-body collision replays an identical deterministic response,
 * and a same-key/different-body collision is caught by the 422 body-hash guard,
 * so this is safe (not a cross-caller data leak).
 */
function anonScope(request: Request): string {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() ||
    'unknown';
  return `ip:${ip}`;
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  corsHeaders: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Response {
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

async function getRequestHashAndRedisKey(
  request: Request,
  pathname: string,
  scope: string | null,
  idempotencyKey: string,
): Promise<{ reqHash: string; redisKey: string } | null> {
  try {
    const bodyBuf = await request.clone().arrayBuffer();
    const reqHash = await sha256Hex(bodyBuf);
    const effectiveScope = scope || anonScope(request);
    // Hash the composite so client-controlled key material never lands in the
    // Redis keyspace verbatim and delimiter collisions are impossible.
    const redisKey = `idem:v1:${await sha256Hex(`${effectiveScope}\n${pathname}\n${idempotencyKey}`)}`;
    return { reqHash, redisKey };
  } catch {
    // Body unreadable / hashing failed → can't key the request. Fail-open.
    return null;
  }
}

function outcomeFromStoredRecord(
  raw: unknown,
  reqHash: string,
  idempotencyKey: string,
  corsHeaders: Record<string, string>,
): IdempotencyPeekOutcome {
  if (raw == null) return { kind: 'miss' };

  let record: CompletedRecord | { state: 'processing' } | null = null;
  if (typeof raw === 'string') {
    try {
      record = JSON.parse(raw);
    } catch {
      record = null;
    }
  }

  if (!record) {
    // Corrupt value or the key expired between reads. Fail-open rather than block.
    return { kind: 'disabled' };
  }

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

  // Replay the original response.
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

function isPipelineSuccess(entry: { result?: unknown; error?: unknown } | undefined, expected: unknown): boolean {
  return entry?.error == null && entry?.result === expected;
}

async function releaseProcessingLock(redisKey: string): Promise<void> {
  await runRedisPipeline([['DEL', redisKey]]);
}

/**
 * Read-only idempotency lookup used before quota/rate-limit counters. It can
 * replay an already-completed mutation or reject conflicts/mismatches without
 * charging a duplicate retry, but it never claims a fresh key.
 */
export async function peekIdempotency(args: BeginIdempotencyArgs): Promise<IdempotencyPeekOutcome> {
  const { request, pathname, scope, idempotencyKey, corsHeaders } = args;

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

  const pipeline = await runRedisPipeline([['GET', resolved.redisKey]]);
  if (pipeline.length < 1) return { kind: 'disabled' };

  const entry = pipeline[0] as { result?: unknown; error?: unknown } | undefined;
  if (entry?.error) return { kind: 'disabled' };

  return outcomeFromStoredRecord(entry?.result, resolved.reqHash, idempotencyKey, corsHeaders);
}

/**
 * Claim-or-replay for a POST carrying an `Idempotency-Key`. See module docs.
 * The caller must have already confirmed `request.method === 'POST'` and that
 * the header is present.
 */
export async function beginIdempotency(args: BeginIdempotencyArgs): Promise<IdempotencyOutcome> {
  const { request, pathname, scope, idempotencyKey, corsHeaders } = args;

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

  // Atomic claim (SET NX EX) + read-back in one round-trip. The GET reflects
  // post-SET state: after a successful claim it returns our own marker (ignored);
  // when the key already existed it returns the prior record.
  const pipeline = await runRedisPipeline([
    ['SET', resolved.redisKey, PROCESSING_MARKER, 'NX', 'EX', String(PROCESSING_TTL_SECONDS)],
    ['GET', resolved.redisKey],
  ]);

  // Empty result ⇒ Redis unavailable / not configured ⇒ fail-open.
  if (pipeline.length < 2) return { kind: 'disabled' };

  // A per-command error (mirrors claimInternalMcpReplayNonce) ⇒ fail-open
  // rather than risk a false "claimed" / "exists" verdict.
  const claim = pipeline[0] as { result?: unknown; error?: unknown } | undefined;
  if (claim?.error) return { kind: 'disabled' };

  const claimed = claim?.result === 'OK';
  if (claimed) {
    return {
      kind: 'proceed',
      key: idempotencyKey,
      store: (status, body, contentType) =>
        storeResult(resolved.redisKey, status, body, contentType, resolved.reqHash),
    };
  }

  // Key already existed — inspect the stored record.
  const raw = pipeline[1]?.result;
  const outcome = outcomeFromStoredRecord(raw, resolved.reqHash, idempotencyKey, corsHeaders);
  return outcome.kind === 'miss' ? { kind: 'disabled' } : outcome;
}

async function storeResult(
  redisKey: string,
  status: number,
  body: ArrayBuffer,
  contentType: string | null,
  reqHash: string,
): Promise<void> {
  try {
    // Never cache a transient server error, an oversized body, or a body we
    // can't faithfully round-trip through a JS string — release the lock so a
    // retry re-executes instead.
    if (
      isRetryableStatus(status) ||
      body.byteLength > MAX_STORED_BODY_BYTES ||
      !isReplayableTextBody(contentType)
    ) {
      await releaseProcessingLock(redisKey);
      return;
    }
    const record: CompletedRecord = {
      state: 'completed',
      status,
      contentType,
      reqHash,
      body: new TextDecoder().decode(body),
    };
    const pipeline = await runRedisPipeline([
      ['SET', redisKey, JSON.stringify(record), 'EX', String(COMPLETED_TTL_SECONDS)],
    ]);
    if (!isPipelineSuccess(pipeline[0] as { result?: unknown; error?: unknown } | undefined, 'OK')) {
      await releaseProcessingLock(redisKey);
    }
  } catch {
    // Best-effort persistence; a failure just means a retry re-executes.
    try {
      await releaseProcessingLock(redisKey);
    } catch {
      // Ignore release failures; the processing marker still has a short TTL.
    }
  }
}
