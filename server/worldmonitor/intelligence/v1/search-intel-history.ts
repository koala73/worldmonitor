import type {
  IntelligenceServiceHandler,
  ServerContext,
  SearchIntelHistoryRequest,
  SearchIntelHistoryResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import {
  intelHistorySearch,
  resolveLimit,
} from '../../../_shared/intel-history-client';
import {
  embedQueryText,
  normalizeQueryText,
} from '../../../_shared/intel-history-embed';
import {
  cacheSuccessfulHistoryRead,
  validateHistoryScope,
  validateHistoryText,
} from '../../../_shared/intel-history-contract';

/** Server-side default when the request omits `limit`. */
const DEFAULT_LIMIT = 20;

/** Hard cap — SEARCH_MAX_LIMIT in convex/intelHistory.ts. */
const MAX_LIMIT = 64;

/**
 * Matches the proto's documented `max_len`, enforced HERE because the gateway
 * supplies no `validateRequest` (server/gateway.ts) — buf.validate annotations
 * document the contract but do not run. Unclamped, an arbitrarily long string
 * would be shipped to a paid embeddings provider on every call.
 */
const MAX_QUERY_LEN = 500;

/**
 * SearchIntelHistory handler.
 *
 * Embeds the caller's query, then ranks the durable history store
 * (convex/intelHistory.ts) against that vector. Pure read: nothing is written
 * back to Redis, which keeps the route's MCP parity classification clean.
 *
 * Either upstream failing — the embeddings provider or the history store —
 * returns an empty result with `upstreamUnavailable: true` rather than a 5xx,
 * so the gateway serves the response with Cache-Control: no-store instead of
 * caching an empty history for the slow tier's TTL. The embedding failure is
 * checked first and short-circuits: searching with a substitute vector would
 * return arbitrary rows presented as genuine matches.
 *
 * Premium-gated at the gateway via PREMIUM_RPC_PATHS + ENDPOINT_ENTITLEMENTS,
 * and rate-limited fail-closed (server/_shared/rate-limit.ts) because every
 * cache miss spends one embeddings call.
 */
export const searchIntelHistory: IntelligenceServiceHandler['searchIntelHistory'] = async (
  _ctx: ServerContext,
  req: SearchIntelHistoryRequest,
): Promise<SearchIntelHistoryResponse> => {
  const query = validateHistoryText(req.query, 'query', 2, MAX_QUERY_LEN);
  const scope = validateHistoryScope(req, MAX_LIMIT);
  const limit = resolveLimit(scope.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const result = await cacheSuccessfulHistoryRead('search', {
    query: normalizeQueryText(query), domain: scope.domain, country: scope.country,
    from: scope.from, to: scope.to, limit,
  }, async () => {
    const embedding = await embedQueryText(query);
    if (!embedding) return null;
    return intelHistorySearch({ embedding, ...scope, limit });
  });
  if (!result) {
    return { records: [], query, partial: false, upstreamUnavailable: true };
  }

  return { records: result.records, query, partial: result.partial, upstreamUnavailable: false };
};
