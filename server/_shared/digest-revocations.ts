/**
 * Operator URL revocation for the news digest (#7084).
 *
 * This lives in `_shared` rather than beside the digest handler because the
 * suppression set is NOT a property of one endpoint — it is a property of the
 * digest CONTENT, and the content is read from `news:digest:v1:*` by several
 * handlers. Shipping the filter only inside list-feed-digest meant an operator
 * who revoked a retracted story still saw it published for six hours by
 * get-country-intel-brief (which caches its own output) and fed into the chat
 * analyst's prompt. Every reader of that key must go through here.
 *
 * Operator invalidation:
 *   SADD news:digest:revoked-urls:v1 <url>
 * That alone is sufficient for anything served from Redis — suppression
 * happens on read. Deleting news:digest:v1:<variant>:<lang> and
 * news:digest:lastgood:v1:<variant>:<lang> additionally forces a rebuild.
 *
 * NOTE for responders: the digest endpoint is CDN-cached, so an SADD does not
 * evict copies already in shared caches. See the purge note in
 * server/worldmonitor/news/v1/_lastgood.ts.
 *
 * Matching is exact string equality on `item.link`; normalize the URL the way
 * the feed emits it (scheme, trailing slash, and query string all count).
 */
import { isRedisConfigured, runRedisPipeline } from './redis';

/** Versioned, narrow revocation set: exact item URLs suppressed at SERVE time. */
export const REVOKED_URLS_KEY = 'news:digest:revoked-urls:v1';

/** Result of reading the revocation set: an empty set is not a failed read. */
export interface RevocationRead {
  urls: Set<string>;
  /** False when the set could not be read at all — suppression is fail-open but not silent. */
  readable: boolean;
}

/**
 * Filter items by the revocation set. Shared by every serving path so a
 * revoked URL disappears from all of them at once.
 */
export function filterRevokedUrls<T extends { link?: unknown }>(
  items: readonly T[],
  revokedUrls: ReadonlySet<string>,
): { kept: T[]; dropped: number } {
  // `Array.isArray` guard: these bodies come back from Redis, where a
  // malformed or round-tripped bucket can be an object rather than an array.
  // Throwing here would abort the whole serving tier.
  if (!Array.isArray(items)) return { kept: [], dropped: 0 };
  if (revokedUrls.size === 0) return { kept: [...items], dropped: 0 };
  // `item?.` matters: a malformed items array can carry null entries. Keep
  // them (they carry no link to revoke) rather than throwing.
  const kept = items.filter(
    (item) => typeof item?.link !== 'string' || !revokedUrls.has(item.link),
  );
  return { kept, dropped: items.length - kept.length };
}

/**
 * Read the operator revocation set.
 *
 * Three outcomes, deliberately distinguished:
 *  - sidecar / no Redis configured -> empty set, `readable: true`. There is no
 *    revocation store in that deployment, so an empty view is the COMPLETE
 *    truth. Reporting it as unreadable made callers fail closed and blank the
 *    endpoint on a preview deploy or a local dev run.
 *  - Redis reachable -> the set, `readable: true`.
 *  - Redis errored or timed out -> empty set, `readable: false`. Callers must
 *    fail CLOSED on this one: a suppression control that cannot be read must
 *    not be assumed empty.
 */
export async function readRevokedUrlSet(): Promise<RevocationRead> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    return { urls: new Set(), readable: true };
  }
  if (!isRedisConfigured()) {
    return { urls: new Set(), readable: true };
  }
  try {
    const results = await runRedisPipeline([['SMEMBERS', REVOKED_URLS_KEY]]);
    const entry = results[0];
    if (!entry || entry.error || !Array.isArray(entry.result)) {
      return { urls: new Set(), readable: false };
    }
    return {
      urls: new Set(entry.result.filter((value): value is string => typeof value === 'string')),
      readable: true,
    };
  } catch {
    return { urls: new Set(), readable: false };
  }
}
