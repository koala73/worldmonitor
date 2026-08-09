import type {
  ServerContext,
  GetSummarizeArticleCacheRequest,
  SummarizeArticleResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import filterParamContracts from '../../../../shared/openapi-filter-param-contracts.json';
import { CACHE_VERSION } from '../../../../src/utils/summary-cache-key';
import { getCachedJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';

const CACHE_KEY_PATTERN = new RegExp(filterParamContracts.newsSummarizeArticleCacheKeyPattern);
// #5969: the shared pattern is version-agnostic (`summary:v\d+:`), so a stale
// browser bundle still minting keys for a retired version would be served rows
// from that version — defeating the point of a CACHE_VERSION bump, which
// exists precisely because old rows were built under different semantics.
// Serve only the current namespace; anything else is a clean miss and the
// caller falls through to the RPC path, which regenerates under current rules.
const CURRENT_NAMESPACE = `summary:${CACHE_VERSION}:`;
const NEG_SENTINEL = '__WM_NEG__';

const EMPTY_MISS: SummarizeArticleResponse = {
  summary: '',
  model: '',
  provider: '',
  tokens: 0,
  fallback: true,
  error: '',
  errorType: '',
  status: 'SUMMARIZE_STATUS_UNSPECIFIED',
  statusDetail: '',
};

export async function getSummarizeArticleCache(
  ctx: ServerContext,
  req: GetSummarizeArticleCacheRequest,
): Promise<SummarizeArticleResponse> {
  const { cacheKey } = req;

  if (!cacheKey || !CACHE_KEY_PATTERN.test(cacheKey)) {
    markNoCacheResponse(ctx.request);
    return { ...EMPTY_MISS, status: 'SUMMARIZE_STATUS_ERROR', statusDetail: 'Invalid cache key', error: 'Invalid cache key', errorType: 'ValidationError' };
  }

  // A well-formed key from a retired namespace is a miss, not an error: a
  // stale client is not making a bad request, it is asking for a version we
  // no longer serve.
  if (!cacheKey.startsWith(CURRENT_NAMESPACE)) {
    markNoCacheResponse(ctx.request);
    return EMPTY_MISS;
  }

  try {
    const cached = await getCachedJson(cacheKey);

    if (cached === NEG_SENTINEL || cached === null || cached === undefined) {
      markNoCacheResponse(ctx.request);
      return EMPTY_MISS;
    }

    const data = cached as { summary?: string; model?: string; tokens?: number };
    if (!data.summary) {
      markNoCacheResponse(ctx.request);
      return EMPTY_MISS;
    }

    return {
      summary: data.summary,
      model: data.model || '',
      provider: 'cache',
      tokens: 0,
      fallback: false,
      error: '',
      errorType: '',
      status: 'SUMMARIZE_STATUS_CACHED',
      statusDetail: '',
    };
  } catch {
    markNoCacheResponse(ctx.request);
    return EMPTY_MISS;
  }
}
