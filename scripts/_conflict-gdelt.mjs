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

// GDELT seendate is 'YYYYMMDDTHHMMSSZ' (or a digits-only variant). Return 'YYYY-MM-DD'
// (the format the EMA engine parses via Date.parse(ev.event_date)), or '' if unparseable.
export function gdeltSeenDateToIso(seendate) {
  const s = String(seendate || '').replace(/[^0-9]/g, '');
  if (s.length < 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function buildGdeltConflictUrl(cc, name = GDELT_COUNTRY_NAMES[cc], maxRecords = GDELT_MAX_ARTICLES_PER_COUNTRY) {
  const query = `"${name}" ${GDELT_CONFLICT_TERMS}`;
  return `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}`
    + `&mode=artlist&maxrecords=${maxRecords}&format=json&timespan=3d&sort=datedesc`;
}

// Map a GDELT DOC 2.0 artlist response to conflict events in the ACLED/EMA shape.
// Every returned article is a location-filtered hit for `name`, so all are attributed
// to that country. Articles with an unparseable seendate are dropped (they can't be
// windowed by the EMA).
export function mapGdeltArticlesToEvents(articles, cc, name = GDELT_COUNTRY_NAMES[cc]) {
  if (!Array.isArray(articles) || !name) return [];
  return articles
    .map((a, i) => {
      const event_date = gdeltSeenDateToIso(a?.seendate);
      if (!event_date) return null;
      return {
        id: `gdelt-${cc}-${i}`,
        eventType: 'GDELT coverage',
        country: name,       // full name — matches UCDP / normalizeCountry
        event_date,          // 'YYYY-MM-DD' — the field the EMA engine reads
        occurredAt: Date.parse(event_date) || 0,
        source: a?.domain || '',
        url: a?.url || '',
      };
    })
    .filter(Boolean);
}
