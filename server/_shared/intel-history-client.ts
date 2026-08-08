/**
 * Convex transport for the historical intelligence memory (#5694).
 *
 * Shared by the three Pro-gated RPCs in
 * server/worldmonitor/intelligence/v1/{search-intel-history,get-intel-timeline,
 * get-similar-events}.ts. Owns one concern: reading convex/intelHistory.ts
 * through its two secret-guarded internal HTTP routes, and adapting stored
 * records to the wire shape. Query embedding lives in
 * ./intel-history-embed.ts — a different upstream with its own budget and
 * failure mode.
 *
 * Every function returns `null` rather than throwing, so a store outage
 * surfaces as `upstream_unavailable: true` on a 200 — the gateway reads that
 * flag out of the body and drops the response to Cache-Control: no-store
 * (server/_shared/cache-contract.ts) instead of pinning a false-empty result
 * for the cache tier's full TTL.
 */

// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../api/_sentry-edge.js';

const CONVEX_INTERNAL_SEARCH_PATH = '/api/internal-intel-search';
const CONVEX_INTERNAL_TIMELINE_PATH = '/api/internal-intel-timeline';

/** Convex read budget, matching the entitlement gate's posture. */
const CONVEX_TIMEOUT_MS = 5_000;

let _didWarnMissingConvexSiteUrl = false;
let _didWarnMissingConvexSharedSecret = false;

/**
 * Warn once per missing variable rather than per request. Mirrors
 * server/_shared/entitlement-check.ts: a deploy missing only one of the pair
 * would otherwise disable these routes with no signal in the logs.
 */
function getConvexSiteUrl(): string {
  const siteUrl = process.env.CONVEX_SITE_URL ?? '';
  if (!siteUrl && !_didWarnMissingConvexSiteUrl) {
    _didWarnMissingConvexSiteUrl = true;
    console.warn('[intel-history] CONVEX_SITE_URL not set; history reads disabled');
  }
  return siteUrl;
}

function getConvexSharedSecret(): string {
  const secret = process.env.CONVEX_SERVER_SHARED_SECRET ?? '';
  if (!secret && !_didWarnMissingConvexSharedSecret) {
    _didWarnMissingConvexSharedSecret = true;
    console.warn('[intel-history] CONVEX_SERVER_SHARED_SECRET not set; history reads disabled');
  }
  return secret;
}

/**
 * Scope values are compared with `eq` against what the seeders wrote, so the
 * caller's casing and padding decide whether anything matches at all. A
 * request for country "ua " silently returns nothing against stored "UA" —
 * indistinguishable, to the caller, from "we have no history for Ukraine".
 * Normalize to the stored form instead of trusting the wire.
 *
 * buf.validate documents these shapes in the proto but does not run: the
 * gateway supplies no `validateRequest` (server/gateway.ts), so this is the
 * only place the contract is actually applied.
 */
export function normalizeCountry(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function normalizeDomain(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Scope accepted by both read routes. Absent fields are omitted from the
 * request body entirely: convex/http.ts distinguishes "field absent" from
 * "field present but empty", and the timeline route rejects an unscoped read.
 */
export interface IntelHistoryScope {
  domain?: string;
  country?: string;
  from?: number;
  to?: number;
  limit: number;
}

/** One record as convex/intelHistory.ts:projectRecord emits it. */
interface WireRecord {
  id?: unknown;
  domain?: unknown;
  resource?: unknown;
  country?: unknown;
  category?: unknown;
  title?: unknown;
  summary?: unknown;
  sourceUrl?: unknown;
  occurredAt?: unknown;
  ingestedAt?: unknown;
  _score?: unknown;
}

/**
 * Structural mirror of the generated `IntelHistoryRecord` (proto
 * intel_history_record.proto). Declared here rather than imported so this
 * module stays independent of src/generated; the handlers assign these into
 * the generated response types, so any proto field change fails typecheck at
 * the call sites.
 */
export interface IntelHistoryRecordView {
  id: string;
  domain: string;
  resource: string;
  country: string;
  category: string;
  title: string;
  summary: string;
  sourceUrl: string;
  occurredAt: number;
  ingestedAt: number;
  score: number;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Adapt one stored record to the wire shape. `_score` is present only on the
 * vector path; a chronological read leaves it 0, which the proto documents as
 * "no similarity applies" rather than "no similarity".
 */
function toIntelHistoryRecord(raw: WireRecord): IntelHistoryRecordView {
  return {
    id: str(raw.id),
    domain: str(raw.domain),
    resource: str(raw.resource),
    country: str(raw.country),
    category: str(raw.category),
    title: str(raw.title),
    summary: str(raw.summary),
    sourceUrl: str(raw.sourceUrl),
    occurredAt: num(raw.occurredAt),
    ingestedAt: num(raw.ingestedAt),
    score: num(raw._score),
  };
}

/**
 * Resolve a request limit: the server-side default when omitted or <= 0,
 * otherwise the requested value capped at the route's ceiling. The ceilings
 * mirror the clamps in convex/intelHistory.ts, so a caller never receives
 * fewer rows than the API documents without an explanation.
 */
export function resolveLimit(requested: unknown, fallback: number, max: number): number {
  const value = Number(requested);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

/**
 * Drop empty scope fields so convex/http.ts sees them as absent.
 *
 * `0` means "no bound" per the published contract, so it is omitted rather
 * than sent. Any other finite value is forwarded verbatim — including a
 * negative, which is a legitimate pre-1970 epoch bound and which the MCP tool
 * layer explicitly forwards on the promise that the route is the sole
 * authority on bounds. Silently discarding it here would break that promise.
 */
function scopeBody(scope: IntelHistoryScope): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (scope.domain) body.domain = scope.domain;
  if (scope.country) body.country = scope.country;
  if (typeof scope.from === 'number' && Number.isFinite(scope.from) && scope.from !== 0) {
    body.from = scope.from;
  }
  if (typeof scope.to === 'number' && Number.isFinite(scope.to) && scope.to !== 0) {
    body.to = scope.to;
  }
  body.limit = scope.limit;
  return body;
}

/**
 * POST one of the two secret-guarded internal read routes. Returns null on a
 * missing configuration, a non-2xx, a malformed body, or a timeout — the
 * caller turns that into `upstream_unavailable`.
 */
async function readIntelHistory(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ records: IntelHistoryRecordView[]; partial: boolean } | null> {
  const siteUrl = getConvexSiteUrl();
  const sharedSecret = getConvexSharedSecret();
  if (!siteUrl || !sharedSecret) return null;

  try {
    const resp = await fetch(`${siteUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-gateway/1.0',
        'x-convex-shared-secret': sharedSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CONVEX_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[intel-history] ${path} returned HTTP ${resp.status}`);
      return null;
    }
    const body = (await resp.json()) as { records?: unknown; partial?: unknown };
    if (!Array.isArray(body?.records)) {
      console.warn(`[intel-history] ${path} returned no records array`);
      return null;
    }
    return {
      records: (body.records as WireRecord[])
        .filter((rec): rec is WireRecord => rec !== null && typeof rec === 'object')
        .map(toIntelHistoryRecord),
      partial: body.partial === true,
    };
  } catch (err) {
    // Same reasoning as the embed path: a Convex outage surfaces to the caller
    // as an empty 200, so it has to reach Sentry to be distinguishable.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[intel-history] ${path} failed: ${msg}`);
    captureSilentError(err, {
      tags: { surface: 'server', component: 'intel-history', stage: 'convex-read' },
      fingerprint: ['intel-history', 'convex-read-error', path],
    });
    return null;
  }
}

/** Semantic read: rank stored history against a query vector. */
export function intelHistorySearch(
  params: IntelHistoryScope & { embedding: number[]; minScore?: number },
): Promise<{ records: IntelHistoryRecordView[]; partial: boolean } | null> {
  const { embedding, minScore, ...scope } = params;
  return readIntelHistory(CONVEX_INTERNAL_SEARCH_PATH, {
    embedding,
    ...scopeBody(scope),
    ...(typeof minScore === 'number' ? { minScore } : {}),
  });
}

/**
 * Chronological read. At least one of domain/country must be set — the caller
 * enforces that and returns 400, because Convex answers an unscoped read with
 * a 500 that this layer could only report as an outage.
 */
export function intelHistoryTimeline(
  scope: IntelHistoryScope,
): Promise<{ records: IntelHistoryRecordView[]; partial: boolean } | null> {
  return readIntelHistory(CONVEX_INTERNAL_TIMELINE_PATH, scopeBody(scope));
}
