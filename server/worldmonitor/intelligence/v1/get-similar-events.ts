import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetSimilarEventsRequest,
  GetSimilarEventsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import {
  intelHistorySearch,
  resolveLimit,
} from '../../../_shared/intel-history-client';
import { embedQueryText, normalizeQueryText } from '../../../_shared/intel-history-embed';
import {
  cacheSuccessfulHistoryRead,
  validateHistoryScope,
  validateHistoryText,
} from '../../../_shared/intel-history-contract';

/**
 * Server-side default when the request omits `limit`. Half of
 * SearchIntelHistory's default: a precedent list is read end to end by a human
 * or an LLM, not scrolled, and long tails of weak matches dilute it.
 */
const DEFAULT_LIMIT = 10;

/** Hard cap, well inside SEARCH_MAX_LIMIT in convex/intelHistory.ts. */
const MAX_LIMIT = 32;

/**
 * Matches the proto's documented `max_len`, enforced HERE because the gateway
 * supplies no `validateRequest` (server/gateway.ts) — buf.validate annotations
 * document the contract but do not run. Unclamped, an arbitrarily long string
 * would be shipped to a paid embeddings provider on every call.
 */
const MAX_SITUATION_LEN = 1000;

/** Precedents must clear a similarity floor; broad search deliberately has none. */
export const PRECEDENT_MIN_SCORE = 0.55;

/**
 * GetSimilarEvents handler.
 *
 * "Has anything like this happened before?" — the same vector search as
 * SearchIntelHistory, run over a description of a developing situation rather
 * than a search phrase, and returning a deliberately short precedent list.
 *
 * Shares SearchIntelHistory's failure posture: an embeddings-provider or
 * history-store outage returns an empty result flagged `upstreamUnavailable`
 * so the gateway does not cache it. Premium-gated and rate-limited fail-closed
 * for the same reason — every cache miss spends one embeddings call.
 */
export const getSimilarEvents: IntelligenceServiceHandler['getSimilarEvents'] = async (
  _ctx: ServerContext,
  req: GetSimilarEventsRequest,
): Promise<GetSimilarEventsResponse> => {
  const situation = validateHistoryText(req.situation, 'situation', 10, MAX_SITUATION_LEN);
  const scope = validateHistoryScope(req, MAX_LIMIT);
  const limit = resolveLimit(scope.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const result = await cacheSuccessfulHistoryRead('precedents', {
    situation: normalizeQueryText(situation), domain: scope.domain, country: scope.country,
    limit, minScore: PRECEDENT_MIN_SCORE,
  }, async () => {
    const embedding = await embedQueryText(situation);
    if (!embedding) return null;
    return intelHistorySearch({ embedding, ...scope, limit, minScore: PRECEDENT_MIN_SCORE });
  });
  if (!result) {
    return { records: [], situation, partial: false, upstreamUnavailable: true };
  }

  return { records: result.records, situation, partial: result.partial, upstreamUnavailable: false };
};
