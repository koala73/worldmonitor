import type {
  SearchHeadlinesRequest,
  SearchHeadlinesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { NEWS_LANGUAGES } from '../../../../src/shared/public-rpc-cache';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { SERVER_EDITIONS } from './_feeds';
import {
  HEADLINE_HISTORY_FREE_HOURS,
  HEADLINE_HISTORY_PRO_HOURS,
  HEADLINE_SEARCH_MIN_QUERY_CHARS,
  headlineQueryWords,
  searchHeadlineHistory,
} from './_headline-history';

/**
 * Cmd+K headline search over the headline history (see _headline-history.ts).
 *
 * Two routes share this function and differ only in the window, so the plan
 * decides the depth by which URL a caller may reach, never by a parameter:
 *   /search-headlines          24 hours, any dashboard session
 *   /search-headline-archive   7 days, in PREMIUM_RPC_PATHS (gateway-enforced)
 * One URL per window also means the CDN cannot hand a 7-day answer to a free
 * caller: the cached body is keyed by path and query.
 */
async function search(
  ctx: ServerContext,
  req: SearchHeadlinesRequest,
  windowHours: number,
): Promise<SearchHeadlinesResponse> {
  const words = headlineQueryWords(req.query ?? '');
  if (!words) {
    throw new ValidationError([{
      field: 'query',
      description: `must hold at least ${HEADLINE_SEARCH_MIN_QUERY_CHARS} letters or digits`,
    }]);
  }
  const variant = req.variant || 'full';
  if (!(SERVER_EDITIONS as readonly string[]).includes(variant)) {
    throw new ValidationError([{ field: 'variant', description: `must be one of: ${SERVER_EDITIONS.join(', ')}` }]);
  }
  const lang = req.lang || 'en';
  if (!NEWS_LANGUAGES.has(lang)) {
    throw new ValidationError([{ field: 'lang', description: 'must be a lowercase two-letter language code' }]);
  }
  const result = await searchHeadlineHistory(words, variant, lang, windowHours);
  // A search that did not run must not be cached as "no matches".
  if (result.state === 'unavailable') markNoCacheResponse(ctx.request);
  return result;
}

export function searchHeadlines(ctx: ServerContext, req: SearchHeadlinesRequest): Promise<SearchHeadlinesResponse> {
  return search(ctx, req, HEADLINE_HISTORY_FREE_HOURS);
}

export function searchHeadlineArchive(ctx: ServerContext, req: SearchHeadlinesRequest): Promise<SearchHeadlinesResponse> {
  return search(ctx, req, HEADLINE_HISTORY_PRO_HOURS);
}
