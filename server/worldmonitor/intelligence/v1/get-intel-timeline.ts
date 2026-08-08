import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetIntelTimelineRequest,
  GetIntelTimelineResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ApiError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import {
  intelHistoryTimeline,
  resolveLimit,
} from '../../../_shared/intel-history-client';
import { cacheSuccessfulHistoryRead, validateHistoryScope } from '../../../_shared/intel-history-contract';

/** Server-side default when the request omits `limit`. */
const DEFAULT_LIMIT = 50;

/** Hard cap — TIMELINE_MAX_LIMIT in convex/intelHistory.ts. */
const MAX_LIMIT = 200;

/**
 * GetIntelTimeline handler.
 *
 * Reverse-chronological read of the durable history store. No embedding and no
 * ranking, so unlike its two siblings this route spends nothing per request
 * beyond one Convex query.
 *
 * SCOPE IS MANDATORY. `domain` and `country` are the two indexed scopes on the
 * table; an unscoped read has no index to serve it and Convex throws, which
 * this layer could only report as an outage. Rejecting it here with a 400
 * (ApiError, surfaced by server/error-mapper.ts) tells the caller their
 * request was wrong instead of blaming the backend. buf.validate cannot
 * express "at least one of", so the check lives in code.
 *
 * A store failure returns an empty result with `upstreamUnavailable: true`
 * rather than a 5xx, so the gateway does not cache an empty timeline for the
 * slow tier's TTL. Premium-gated at the gateway via PREMIUM_RPC_PATHS +
 * ENDPOINT_ENTITLEMENTS.
 */
export const getIntelTimeline: IntelligenceServiceHandler['getIntelTimeline'] = async (
  _ctx: ServerContext,
  req: GetIntelTimelineRequest,
): Promise<GetIntelTimelineResponse> => {
  // Normalize BEFORE the scope check: a whitespace-only country would
  // otherwise satisfy "at least one scope" and then match nothing.
  const scope = validateHistoryScope(req, MAX_LIMIT);
  const { domain, country } = scope;
  if (!domain && !country) {
    throw new ApiError(400, 'At least one of domain or country is required', '');
  }

  const limit = resolveLimit(scope.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const result = await cacheSuccessfulHistoryRead('timeline', {
    domain, country, from: scope.from, to: scope.to, limit,
  }, () => intelHistoryTimeline({ ...scope, limit }));
  if (!result) {
    return { records: [], partial: false, upstreamUnavailable: true };
  }

  return { records: result.records, partial: result.partial, upstreamUnavailable: false };
};
