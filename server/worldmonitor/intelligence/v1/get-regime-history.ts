import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetRegimeHistoryRequest,
  GetRegimeHistoryResponse,
  RegimeTransition,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

const KEY_PREFIX = 'intelligence:regime-history:v1:';

/** Hard cap on returned entries — matches the writer-side LTRIM cap in
 *  scripts/regional-snapshot/regime-history.mjs (REGIME_HISTORY_MAX). */
const MAX_LIMIT = 100;

/** Server-side default when the request omits `limit`. */
const DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Persisted shape (written by scripts/regional-snapshot/regime-history.mjs
// as JSON strings into a Redis list under intelligence:regime-history:v1:{region}).
// Each list item is an independently JSON-encoded object; LRANGE returns
// them as an array of strings.
// ---------------------------------------------------------------------------

interface PersistedTransition {
  region_id?: string;
  label?: string;
  previous_label?: string;
  transitioned_at?: number;
  transition_driver?: string;
  snapshot_id?: string;
}

/**
 * Adapt a persisted transition (snake_case) to the proto wire shape (camelCase).
 * Exported for unit testing.
 */
export function adaptTransition(raw: PersistedTransition): RegimeTransition {
  return {
    regionId: raw.region_id ?? '',
    label: raw.label ?? '',
    previousLabel: raw.previous_label ?? '',
    transitionedAt: typeof raw.transitioned_at === 'number' ? raw.transitioned_at : 0,
    transitionDriver: raw.transition_driver ?? '',
    snapshotId: raw.snapshot_id ?? '',
  };
}

/**
 * Execute an LRANGE against the Upstash Redis REST API. Returns the raw
 * string array (one JSON-encoded transition per entry) or null on failure.
 * Inlined here because server/_shared/redis.ts has no list helpers yet and
 * this is the first list-reading handler in the intelligence service.
 */
async function redisLrange(key: string, start: number, stop: number): Promise<string[] | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(
      `${url}/lrange/${encodeURIComponent(key)}/${start}/${stop}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result?: string[] };
    return Array.isArray(data.result) ? data.result : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[regime-history] LRANGE failed for ${key}: ${msg}`);
    return null;
  }
}

/**
 * GetRegimeHistory handler.
 *
 * Reads the append-only transition log at
 * `intelligence:regime-history:v1:{regionId}`, newest-first (the writer
 * LPUSHes so position 0 is the most recent entry).
 *
 * Empty list → empty response (200 with transitions: []), so the client
 * can distinguish "region has never changed regime" from an error.
 *
 * Redis/network failure → response includes `upstreamUnavailable: true`.
 * The gateway detects this flag in the response body and sets
 * `Cache-Control: no-store` so a transient Upstash outage is not pinned
 * as a false-empty history until the cache TTL expires (PR #2981 review).
 *
 * Premium-gated at the gateway layer via PREMIUM_RPC_PATHS and cached at
 * the 'slow' tier in RPC_CACHE_TIER, matching get-regional-snapshot.
 */
export const getRegimeHistory: IntelligenceServiceHandler['getRegimeHistory'] = async (
  _ctx: ServerContext,
  req: GetRegimeHistoryRequest,
): Promise<GetRegimeHistoryResponse> => {
  const regionId = req.regionId;
  if (!regionId || typeof regionId !== 'string') {
    return { transitions: [] };
  }

  // Resolve limit: server-side default when missing/zero, hard cap at MAX_LIMIT
  // (matches the writer-side LTRIM cap so there's never more than that in Redis).
  const requestedLimit = Number(req.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const key = `${KEY_PREFIX}${regionId}`;
  const raw = await redisLrange(key, 0, limit - 1);
  if (!raw) {
    // Redis failure or missing credentials — signal to the gateway that this
    // is a transient upstream issue, not a genuine "no history" result. The
    // gateway checks for `"upstreamUnavailable":true` in the body and sets
    // Cache-Control: no-store so the failure isn't cached for the full TTL.
    return { transitions: [], upstreamUnavailable: true } as GetRegimeHistoryResponse & { upstreamUnavailable: boolean };
  }

  const transitions: RegimeTransition[] = [];
  for (const entry of raw) {
    try {
      const parsed = JSON.parse(entry) as PersistedTransition;
      if (parsed && typeof parsed === 'object') {
        transitions.push(adaptTransition(parsed));
      }
    } catch {
      // Skip malformed entries — log per dropped entry.
      console.warn(`[regime-history] dropped malformed entry for ${regionId}`);
    }
  }

  return { transitions };
};
