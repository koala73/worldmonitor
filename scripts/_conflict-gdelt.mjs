// Pure helpers for the GDELT conflict-events fallback (#5099).
//
// Import-safe: no Redis, no network, no top-level execution. seed-conflict-intel.mjs
// owns the fetch orchestration (via _gdelt-fetch.mjs's proxy); this module owns the
// URL/query construction and the article→event mapping so both are unit-testable
// without importing the seeder (which runs runSeed() at module load).

// ISO2 → display name for the priority conflict countries. GDELT is queried on the
// country NAME (not FIPS locationcc, which diverges from ISO2 — UA→UP, SD→SU …), and
// the emitted event `country` is the full name so it matches UCDP country names /
// the EMA engine's normalizeCountry.
export const GDELT_COUNTRY_NAMES = {
  AF: 'Afghanistan', SY: 'Syria', UA: 'Ukraine', SD: 'Sudan', SS: 'South Sudan',
  SO: 'Somalia', CD: 'Democratic Republic of Congo', MM: 'Myanmar', YE: 'Yemen',
  ET: 'Ethiopia', IQ: 'Iraq', PS: 'Palestinian Territories', LY: 'Libya',
  ML: 'Mali', BF: 'Burkina Faso', NE: 'Niger', NG: 'Nigeria', CM: 'Cameroon',
  MZ: 'Mozambique', HT: 'Haiti',
};

export const GDELT_CONFLICT_TERMS = '(clashes OR airstrike OR shelling OR militants OR offensive OR killed)';
export const GDELT_MAX_ARTICLES_PER_COUNTRY = 250;

/**
 * Parse `iso` (a UTC instant with no offset suffix) to epoch ms, or NaN when
 * any field is out of range. Date.parse normalizes rather than rejects those,
 * so re-serializing and comparing the first `length` characters is the only
 * way to tell an impossible stamp from a real one.
 */
function parseExactUtc(iso, length) {
  const ms = Date.parse(`${iso}Z`);
  if (!Number.isFinite(ms)) return Number.NaN;
  return new Date(ms).toISOString().slice(0, length) === iso.slice(0, length) ? ms : Number.NaN;
}

// GDELT seendate is 'YYYYMMDDTHHMMSSZ' (or a digits-only variant). Return 'YYYY-MM-DD'
// (the format the EMA engine parses via Date.parse(ev.event_date)), or '' if unparseable.
export function gdeltSeenDateToIso(seendate) {
  const s = String(seendate || '').replace(/[^0-9]/g, '');
  if (s.length < 8) return '';
  if (s.length !== 8 && !Number.isFinite(gdeltSeenDateToMs(s))) return '';
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  // Slicing alone emitted impossible days verbatim: '20260231' became the
  // string '2026-02-31'. Date.parse does not reject those, it rolls them into
  // the next month (February 31 parses as March 3), so every consumer that
  // parses this value silently reads a different day. Round-tripping the
  // parsed instant back to ISO is what catches it.
  return Number.isFinite(parseExactUtc(`${iso}T00:00:00`, 10)) ? iso : '';
}

// Same stamp family, full precision: GDELT 14-digit timestamp → epoch ms, NaN
// if unparseable. Single home for the parser (#5856 review): the bulk-export
// module delegates here, and server/ (chat-analyst headline ages) imports this
// pure module directly — Date.parse rejects the raw GDELT format, so every
// consumer needs this ISO reconstruction.
export function gdeltSeenDateToMs(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.length < 14) return Number.NaN;
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    + `T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
  // Same rollover as above, and it also catches a 24:00:00 clock stamp, which
  // Date.parse accepts as midnight on the following day.
  return parseExactUtc(iso, 19);
}

export function buildGdeltConflictUrl(cc, name = GDELT_COUNTRY_NAMES[cc], maxRecords = GDELT_MAX_ARTICLES_PER_COUNTRY) {
  const query = `"${name}" ${GDELT_CONFLICT_TERMS}`;
  return `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}`
    + `&mode=artlist&maxrecords=${maxRecords}&format=json&timespan=3d&sort=datedesc`;
}

function sanitizeGdeltHeadline(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function canonicalGdeltArticleUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    url.hash = '';
    const params = [...url.searchParams.entries()].sort(
      ([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB),
    );
    url.search = '';
    for (const [key, paramValue] of params) url.searchParams.append(key, paramValue);
    return url.toString();
  } catch {
    return '';
  }
}

// Small deterministic hash for bounded durable IDs. This is not a security
// primitive; its job is to keep GDELT's unbounded URL/title inputs out of IDs.
function stableHash(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function stableGdeltArticleId({ cc, eventDate, canonicalUrl, domain, title, seendate }) {
  // URLs are GDELT's closest article-level identity. Fall back to bounded,
  // normalized article content when a source omits or malforms its URL.
  const identity = canonicalUrl
    ? `url:${canonicalUrl}`
    : `article:${cc}|${eventDate}|${String(domain || '').trim().toLowerCase().slice(0, 128)}|${title.slice(0, 300)}|${String(seendate || '').replace(/[^0-9]/g, '').slice(0, 14)}`;
  return `gdelt-${cc}-${stableHash(identity)}`;
}

// Map a GDELT DOC 2.0 artlist response to conflict events in the ACLED/EMA shape.
// Every returned article is a location-filtered hit for `name`, so all are attributed
// to that country. Articles with an unparseable seendate are dropped (they can't be
// windowed by the EMA).
export function mapGdeltArticlesToEvents(articles, cc, name = GDELT_COUNTRY_NAMES[cc]) {
  if (!Array.isArray(articles) || !name) return [];
  return articles
    .map((a) => {
      const event_date = gdeltSeenDateToIso(a?.seendate);
      if (!event_date) return null;
      const title = sanitizeGdeltHeadline(a?.title);
      const url = canonicalGdeltArticleUrl(a?.url);
      return {
        id: stableGdeltArticleId({
          cc,
          eventDate: event_date,
          canonicalUrl: url,
          domain: a?.domain,
          title,
          seendate: a?.seendate,
        }),
        eventType: 'GDELT coverage',
        country: name,       // full name — matches UCDP / normalizeCountry
        event_date,          // 'YYYY-MM-DD' — the field the EMA engine reads
        occurredAt: Date.parse(event_date) || 0,
        source: a?.domain || '',
        title,
        url,
      };
    })
    .filter(Boolean);
}
