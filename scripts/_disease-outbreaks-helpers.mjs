// Pure helpers extracted from seed-disease-outbreaks.mjs so tests can import
// them without triggering the seeder's top-level runSeed() call (which would
// exit the process on import).
//
// The seeder's three parsers (WHO DON / RSS / TGH) do network I/O, but the
// PER-ITEM normalization shape is pure and what we want to lock in tests:
//
//   - synthetic-timestamp tagging (WHO/RSS fall back to nowMs when upstream
//     omits a date; TGH always carries a real date by the time it reaches
//     this layer because the line-198 filter rejects undated records earlier)
//   - mapItem composition (id, disease/location detection, lat/lng defaults)
//   - contentMeta (filters synthetic + clock-skew, picks newest/oldest)
//   - publishTransform (strips helpers before atomicPublish)
//
// Extracting these out of the seeder gives Sprint 2's tests a single source
// of truth — drift between test fixtures and seeder shape is impossible
// because the test imports the same code.

import { extractCountryCode } from './shared/geo-extract.mjs';

// WHO DON uses multi-word or hyphenated country names that the bigram scanner misses.
// These override extractCountryCode for exact substring matches (checked first, case-insensitive).
const WHO_NAME_OVERRIDES = {
  'democratic republic of the congo': 'CD',
  'dr congo': 'CD',
  'timor-leste': 'TL',
  'east timor': 'TL',
  'papua new guinea': 'PG',
  'kingdom of saudi arabia': 'SA',
  'united kingdom': 'GB',
};

export function extractCountryCodeFull(text) {
  const lower = text.toLowerCase();
  for (const [name, iso2] of Object.entries(WHO_NAME_OVERRIDES)) {
    if (lower.includes(name)) return iso2;
  }
  return extractCountryCode(text) ?? '';
}

export function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Extract location string from WHO-style titles.
 * Handles: "Disease – Country" (em-dash), "Disease - Country" (hyphen), "Disease in Country".
 */
export function extractLocationFromTitle(title) {
  // WHO DON pattern: "Disease – Country" or "Disease - Country" (one or more dash-separated segments)
  // Split on em-dash, en-dash, or " - " / " – " to get all segments, then take the last capitalized one.
  const segments = title.split(/\s*[–—]\s*|\s+-\s+/);
  if (segments.length >= 2) {
    const last = segments[segments.length - 1].trim();
    if (/^[A-Z]/.test(last)) return last;
  }
  // Fallback: "... in <Country/Region>"
  const inMatch = title.match(/\bin\s+([A-Z][^,.(]+)/);
  if (inMatch) return inMatch[1].trim();
  return '';
}

export function detectAlertLevel(title, desc) {
  const text = `${title} ${desc}`.toLowerCase();
  if (text.includes('outbreak') || text.includes('emergency') || text.includes('epidemic') || text.includes('pandemic')) return 'alert';
  if (text.includes('warning') || text.includes('spread') || text.includes('cases increasing')) return 'warning';
  return 'watch';
}

export function detectDisease(title) {
  const lower = title.toLowerCase();
  const known = ['mpox', 'monkeypox', 'ebola', 'cholera', 'covid', 'dengue', 'measles',
    'polio', 'marburg', 'lassa', 'plague', 'yellow fever', 'typhoid', 'influenza',
    'avian flu', 'h5n1', 'h5n2', 'anthrax', 'rabies', 'meningitis', 'hepatitis',
    'nipah', 'rift valley', 'crimean-congo', 'leishmaniasis', 'malaria', 'diphtheria',
    'chikungunya', 'botulism', 'brucellosis', 'salmonella', 'listeria', 'e. coli',
    'norovirus', 'legionella', 'campylobacter'];
  for (const d of known) {
    if (lower.includes(d)) return d.charAt(0).toUpperCase() + d.slice(1);
  }
  return 'Unknown Disease';
}

// ── Per-item normalization (shape contract for content-age) ──────────────
//
// All three parsers produce items in the SAME shape so contentMeta and
// publishTransform can be uniform. The pre-publish in-memory shape carries:
//   - publishedMs:                  non-null number (Date.now() fallback for
//                                   UI/RPC consumer compat)
//   - _originalPublishedMs:         parsed-ms or null (null when synthetic)
//   - _publishedAtIsSynthetic:      boolean — true when publishedMs was a fallback
// publishTransform strips the underscore-prefixed helpers before publish.

/**
 * Normalize one WHO DON API item.
 * @param {object} item - raw WHO DON API entry: { Title, ItemDefaultUrl, PublicationDateAndTime }
 * @param {number} nowMs - injectable "now" for deterministic tests; defaults to Date.now()
 */
export function whoNormalizeItem(item, nowMs = Date.now()) {
  const origMs = item.PublicationDateAndTime ? new Date(item.PublicationDateAndTime).getTime() : null;
  const hasOrig = origMs != null && Number.isFinite(origMs);
  return {
    title: (item.Title || '').trim(),
    link: item.ItemDefaultUrl ? `https://www.who.int${item.ItemDefaultUrl}` : '',
    desc: '',
    publishedMs: hasOrig ? origMs : nowMs,
    _originalPublishedMs: hasOrig ? origMs : null,
    _publishedAtIsSynthetic: !hasOrig,
    sourceName: 'WHO',
  };
}

/**
 * Normalize one RSS item (CDC HAN, Outbreak News Today).
 * @param {object} parsed - { title, link, desc, pubDate, sourceName }
 * @param {number} nowMs - injectable "now"
 */
export function rssNormalizeItem({ title, link, desc, pubDate, sourceName }, nowMs = Date.now()) {
  const origMs = pubDate ? new Date(pubDate).getTime() : null;
  const hasOrig = origMs != null && Number.isFinite(origMs);
  return {
    title, link, desc,
    publishedMs: hasOrig ? origMs : nowMs,
    sourceName,
    _originalPublishedMs: hasOrig ? origMs : null,
    _publishedAtIsSynthetic: !hasOrig,
  };
}

/**
 * Normalize one ThinkGlobalHealth record.
 * Caller is expected to have already filtered out records with missing/unparseable dates
 * (the seeder does this at line ~198), so TGH items are always non-synthetic.
 * @param {object} rec - parsed TGH record
 */
export function tghNormalizeItem(rec) {
  const publishedMs = new Date(rec.date).getTime();
  // place_name from TGH is often "City, District, Country" — take only the first segment for display.
  const cityName = (rec.placeName || '').split(',')[0].trim() || rec.country || '';
  return {
    title: `${rec.disease}${rec.country ? ` - ${rec.country}` : ''}`,
    link: rec.sourceUrl || '',
    desc: rec.summary ? rec.summary.slice(0, 300) : '',
    publishedMs,
    sourceName: 'ThinkGlobalHealth',
    _country: rec.country || '',
    _disease: rec.disease || '',
    _location: cityName,
    _lat: Number.isFinite(rec.lat) ? rec.lat : null,
    _lng: Number.isFinite(rec.lng) ? rec.lng : null,
    _cases: rec.cases ?? 0,
    _originalPublishedMs: publishedMs,
    _publishedAtIsSynthetic: false,
  };
}

/**
 * Map a normalized parser item to the cached `outbreaks[]` shape.
 * Carries pre-publish helpers (`_publishedAtIsSynthetic`, `_originalPublishedMs`)
 * for contentMeta to read at runSeed time. publishTransform strips them
 * before atomicPublish so they never reach the canonical key or clients.
 */
export function mapItem(item) {
  const location = item._location || extractLocationFromTitle(item.title)
    || (item.sourceName === 'CDC' ? 'United States' : '');
  const disease = item._disease || detectDisease(item.title);
  const countryCode = item._country
    ? (extractCountryCodeFull(item._country) || extractCountryCodeFull(location || item.title))
    : extractCountryCodeFull(location || `${item.title} ${item.desc}`);
  return {
    id: `${item.sourceName.toLowerCase()}-${stableHash(item.link || item.title)}-${item.publishedMs}`,
    disease,
    location,
    countryCode,
    alertLevel: detectAlertLevel(item.title, item.desc),
    summary: item.desc,
    sourceUrl: item.link,
    publishedAt: item.publishedMs,
    sourceName: item.sourceName,
    lat: item._lat ?? 0,
    lng: item._lng ?? 0,
    cases: item._cases || 0,
    // PRE-PUBLISH HELPERS — see header comment.
    _publishedAtIsSynthetic: item._publishedAtIsSynthetic === true,
    _originalPublishedMs: item._originalPublishedMs ?? null,
  };
}

// ── Content-age contract surfaces (Sprint 2) ─────────────────────────────

/**
 * Compute newest/oldest content timestamps from the disease-outbreaks payload.
 *
 * - Excludes items whose timestamp was synthetic (Date.now() fallback when
 *   upstream omitted a date) — preserving them would falsely report content
 *   as fresh and mask real upstream silence.
 * - Excludes future-dated items beyond 1h clock-skew tolerance.
 * - Returns null when no items have a usable timestamp — runSeed writes
 *   newestItemAt: null, classifier reads as STALE_CONTENT.
 *
 * @param {{outbreaks: Array}} data
 * @param {number} nowMs - injectable "now" for deterministic tests
 */
export function diseaseContentMeta(data, nowMs = Date.now()) {
  const items = Array.isArray(data?.outbreaks) ? data.outbreaks : [];
  let newest = -Infinity, oldest = Infinity, validCount = 0;
  const skewLimit = nowMs + 60 * 60 * 1000;
  for (const item of items) {
    if (item._publishedAtIsSynthetic === true) continue;
    const ts = item._originalPublishedMs;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
    if (ts > skewLimit) continue;
    validCount++;
    if (ts > newest) newest = ts;
    if (ts < oldest) oldest = ts;
  }
  if (validCount === 0) return null;
  return { newestItemAt: newest, oldestItemAt: oldest };
}

/**
 * Strip pre-publish helper fields from every outbreak before atomicPublish.
 * Helpers (_publishedAtIsSynthetic, _originalPublishedMs) MUST NOT appear in:
 *   - the Redis canonical key (health:disease-outbreaks:v1)
 *   - /api/bootstrap response (data.diseaseOutbreaks)
 *   - list-disease-outbreaks RPC response
 *   - the DiseaseOutbreakItem proto-generated type
 */
export function diseasePublishTransform(data) {
  const outbreaks = Array.isArray(data?.outbreaks) ? data.outbreaks : [];
  return {
    ...data,
    outbreaks: outbreaks.map((item) => {
      const { _publishedAtIsSynthetic: _a, _originalPublishedMs: _b, ...rest } = item;
      return rest;
    }),
  };
}

/** Sprint 2 pilot threshold (9 days). Single source of truth — exported so the
 *  seeder uses the same constant the test asserts against. */
export const DISEASE_MAX_CONTENT_AGE_MIN = 9 * 24 * 60;
