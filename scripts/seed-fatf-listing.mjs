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

// Extract the first href to a publication page that contains the given
// label-text fragment. FATF entry-page anchors look like:
// `<a href="/en/publications/Fatfrecommendations/high-risk-jurisdictions-2026.html">High-risk jurisdictions subject to a call for action — February 2026</a>`
export function findPublicationLink(html, labelFragment) {
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = stripHtml(m[2]);
    if (!text) continue;
    if (text.toLowerCase().includes(labelFragment.toLowerCase())) {
      // Resolve relative URLs against the FATF origin.
      try {
        return new URL(href, FATF_ENTRY_URL).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}

function stripHtml(s) {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim();
}

// Extract country names from a FATF publication page. Each listed
// country typically appears as a header (h2/h3/h4) or strong tag.
// Defensive: collect any text node that matches a known country name
// from the lookup AND appears between the page's main listing markers.
export function extractListedCountries(html, nameLookup) {
  const isoSet = new Set();
  // Scan all HTML headings + bold/strong elements + list-item leaders.
  const re = /<(?:h[1-6]|strong|b|li|p|td)[^>]*>([\s\S]*?)<\/(?:h[1-6]|strong|b|li|p|td)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = stripHtml(m[1]);
    if (!text || text.length > 80) continue; // skip long paragraphs
    const norm = normalizeName(text);
    const iso2 = nameLookup.get(norm);
    if (iso2) isoSet.add(iso2);
  }
  return isoSet;
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
  const blackSet = extractListedCountries(blackHtml, nameLookup);
  const greySet = extractListedCountries(greyHtml, nameLookup);

  const listings = {};
  for (const iso2 of blackSet) listings[iso2] = 'black';
  for (const iso2 of greySet) {
    if (!listings[iso2]) listings[iso2] = 'gray';
  }

  // Sanity-check: FATF black list typically has 1-3 jurisdictions
  // (DPRK, Iran, Myanmar as of 2026); grey list typically has 15-25.
  // If we're way outside this band, the parser likely failed.
  const blackCount = Object.values(listings).filter((s) => s === 'black').length;
  const grayCount = Object.values(listings).filter((s) => s === 'gray').length;
  if (blackCount === 0 || blackCount > 6) {
    throw new Error(`FATF black-list count ${blackCount} outside expected 1-6 band; parser likely failed`);
  }
  if (grayCount < 8 || grayCount > 40) {
    throw new Error(`FATF grey-list count ${grayCount} outside expected 8-40 band; parser likely failed`);
  }

  return {
    listings,
    publicationDate: extractPublicationDate(blackUrl, blackHtml),
    counts: { black: blackCount, gray: grayCount },
    sources: [FATF_ENTRY_URL, blackUrl, greyUrl],
    seededAt: new Date().toISOString(),
  };
}

export function validate(data) {
  if (typeof data?.listings !== 'object') return false;
  const counts = Object.values(data.listings);
  // At least 1 black-listed jurisdiction (DPRK has been on every FATF
  // call-for-action list since 2011) and at least 8 gray-listed.
  return counts.filter((s) => s === 'black').length >= 1 && counts.filter((s) => s === 'gray').length >= 8;
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
