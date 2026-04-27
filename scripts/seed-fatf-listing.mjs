#!/usr/bin/env node
//
// FATF — black & grey AML/CFT listings
// Canonical key: economic:fatf-listing:v1
//
// FATF publishes two listings 3× per year (after each plenary):
//   - "High-risk jurisdictions subject to a call for action" (the "black list")
//   - "Jurisdictions under increased monitoring" (the "grey list")
//
// The entry page at https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html
// is STABLE (won't change URL). It links to the most-recent publication
// for each list, which is what this seeder must follow dynamically —
// hardcoding the publication URL would silently miss new updates.
//
// Cadence: monthly cron (catches FATF plenary updates within 30 days
// of publication). Cache TTL 90d so a transient parse failure doesn't
// drop the full listing.

import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw, describeErr } from './_seed-utils.mjs';
import countryNames from './shared/country-names.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();
const CANONICAL_KEY = 'economic:fatf-listing:v1';
const CACHE_TTL = 90 * 24 * 3600; // 90 days; FATF plenary is 3× per year

const FATF_ENTRY_URL = 'https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html';

// Build a name → ISO2 lookup from country-names.json. The JSON's actual
// shape is `{ "name": "ISO2" }` (flat string-to-string map, ~250 entries
// covering canonical names + common variants). The previous version
// here treated the JSON as `{ "ISO2": { name, aliases[] } }` and
// silently produced an EMPTY lookup, which never showed in production
// because the FATF fetch path was Cloudflare-blocked end-to-end and
// the parser was never reached. Now that PR #3413 + #3415 unblock the
// fetch, the broken lookup is what makes 100% of list entries show up
// as "unmatched country-name candidates".
export function buildNameLookup(json = countryNames) {
  const lookup = new Map();
  for (const [name, iso2] of Object.entries(json)) {
    if (typeof iso2 !== 'string') continue;
    lookup.set(normalizeName(name), iso2);
  }
  return lookup;
}

function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Strip apostrophes BEFORE the alphanumeric filter, so "People's" →
    // "peoples" not "people s". Includes ASCII + smart quotes.
    .replace(/[''‘’`]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Wayback fallback config. FATF plenary publishes 3×/year (Feb / Jun / Oct);
// 180 days covers >1 plenary cycle so we won't miss the most recent list
// even if Cloudflare blocked Wayback's own crawler for a few weeks.
const WAYBACK_CDX_URL = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK_LOOKBACK_DAYS = 180;
// Per-tier timeout. Railway-egress observations (log 2026-04-25T20:35)
// showed direct CDX timing out past 20s when archive.org rate-limits the
// shared pool; 25s gives 25% margin over that and pairs with a Decodo
// proxy fallback for the case where direct still times out. Together
// (direct 25s + proxy 25s = 50s per Wayback call × CDX + snapshot = 100s
// max Wayback budget per URL) this fits inside the seeder's overall
// per-URL ceiling (see comment block at fetchHtml).
const WAYBACK_TIMEOUT_MS = 25_000;

/**
 * Fetch a URL via Wayback Machine's most recent successful (statuscode:200)
 * snapshot. Used when both direct and CONNECT-proxy fetches are blocked at
 * the URL level (e.g. FATF's Cloudflare "Just a moment…" JS challenge —
 * neither browser headers nor residential proxy IPs pass without JS exec).
 *
 * Two-tier per-call: direct fetch → CONNECT proxy fallback. Railway egress
 * IPs are routinely soft-rate-limited or slowed by archive.org; routing
 * the same CDX/snapshot request through Decodo's residential proxy pool
 * bypasses that without changing the response shape.
 *
 * Wayback's `id_` URL modifier returns the captured HTML byte-for-byte
 * without Wayback's banner injection or href/src rewriting — critical for
 * keeping the parser working against the same DOM it sees from FATF
 * directly.
 *
 * Tradeoff: 1–3 day staleness vs FATF's live page. For FATF specifically
 * this is fine because plenary outputs change ~3×/year and the seeder's
 * bundle interval is 30d; for any caller with a tighter freshness budget,
 * tune `WAYBACK_LOOKBACK_DAYS` accordingly.
 *
 * Test seams: `fetchFn` and `proxyFetcher` default to global `fetch` and
 * `httpsProxyFetchRaw` so production wiring is untouched; tests can pass
 * mocked versions of either.
 */
export async function fetchViaWayback(url, opts = {}) {
  const {
    fetchFn = fetch,
    proxyFetcher = httpsProxyFetchRaw,
    proxyAuth = resolveProxyForConnect(),
    lookbackDays = WAYBACK_LOOKBACK_DAYS,
  } = opts;
  const fromDate = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
  // CDX default sort is timestamp-ASCENDING. With a positive `limit=N` the
  // server returns the FIRST N captures within the window (i.e. the OLDEST
  // N), not the newest. FATF accumulates well over 20 captures per 180-day
  // window, so a positive limit would silently serve a stale snapshot when
  // a newer one exists. CDX accepts a NEGATIVE `limit` to mean "last N
  // captures" — `limit=-1` returns just the most-recent snapshot, which
  // is exactly what we want and also avoids fetching ~20× more rows than
  // we need.
  const cdxUrl = `${WAYBACK_CDX_URL}?url=${encodeURIComponent(url)}&filter=statuscode:200&output=json&from=${fromDate}&limit=-1`;
  const rows = await fetchWaybackJson(cdxUrl, { fetchFn, proxyFetcher, proxyAuth });
  // CDX returns: [headerRow, snapshotRow]. Each snapshot row =
  // [urlkey, timestamp, original, mimetype, statuscode, digest, length].
  // With `limit=-1` we expect exactly one snapshot row.
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error(`Wayback has no status-200 snapshots for ${url} since ${fromDate}`);
  }
  const latest = rows[rows.length - 1];
  const timestamp = latest[1];
  if (!/^\d{14}$/.test(timestamp)) {
    throw new Error(`Wayback CDX returned malformed timestamp "${timestamp}" for ${url}`);
  }
  const snapshotUrl = `https://web.archive.org/web/${timestamp}id_/${url}`;
  return await fetchWaybackText(snapshotUrl, timestamp, { fetchFn, proxyFetcher, proxyAuth });
}

// Wayback's `id_` modifier returns the captured response body BYTE-FOR-BYTE
// from the original origin. When that origin sent `Content-Encoding: gzip`
// (FATF AEM does, behind Cloudflare), the captured bytes are gzip-encoded.
//
// Native `fetch` auto-decompresses based on the response `Content-Encoding`
// header, so the direct path is fine. Our CONNECT proxy path
// (`httpsProxyFetchRaw`) returns raw bytes from the tunnel and does NOT
// auto-decompress. Calling `.toString('utf8')` on gzipped bytes yields
// binary garbage that the regex parser pattern-matches as ~100 false-
// positive country candidates, tripping the sanity-check gate.
//
// This helper sniffs the standard magic bytes and decompresses when needed.
// Safe to call on already-decompressed bodies — they'll fall through to the
// utf8 cast.
//
// Magic bytes:
//   gzip:    1f 8b
//   zlib:    78 (followed by 01 / 9c / da)
//   brotli:  no magic bytes; only attempted as last resort if upstream
//            advertises `br` and the gzip/deflate paths failed.
export function decodeMaybeCompressed(buffer, contentEncoding) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  // Gzip magic: 1f 8b
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer).toString('utf8');
  }
  // Zlib/deflate magic: 78 01, 78 9c, 78 da
  if (buffer.length >= 2 && buffer[0] === 0x78 && (buffer[1] === 0x01 || buffer[1] === 0x9c || buffer[1] === 0xda)) {
    return inflateSync(buffer).toString('utf8');
  }
  // Brotli has no magic bytes — only try it if explicitly advertised AND
  // the body is clearly not utf8 text. We treat ASCII-printable starts
  // (`<`, `{`, `[`, `"`, whitespace) as already-decoded text.
  if (contentEncoding === 'br' && buffer.length > 0 && buffer[0] >= 0x80) {
    try { return brotliDecompressSync(buffer).toString('utf8'); }
    catch { /* fall through to utf8 cast */ }
  }
  return buffer.toString('utf8');
}

async function fetchWaybackJson(cdxUrl, { fetchFn, proxyFetcher, proxyAuth }) {
  let directErr;
  try {
    const cdxResp = await fetchFn(cdxUrl, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(WAYBACK_TIMEOUT_MS),
    });
    if (!cdxResp.ok) throw new Error(`Wayback CDX HTTP ${cdxResp.status}`);
    // Defensive decompression: if Wayback omits Content-Encoding on this
    // route, Node's fetch won't auto-inflate. Use raw bytes + magic-byte
    // detection. If the body is already-decoded (the common case), the
    // helper falls through to a plain utf8 cast.
    const buf = Buffer.from(await cdxResp.arrayBuffer());
    return JSON.parse(decodeMaybeCompressed(buf, cdxResp.headers.get?.('content-encoding')));
  } catch (err) {
    directErr = err;
  }
  if (!proxyAuth) {
    throw new Error(`Wayback CDX direct failed (${describeErr(directErr)}); no proxy configured`);
  }
  try {
    // Note: httpsProxyFetchRaw injects User-Agent: CHROME_UA internally
    // (see scripts/_seed-utils.mjs:httpsProxyFetchRaw) — we don't need to
    // pass headers here. AGENTS.md UA convention is satisfied on both legs.
    const { buffer, headers } = await proxyFetcher(cdxUrl, proxyAuth, {
      accept: 'application/json',
      timeoutMs: WAYBACK_TIMEOUT_MS,
    });
    return JSON.parse(decodeMaybeCompressed(buffer, headers?.['content-encoding']));
  } catch (proxyErr) {
    throw new Error(`Wayback CDX direct=${describeErr(directErr)}; proxy=${describeErr(proxyErr)}`);
  }
}

async function fetchWaybackText(snapshotUrl, timestamp, { fetchFn, proxyFetcher, proxyAuth }) {
  let directErr;
  try {
    const snapResp = await fetchFn(snapshotUrl, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(WAYBACK_TIMEOUT_MS),
    });
    if (!snapResp.ok) throw new Error(`Wayback snapshot ${timestamp} HTTP ${snapResp.status}`);
    // Defensive decompression — see fetchWaybackJson for rationale.
    const buf = Buffer.from(await snapResp.arrayBuffer());
    return decodeMaybeCompressed(buf, snapResp.headers.get?.('content-encoding'));
  } catch (err) {
    directErr = err;
  }
  if (!proxyAuth) {
    throw new Error(`Wayback snapshot ${timestamp} direct failed (${describeErr(directErr)}); no proxy configured`);
  }
  try {
    // Note: httpsProxyFetchRaw injects User-Agent: CHROME_UA internally
    // (see scripts/_seed-utils.mjs:httpsProxyFetchRaw) — UA is sent on
    // the proxy snapshot fetch even though it's not in the opts here.
    const { buffer, headers } = await proxyFetcher(snapshotUrl, proxyAuth, {
      accept: 'text/html',
      timeoutMs: WAYBACK_TIMEOUT_MS,
    });
    return decodeMaybeCompressed(buffer, headers?.['content-encoding']);
  } catch (proxyErr) {
    throw new Error(`Wayback snapshot ${timestamp} direct=${describeErr(directErr)}; proxy=${describeErr(proxyErr)}`);
  }
}

// Per-URL fetch budget — total ≤ 125s in the absolute worst case where
// every tier exhausts its timeout. Composed of: direct(10s) + proxy(15s)
// + wayback-CDX-direct(25s) + wayback-CDX-proxy(25s) + wayback-snapshot-
// direct(25s) + wayback-snapshot-proxy(25s) = 125s. The seeder fetches
// the entry page sequentially, then black + grey publication pages in
// parallel via Promise.all, so end-to-end worst case is ≤ 250s — fits
// inside seed-bundle-macro.mjs's 300_000 ms FATF-Listing section budget
// with ~50s margin. Direct 30s / proxy 30s / wayback 45s in the prior
// design summed to 240s per URL × sequential entry + parallel pubs =
// 480s worst case, exceeded the original 120_000 ms section budget and
// caused bundle-runner SIGTERM to interrupt the graceful-fail path.
async function fetchHtml(url) {
  // Tier 1: direct fetch (Cloudflare 403s in <1s when blocking; 10s
  // gives 10× margin without burning section budget on a guaranteed
  // failure).
  let directErr;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } catch (err) {
    directErr = err;
    console.warn(`  FATF ${url}: direct failed (${describeErr(err)})`);
  }
  // Tier 2: CONNECT proxy (if configured) — Decodo adds ~1s of CONNECT-
  // tunnel overhead; 15s lets a slow-but-eventually-200 proxy response
  // through while still leaving 100s of budget for Wayback.
  let proxyErr;
  if (_proxyAuth) {
    try {
      const { buffer } = await httpsProxyFetchRaw(url, _proxyAuth, { accept: 'text/html', timeoutMs: 15_000 });
      return buffer.toString('utf8');
    } catch (err) {
      proxyErr = err;
      console.warn(`  FATF ${url}: proxy failed (${describeErr(err)}), falling back to Wayback`);
    }
  } else {
    console.warn(`  FATF ${url}: no proxy configured, falling back to Wayback`);
  }
  // Tier 3: Wayback Machine (bypasses Cloudflare JS challenge). Internally
  // does its own direct → proxy fallback because Railway egress IPs are
  // routinely soft-rate-limited by archive.org.
  try {
    return await fetchViaWayback(url);
  } catch (wbErr) {
    const proxyMsg = proxyErr ? ` proxy=${describeErr(proxyErr)};` : '';
    throw new Error(`FATF fetch ${url}: direct=${describeErr(directErr)};${proxyMsg} wayback=${describeErr(wbErr)}`);
  }
}

// Extract the href to the most-recent publication page whose anchor text
// contains the given label fragment. Defensive against FATF page layouts
// where a sidebar/breadcrumb links to historical publications using the
// same wording before the main-content anchor — preferring the highest-
// year href catches drift even if document order isn't trustworthy.
//
// Returns the chosen URL or null. When multiple candidates match, logs
// the full candidate list at WARN level for ops visibility.
export function findPublicationLink(html, labelFragment) {
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const candidates = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = stripHtml(m[2]);
    if (!text) continue;
    if (text.toLowerCase().includes(labelFragment.toLowerCase())) {
      let resolved;
      try { resolved = new URL(href, FATF_ENTRY_URL).toString(); } catch { continue; }
      // Year extracted from the URL slug (preferred) or anchor text.
      const yearMatch = /\b(20\d{2})\b/.exec(href) ?? /\b(20\d{2})\b/.exec(text);
      const year = yearMatch ? Number.parseInt(yearMatch[1], 10) : 0;
      candidates.push({ url: resolved, text, year });
    }
  }
  if (candidates.length === 0) return null;
  // Prefer highest-year; fall back to document-order on ties (first match
  // is usually the canonical link in FATF page templates as of 2026).
  candidates.sort((a, b) => b.year - a.year);
  if (candidates.length > 1) {
    console.warn(`[fatf-listing] multiple "${labelFragment}" anchors found; using ${candidates[0].url} (year=${candidates[0].year}). Other candidates: ${candidates.slice(1).map((c) => `${c.url}(year=${c.year})`).join(', ')}`);
  }
  return candidates[0].url;
}

function stripHtml(s) {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim();
}

// Extract country names from a FATF publication page. The page renders
// list members as a paragraph of links to /en/countries/detail/<slug>.html
// inside a `<div class="cmp-text">` (the publication body). The FATF
// site chrome reuses the SAME `/en/countries/detail/<slug>.html` URL
// pattern in two places that we MUST exclude:
//
//   1. FATF Member Countries sidebar — rendered as `<li class="cmp-list__item">`
//      with `<a class="cmp-list__item-link">` inside a `<span class="cmp-list__item-title">`.
//      ~38 of these per page.
//   2. (no other observed cases as of Feb 2026 plenary fixtures)
//
// Discriminator: the publication-body anchors are PLAIN
// `<a href="...">Country</a>` with no class attribute. Member-nav
// anchors have `class="cmp-list__item-link"`. Skip any anchor whose
// attributes contain that class.
//
// Resolution order on accepted anchors: (1) anchor text via nameLookup,
// (2) href slug via nameLookup, (3) bubble up as `unmatchedCandidates`
// so ops can see new FATF spellings that need adding to country-names.json.
//
// Returns `{ listed, unmatchedCandidates }`.
export function extractListedCountries(html, nameLookup) {
  // Declared inside the function so each call gets a fresh regex with
  // `lastIndex=0`. Module-scoped /g regexes are a classic footgun:
  // sequential calls skip matches because lastIndex carries over.
  const detailLinkRe = /<a\s+([^>]*)href="[^"]*\/en\/countries\/detail\/([^"]+?)\.html"([^>]*)>([\s\S]*?)<\/a>/gi;
  const isoSet = new Set();
  const unmatchedCandidates = new Set();
  let m;
  while ((m = detailLinkRe.exec(html)) !== null) {
    const attrsBefore = m[1];
    const slug = m[2];
    const attrsAfter = m[3];
    const innerHtml = m[4];
    // Skip ALL AEM CMS-component anchors (Member Countries side nav,
    // top nav, breadcrumbs, footer, related-content boxes). FATF's
    // publication body uses plain `<a href="...">name</a>`; every nav
    // surface uses `class="cmp-..."`. The previous narrower filter
    // (`cmp-list__item-link` only) missed snapshots where Wayback served
    // a slightly different DOM that hit other nav classes — surfaced as
    // 111 unmatched candidates in production 2026-04-25.
    if (/\bcmp-/.test(attrsBefore + attrsAfter)) continue;
    // Strip HTML tags BEFORE decoding entities. If a malformed snapshot
    // contained `&lt;note&gt;` inside the anchor, decoding first would
    // produce `<note>` which stripHtml would then erase. Stripping first
    // preserves the literal text.
    const anchorText = decodeHtmlEntities(stripHtml(innerHtml));
    if (!anchorText) continue;
    // Try anchor text first (most reliable — FATF renders the canonical
    // display name like "Côte d'Ivoire" or "Democratic Republic of the
    // Congo" inside the anchor).
    const fromAnchor = nameLookup.get(normalizeName(anchorText));
    if (fromAnchor) {
      isoSet.add(fromAnchor);
      continue;
    }
    // Fall back to the href slug (handles cases where FATF stylises the
    // anchor text but keeps a canonical slug, e.g. "Lao PDR" anchor with
    // /en/countries/detail/Lao-People-s-Democratic-Republic.html slug).
    const slugDecoded = slug.replace(/-/g, ' ').replace(/[^a-zA-Z0-9 ]/g, '');
    const fromSlug = nameLookup.get(normalizeName(slugDecoded));
    if (fromSlug) {
      isoSet.add(fromSlug);
      continue;
    }
    // Genuinely missing from country-names.json — surface for ops
    // attention. Prefer anchor text in the report (more readable).
    unmatchedCandidates.add(anchorText);
  }
  return { listed: isoSet, unmatchedCandidates };
}

// Minimal HTML entity decoder for the entities FATF emits in anchor
// text (&#39; for apostrophe, &amp; for ampersand, &nbsp; for space).
// Full-fledged decoders pull in 100KB of dependencies; this targeted
// list covers what we actually see in the fixtures.
function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Try to extract the publication date from the URL slug or the page
// header. Falls back to the current date if neither succeeds.
export function extractPublicationDate(url, html) {
  // URL form: /en/publications/.../high-risk-jurisdictions-2026-02.html
  const fromUrl = /\b(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})?\b/.exec(url);
  if (fromUrl) {
    const [, y, mo, d] = fromUrl;
    return `${y}-${mo}-${d ?? '01'}`;
  }
  // Header form: "February 2026"
  const months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
  const hdr = /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})/i.exec(stripHtml(html));
  if (hdr) {
    return `${hdr[2]}-${months[hdr[1].toLowerCase()]}-01`;
  }
  return new Date().toISOString().slice(0, 10);
}

// On parser-sanity-check failure, surface enough about the HTML body that
// ops can tell at a glance whether the fetch returned the real publication,
// a Cloudflare challenge, a 404 redirect, or compressed bytes mistakenly
// treated as utf8. Bounded to a few hundred chars so log lines stay
// readable.
function previewHtmlForDiagnostic(html) {
  if (!html) return '<empty>';
  const len = html.length;
  const detailHrefs = (html.match(/\/en\/countries\/detail\//gi) || []).length;
  // Counts every `cmp-*` AEM class — must mirror the live discriminator
  // in extractListedCountries (line ~323). The previous narrower count
  // of `cmp-list__item-link` would report 0 even when the page was full
  // of `cmp-navigation`/`cmp-breadcrumb`/etc. anchors that the new
  // discriminator correctly filters, masking the exact diagnostic signal.
  const cmpAnchors = (html.match(/\bcmp-/g) || []).length;
  // Detect leading control bytes / non-printable ASCII as a strong hint
  // that the body is compressed/binary (gzip starts with 0x1f 0x8b, brotli
  // is high-bit, etc.). Bypasses html.toString detection issues.
  const head = html.slice(0, 32);
  const printable = [...head].filter((c) => {
    const code = c.charCodeAt(0);
    return (code >= 0x20 && code < 0x7f) || code === 0x09 || code === 0x0a || code === 0x0d;
  }).length;
  const looksBinary = printable < 24;
  return `len=${len} detailHrefs=${detailHrefs} cmpAnchors=${cmpAnchors} binaryHead=${looksBinary} firstChars=${JSON.stringify(html.slice(0, 120))}`;
}

export async function fetchFatfListings({
  fetchHtmlFn = fetchHtml,
} = {}) {
  const entryHtml = await fetchHtmlFn(FATF_ENTRY_URL);
  const blackUrl = findPublicationLink(entryHtml, 'high-risk') ?? findPublicationLink(entryHtml, 'call for action');
  const greyUrl = findPublicationLink(entryHtml, 'increased monitoring');

  if (!blackUrl || !greyUrl) {
    throw new Error(`FATF entry page parse failed: black=${blackUrl} grey=${greyUrl}. Page structure may have changed.`);
  }

  const [blackHtml, greyHtml] = await Promise.all([
    fetchHtmlFn(blackUrl),
    fetchHtmlFn(greyUrl),
  ]);

  const nameLookup = buildNameLookup();
  const blackResult = extractListedCountries(blackHtml, nameLookup);
  const greyResult = extractListedCountries(greyHtml, nameLookup);

  const listings = {};
  for (const iso2 of blackResult.listed) listings[iso2] = 'black';
  for (const iso2 of greyResult.listed) {
    if (!listings[iso2]) listings[iso2] = 'gray';
  }

  // Surface unmatched country-name candidates so ops can extend
  // shared/country-names.json aliases when FATF introduces a new
  // spelling. Reject the seed if too many candidates are missing —
  // silent drops would otherwise re-classify the missed countries as
  // "compliant" (default) and materially shift their financialSystemExposure
  // score under a fresh seed-meta. Per memory `feedback_url_200_but_wrong_content_type_silent_zero`:
  // "HTTP 200 + plausible bytes ≠ valid payload."
  const unmatched = [...new Set([...blackResult.unmatchedCandidates, ...greyResult.unmatchedCandidates])];
  if (unmatched.length > 0) {
    console.warn(`[fatf-listing] ${unmatched.length} country-name candidates not found in shared/country-names.json: ${unmatched.join(', ')}. Extend the aliases map if any of these are real country names.`);
  }
  if (unmatched.length > 2) {
    // Diagnostic preview: when this gate trips, ops needs to know whether
    // the HTML actually arrived (real publication body), arrived garbled
    // (binary / wrong page / Cloudflare challenge), or arrived empty.
    // Without this preview the unmatched-text dump is ambiguous — we
    // can't tell from logs whether to fix the parser or retry the fetch.
    const blackPreview = previewHtmlForDiagnostic(blackHtml);
    const greyPreview = previewHtmlForDiagnostic(greyHtml);
    console.warn(`[fatf-listing] diagnostic: black=${blackPreview} grey=${greyPreview}`);
    const msg = `FATF parser found ${unmatched.length} unmatched country-name candidates (max 2 tolerated): ${unmatched.join(', ')}. Previous valid payload remains under cache TTL — extend shared/country-names.json or fix the parser before next plenary.`;
    console.warn(`[fatf-listing] parser sanity-check failed: ${msg}`);
    throw new Error(msg);
  }

  // Sanity-check: FATF black list typically has 1-3 jurisdictions
  // (DPRK, Iran, Myanmar as of 2026); grey list typically has 15-25.
  // If we're way outside this band, the parser likely failed.
  const blackCount = Object.values(listings).filter((s) => s === 'black').length;
  const grayCount = Object.values(listings).filter((s) => s === 'gray').length;
  if (blackCount === 0 || blackCount > 6) {
    const msg = `FATF black-list count ${blackCount} outside expected 1-6 band; parser likely failed`;
    console.warn(`[fatf-listing] parser sanity-check failed: ${msg}; previous valid payload remains under cache TTL`);
    throw new Error(msg);
  }
  if (grayCount < 12 || grayCount > 40) {
    const msg = `FATF grey-list count ${grayCount} outside expected 12-40 band; parser likely failed (historical band has been 15+ since 2020)`;
    console.warn(`[fatf-listing] parser sanity-check failed: ${msg}; previous valid payload remains under cache TTL`);
    throw new Error(msg);
  }

  return {
    listings,
    publicationDate: extractPublicationDate(blackUrl, blackHtml),
    counts: { black: blackCount, gray: grayCount },
    unmatchedCandidates: unmatched,
    sources: [FATF_ENTRY_URL, blackUrl, greyUrl],
    seededAt: new Date().toISOString(),
  };
}

export function validate(data) {
  if (typeof data?.listings !== 'object') return false;
  const counts = Object.values(data.listings);
  // At least 1 black-listed jurisdiction (DPRK has been on every FATF
  // call-for-action list since 2011) and at least 12 gray-listed.
  // Historical FATF grey-list size has been 15+ since 2020; floor of 12
  // catches a real upstream regression while absorbing list churn during
  // a plenary cycle.
  return counts.filter((s) => s === 'black').length >= 1 && counts.filter((s) => s === 'gray').length >= 12;
}

export function declareRecords(data) {
  return Object.keys(data?.listings || {}).length;
}

export { CANONICAL_KEY, CACHE_TTL };

if (process.argv[1]?.endsWith('seed-fatf-listing.mjs')) {
  runSeed('economic', 'fatf-listing', CANONICAL_KEY, fetchFatfListings, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `fatf-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.listings ?? {}).length,
    emptyDataIsFailure: true,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 60480, // 42 days, > 1 plenary cycle
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
