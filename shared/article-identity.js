// One article-identity rule for every surface that FLATTENS the feed digest's
// categories into a single list: the crawlable corpus freeze
// (scripts/freeze-crawlable-live-pulse.mjs selectFrozenHeadlines) and the live
// welcome strip (pro-test/src/services/teasers.ts). Both render the same
// four-row card, so they must agree or the strip changes on hydration.
//
// Why this is a consumer-side rule and not a digest-side one (#8339): the
// digest's categories are per-FEED regional groupings, and one publisher
// registers several regional feeds in several categories.
// server/worldmonitor/news/v1/_feeds.ts places France 24's four editions in
// four different categories (europe, africa, latam, asia), so one wire story
// legitimately arrives as several category rows with a byte-identical link. On
// 2026-09-14 that put "France 24" (europe) and "France 24 LatAm" (latam) in one
// capture, and the homepage strip spent two of its four rows on one article.
//
// Dropping the duplicate in the digest is NOT the fix. The browser renders a
// user-selected subset of categories (src/app/data-loader.ts
// resolveEnabledNewsCategories), while the digest always returns every category
// for the variant. Deleting the latam row server-side would erase that article
// for a reader who enabled only latam. Each category row is independently
// valid; duplication only exists once a consumer flattens, so the flattener
// dedupes.
//
// Identity is the normalized article URL, never the title. Two locale editions
// of one story share a title while being different documents, and collapsing
// them would destroy real coverage.

// Tracking parameters carry no document identity, so two links differing only
// in these are the same article. Google's own duplicate-content guidance uses
// exactly this case (`?gclid=...` against the clean URL) as the illustration
// that raw string equality is insufficient. Deliberately a denylist, not
// "strip the query string": `?id=`, `?p=` and `?story=` are the document on
// plenty of news CMSs, and dropping them would merge unrelated articles.
const TRACKING_PARAMS = new Set([
  'at_campaign',
  'at_custom1',
  'at_custom2',
  'at_custom3',
  'at_custom4',
  'at_medium',
  'cmpid',
  'dclid',
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'ncid',
  'ocid',
  'partner',
  'smid',
  'twclid',
  'yclid',
]);

const TRACKING_PARAM_PREFIXES = ['utm_'];

function isTrackingParam(name) {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.has(lower)
    || TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The dedupe key for an article link. Returns '' when the value is not a
 * parseable absolute URL, which the callers below treat as "cannot compare" and
 * therefore never merge — dropping an unparseable row would lose content over a
 * key we could not compute.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeArticleUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  // The fragment is never part of the document's identity for a news article.
  url.hash = '';
  // Host is case-insensitive per RFC 3986; the path is not, so it is left
  // alone. `www.` is a real host alias here rather than a cosmetic prefix, and
  // publishers do not mix the two within one feed set, so it stays.
  url.hostname = url.hostname.toLowerCase();

  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) url.searchParams.delete(name);
  }
  // Sort so two orderings of the same surviving params agree.
  url.searchParams.sort();

  let normalized = url.toString();
  // A bare trailing '?' survives deleting every param.
  if (normalized.endsWith('?')) normalized = normalized.slice(0, -1);
  // One trailing slash on a path is the same document; '/' itself is not a
  // path segment to strip.
  if (normalized.endsWith('/') && !normalized.endsWith('://')) {
    const withoutSlash = normalized.slice(0, -1);
    if (new URL(withoutSlash).pathname !== '') normalized = withoutSlash;
  }
  return normalized;
}

/**
 * Keep the first row for each distinct article URL, preserving input order.
 * Callers sort by rank before calling, so "first" is the best-ranked copy.
 *
 * Rows whose URL does not normalize are all kept: an uncomparable key is not
 * evidence of duplication.
 *
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => unknown} getUrl
 * @returns {T[]}
 */
export function dedupeByArticleUrl(rows, getUrl) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = normalizeArticleUrl(getUrl(row));
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    unique.push(row);
  }
  return unique;
}

/**
 * The article URLs that appear more than once under normalization, in first-seen
 * order. Used as a published-artifact invariant rather than a filter, so a
 * snapshot can refuse to ship a strip that would show one story twice.
 *
 * @param {unknown[]} rows
 * @param {(row: unknown) => unknown} getUrl
 * @returns {string[]}
 */
export function duplicateArticleUrls(rows, getUrl) {
  if (!Array.isArray(rows)) return [];
  const counts = new Map();
  for (const row of rows) {
    const key = normalizeArticleUrl(getUrl(row));
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}
