import type {
  ServerContext,
  GetSummarizeArticleCacheRequest,
  SummarizeArticleResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';

const CACHE_KEY_PATTERN = /^summary:v\d+:[a-z0-9:_-]{3,120}$/;
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
