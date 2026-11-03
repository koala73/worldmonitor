import type {
  SearchFactChecksRequest,
  SearchFactChecksResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { FACT_CHECK_CAVEAT } from '../../../_shared/fact-checks';
import { lookupFactChecks } from '../../../_shared/fact-check-search';

/**
 * #9094: ratings IFCN-verified fact-checkers published about claims similar
 * to this one, cited with attribution. Only an `ok` answer may be cached at
 * the CDN; a lookup that did not run is never served as "none found".
 */
export async function searchFactChecks(
  ctx: ServerContext,
  req: SearchFactChecksRequest,
): Promise<SearchFactChecksResponse> {
  const { state, factChecks } = await lookupFactChecks(req.claim);
  if (state !== 'ok') markNoCacheResponse(ctx.request);
  return { factChecks, state, caveat: FACT_CHECK_CAVEAT };
}
