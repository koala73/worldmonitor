import { NewsServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';

/**
 * Headline history search: headlines the dashboard's edition served and no
 * longer holds. The server searches 24 hours for everyone and up to 7 days
 * for Pro, on two routes; the 7-day route is premium, enforced by the
 * gateway. Both are cut to what the language keeps (English 7 days, most
 * others 3, the rest 1), and each response's windowHours says which.
 */
export interface HistoryHeadline {
  title: string;
  source: string;
  link: string;
  publishedAt: number;
  lastServedAt: number;
}

export interface HeadlineHistoryQuery {
  /** Dashboard edition (site variant). */
  variant: string;
  /** Digest language. */
  lang: string;
  /** Whether the caller holds Pro access; decides which route is asked. */
  premium: boolean;
  signal?: AbortSignal;
}

const HEADLINE_SEARCH_TIMEOUT_MS = 6_000;

/**
 * After the server refuses the 7-day route, ask the 24-hour route directly
 * for a while instead of paying for a refusal on every keystroke. Short, so a
 * token that was only briefly invalid costs a paying user minutes, not the
 * session.
 */
const ARCHIVE_DENIAL_MEMORY_MS = 5 * 60_000;

let freeClient: InstanceType<typeof NewsServiceClient> | null = null;
let archiveClient: InstanceType<typeof NewsServiceClient> | null = null;
let archiveDeniedUntil = 0;

/** Forget a remembered refusal: the plan or the signed-in account changed. */
export function resetHeadlineHistoryAccess(): void {
  archiveDeniedUntil = 0;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(HEADLINE_SEARCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * Matching headlines, best first. Rejects when the request fails or the
 * server could not search, so the caller can tell "no match" from "did not
 * search" and does not remember the latter as an answer.
 *
 * A Pro caller the server refuses (a lapsed plan the browser has not heard
 * about yet) is answered from the 24-hour route instead of with nothing.
 */
export async function searchHeadlineHistory(query: string, options: HeadlineHistoryQuery): Promise<HistoryHeadline[]> {
  const request = { query, variant: options.variant, lang: options.lang };
  if (options.premium && Date.now() >= archiveDeniedUntil) {
    archiveClient ??= new NewsServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });
    try {
      const response = await archiveClient.searchHeadlineArchive(request, { signal: requestSignal(options.signal) });
      return completed(response);
    } catch (error) {
      // Read the status off the error instead of importing the generated
      // ApiError class: the generated client loads lazily, off the main bundle.
      const status = (error as { statusCode?: unknown } | null)?.statusCode;
      if (status !== 401 && status !== 403) throw error;
      archiveDeniedUntil = Date.now() + ARCHIVE_DENIAL_MEMORY_MS;
    }
  }
  freeClient ??= new NewsServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  const response = await freeClient.searchHeadlines(request, { signal: requestSignal(options.signal) });
  return completed(response);
}

function completed(response: { state: string; headlines: HistoryHeadline[] }): HistoryHeadline[] {
  if (response.state !== 'complete') throw new Error(`headline history ${response.state || 'unavailable'}`);
  return response.headlines;
}
