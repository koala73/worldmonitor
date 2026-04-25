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

import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, httpsProxyFetchRaw } from './_seed-utils.mjs';
import countryNames from './shared/country-names.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();
const CANONICAL_KEY = 'economic:fatf-listing:v1';
const CACHE_TTL = 90 * 24 * 3600; // 90 days; FATF plenary is 3× per year

const FATF_ENTRY_URL = 'https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html';

// Build a name → ISO2 lookup from country-names.json (already in repo).
function buildNameLookup() {
  const lookup = new Map();
  for (const [iso2, names] of Object.entries(countryNames)) {
    for (const name of [names?.name, ...(names?.aliases ?? [])].filter(Boolean)) {
      lookup.set(normalizeName(name), iso2);
    }
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

async function fetchHtml(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } catch (directErr) {
    if (!_proxyAuth) throw new Error(`FATF fetch ${url}: ${directErr.message}`);
    console.warn(`  FATF ${url}: direct failed (${directErr.message}), retrying via proxy`);
    const { buffer } = await httpsProxyFetchRaw(url, _proxyAuth, { accept: 'text/html', timeoutMs: 30_000 });
    return buffer.toString('utf8');
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

// Extract country names from a FATF publication page. Each listed
// country typically appears as a header (h2/h3/h4) or strong tag.
// Defensive: collect any text node that matches a known country name
// from the lookup AND appears between the page's main listing markers.
//
// Also reports `unmatchedCandidates` — short text nodes that LOOK like
// country names (capitalized, 2-5 words, not common section headers)
// but don't match the lookup. Surfaces parser drift / new country
// spellings that the lookup needs to learn.
export function extractListedCountries(html, nameLookup) {
  const isoSet = new Set();
  const unmatchedCandidates = new Set();
  // Common section headers / FATF wording that should NOT be flagged
  // as missing-country-spelling.
  const SECTION_NOISE = new Set([
    'high risk jurisdictions',
    'jurisdictions under increased monitoring',
    'call for action',
    'high risk jurisdictions subject to a call for action',
    'fatf',
    'updated',
    'overview',
    'summary',
    'introduction',
    'background',
    'process',
    'february',
    'june',
    'october',
  ]);
  // Scan all HTML headings + bold/strong elements + list-item leaders.
  const re = /<(?:h[1-6]|strong|b|li|p|td)[^>]*>([\s\S]*?)<\/(?:h[1-6]|strong|b|li|p|td)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = stripHtml(m[1]);
    if (!text || text.length > 80) continue; // skip long paragraphs
    const norm = normalizeName(text);
    const iso2 = nameLookup.get(norm);
    if (iso2) {
      isoSet.add(iso2);
      continue;
    }
    // Heuristic: 1-5 words, all-or-mostly capitalized, not a known noise
    // header → likely a country name the lookup is missing.
    const wordCount = norm.split(' ').filter(Boolean).length;
    if (wordCount >= 1 && wordCount <= 5 && !SECTION_NOISE.has(norm) && /^[a-z][a-z0-9 ]+$/.test(norm)) {
      // Only count text that originally had at least one capital letter
      // (FATF page bodies don't use all-lowercase for country names).
      if (/[A-Z]/.test(text)) unmatchedCandidates.add(text);
    }
  }
  return { listed: isoSet, unmatchedCandidates };
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
