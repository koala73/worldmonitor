/**
 * Maps a caught search exception to the error string a client may see.
 *
 * The crafted relay contract passes through untouched: `relayFailureMessage`
 * output ('relay returned <status>[: <relay-authored reason>]') plus the
 * handler-thrown 'no results' and 'provider cooldown' sentinels — all pinned
 * by tests/google-flights-boundary.test.mts and
 * tests/google-dates-boundary.test.mts. Anything else (DNS failures, the
 * shared-cache backoff error carrying internal cache-key names, JSON parse
 * errors) is logged server-side and replaced with a fixed string.
 */
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../../../api/_sentry-edge.js';

const SAFE_SEARCH_ERRORS = new Set(['no results', 'provider cooldown']);
const RELAY_CONTRACT_RE = /^relay returned \d+/;

export function clientSearchError(tag: string, err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (SAFE_SEARCH_ERRORS.has(message) || RELAY_CONTRACT_RE.test(message)) return message;
  console.error(`[${tag}] search failed:`, message || String(err));
  captureSilentError(err, { tags: { route: `aviation/${tag}`, step: 'search-catch' } });
  return 'search failed';
}
