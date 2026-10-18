/**
 * In-body internal links between generated /countries/<slug>/ pages, plus the
 * one Pro/API link each country page carries.
 *
 * Related countries are derived from datasets the corpus build already reads.
 * Nothing is hand-listed per country:
 *
 *  1. Shared crisis tracker: shared/crawlable-crises.json coverage lists.
 *  2. Tension pair: shared/gdelt-tension-pairs.json `countries` pairs.
 *  3. Nearby: the gap between the two countries' bounding boxes in
 *     shared/country-bboxes.js is at most NEARBY_GAP_DEGREES. Microstates
 *     have no box, so for them the test is a mainland-centroid distance
 *     (scripts/data/country-centroids.json) of at most NEARBY_CENTROID_KM.
 *     France, Russia and the US use land-following parts instead
 *     (PROXIMITY_BOX_OVERRIDES), because their single box spans far-off
 *     territory. Either is a proximity proxy, not a land-border claim, so the
 *     copy says "nearby".
 *  4. Same region: shared/iso2-to-region.json.
 *
 * Candidates sort by the strongest signal first (crisis, tension, nearby,
 * region; among crisis ties, more shared trackers and then the smaller tracker
 * win; then a same-region candidate wins), then by mainland-centroid distance, then by name, so the order is
 * a pure function of the inputs. The list is capped at MAX_RELATED_COUNTRIES and
 * topped up to MIN_RELATED_COUNTRIES with the nearest country by centre
 * distance (then name) when the signals run out. Only countries that have a
 * generated page are candidates, and a country never links to itself.
 *
 * The section shows no rank or score. An unranked country's page and an
 * unranked target are described the same way, so no greyed-out country picks
 * up a rank claim from this section.
 *
 * Same-site links take no query tag (docs/solutions/conventions/
 * ref-param-is-affiliate-attribution-use-utm-for-internal-source-tags.md,
 * #8603): any utm_* key on an internal link is a bot 308. Attribution for the
 * Pro/API link rides data-umami-event attributes instead, the pattern the
 * research and welcome CTAs use.
 */

import { haversineKm } from '../shared/geo-distance.ts';

export const MIN_RELATED_COUNTRIES = 3;
export const MAX_RELATED_COUNTRIES = 5;
export const NEARBY_GAP_DEGREES = 1.5;
export const NEARBY_CENTROID_KM = 600;
export const TENSION_PAIRS_PATH = 'shared/gdelt-tension-pairs.json';
export const COUNTRY_CENTROIDS_PATH = 'scripts/data/country-centroids.json';

export const COUNTRY_PRO_LINK_HREF = '/pro#pricing';
export const COUNTRY_PRO_LINK_EVENT = 'country-page-cta';
export const COUNTRY_PRO_LINK_TARGET = 'pro-api-pricing';

const REASON_RANK = { crisis: 0, tension: 1, nearby: 2, region: 3, nearest: 4 };

function normalizeLon(lon) {
  let value = lon;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

/** [south, west, north, east] with west > east crossing the antimeridian. */
function boxGeometry(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const [south, west, north, rawEast] = bounds.map(Number);
  if (![south, west, north, rawEast].every(Number.isFinite) || south > north) return null;
  // A whole-globe box (Antarctica) says nothing about proximity.
  if (west === -180 && rawEast === 180) return null;
  const east = west > rawEast ? rawEast + 360 : rawEast;
  return {
    south,
    north,
    west,
    east,
    centerLat: (south + north) / 2,
    centerLon: normalizeLon((west + east) / 2),
  };
}

function lonGap(a, b) {
  let best = Infinity;
  for (const shift of [-360, 0, 360]) {
    const west = b.west + shift;
    const east = b.east + shift;
    best = Math.min(best, Math.max(0, west - a.east, a.west - east));
  }
  return best;
}

/** Approximate gap between two boxes in degrees of latitude. 0 when they touch or overlap. */
export function boundingBoxGapDegrees(left, right) {
  const a = boxGeometry(left);
  const b = boxGeometry(right);
  if (!a || !b) return Infinity;
  const latGap = Math.max(0, b.south - a.north, a.south - b.north);
  const nearLat = Math.min(89, Math.abs(Math.max(a.south, b.south) + Math.min(a.north, b.north)) / 2);
  const lonScaled = lonGap(a, b) * Math.cos((nearLat * Math.PI) / 180);
  return Math.hypot(latGap, lonScaled);
}

/**
 * Proximity boxes for the three countries whose single shared/country-bboxes.js
 * box spans far-off territory, as [south, west, north, east] parts. With one
 * box, French Guiana put France "nearby" Liberia, Canada and Suriname, and
 * Russia's Kaliningrad-to-Caucasus box covered the Balkans. The parts follow
 * the land: Russia's south-west edge runs along Ukraine and the Caucasus, not
 * Romania or Moldova. They feed only the "nearby" test here; the map and other
 * pages keep the shared box.
 */
export const PROXIMITY_BOX_OVERRIDES = Object.freeze({
  // Metropolitan France with Corsica; French Guiana and the islands are excluded.
  FR: [[41.33, -5.14, 51.09, 9.56]],
  RU: [
    [54.3, 19.6, 55.3, 22.9], // Kaliningrad
    [56.0, 27.3, 70.0, 60.0], // north-west, from the Baltic states to the Urals
    [50.0, 31.0, 56.0, 60.0], // centre, from Belarus and Ukraine to Orenburg
    [41.19, 36.5, 50.0, 48.5], // south, from the Sea of Azov to the Caucasus and Astrakhan
    [49.0, 60.0, 81.29, 120.0], // Siberia, north of Kazakhstan and Mongolia
    [42.29, 120.0, 81.29, 180], // Far East to the antimeridian
    [64.0, -180, 72.0, -169.7], // Chukotka east of the antimeridian
  ],
  US: [
    [24.4, -125.0, 49.39, -66.94], // contiguous states
    [51.2, 172.4, 71.4, -129.9], // Alaska with the Aleutians; Hawaii is left out
  ],
});

const pointBox = (point) => (point ? [point[0], point[1], point[0], point[1]] : null);

/**
 * Smallest gap between any proximity box of each country. A microstate
 * without a box is treated as its centroid, so Monaco sits inside France's
 * box (gap 0) rather than 500 km from France's mainland centroid.
 */
function proximityGapDegrees(ownBoxes, candidateBoxes) {
  let best = Infinity;
  for (const own of ownBoxes) {
    for (const candidate of candidateBoxes) best = Math.min(best, boundingBoxGapDegrees(own, candidate));
  }
  return best;
}

/** Great-circle distance in kilometres between two [lat, lon] points; Infinity when either is missing. */
function greatCircleKm(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return Infinity;
  const [lat1, lon1] = left.map(Number);
  const [lat2, lon2] = right.map(Number);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  return haversineKm(lat1, lon1, lat2, lon2);
}

/** A country's reference point: its mainland centroid, else its box centre. */
function anchorPoint(centroid, bounds) {
  if (Array.isArray(centroid) && centroid.length === 2 && centroid.every((value) => Number.isFinite(Number(value)))) {
    return centroid.map(Number);
  }
  const box = boxGeometry(bounds);
  return box ? [box.centerLat, box.centerLon] : null;
}

function tensionLabelsByPair(tensionPairs) {
  const out = new Map();
  for (const pair of tensionPairs || []) {
    const codes = Array.isArray(pair?.countries)
      ? pair.countries.map((code) => String(code || '').toUpperCase())
      : [];
    if (codes.length !== 2 || codes.some((code) => !/^[A-Z]{2}$/.test(code)) || codes[0] === codes[1]) continue;
    const key = [...codes].sort().join(':');
    if (!out.has(key)) out.set(key, String(pair.label || codes.join('-')));
  }
  return out;
}

function smallestTracker(candidate) {
  return candidate.sharedCrises.reduce((min, crisis) => Math.min(min, crisis.size), Infinity);
}

function compareCandidates(left, right) {
  return REASON_RANK[left.reason] - REASON_RANK[right.reason]
    || right.sharedCrises.length - left.sharedCrises.length
    // A two-country tracker is a tighter tie than an eight-country one.
    || smallestTracker(left) - smallestTracker(right)
    // Box proximity is coarse, so among equal signals a country in the same
    // region outranks one across a sea or a regional boundary.
    || Number(right.sameRegion) - Number(left.sameRegion)
    || (left.reason === 'nearby' ? left.gapDegrees - right.gapDegrees : 0)
    || left.distanceKm - right.distanceKm
    || left.name.localeCompare(right.name, 'en')
    || left.code.localeCompare(right.code, 'en');
}

/**
 * code -> [{ code, name, slug, reason, detail }] for every country in
 * `countries`. `countries` is the published country set: { code, name, slug,
 * regionId?, regionName?, crisisMemberships? }.
 */
export function selectRelatedCountries({
  countries,
  bboxByCode = new Map(),
  centroidByCode = {},
  tensionPairs = [],
  regionsByCode = {},
  regionLabels = {},
  proximityBoxesByCode = PROXIMITY_BOX_OVERRIDES,
} = {}) {
  const published = (countries || []).filter((country) => (
    /^[A-Z]{2}$/.test(String(country?.code || '')) && country.slug && country.name
  ));
  const tensionLabels = tensionLabelsByPair(tensionPairs);
  const bboxOf = (code) => (bboxByCode instanceof Map ? bboxByCode.get(code) : bboxByCode?.[code]) || null;
  const centroidOf = (code) => (centroidByCode instanceof Map ? centroidByCode.get(code) : centroidByCode?.[code]) || null;
  const pointOf = (code) => anchorPoint(centroidOf(code), bboxOf(code));
  const proximityBoxesOf = (code, box, point) => {
    if (proximityBoxesByCode?.[code]) return proximityBoxesByCode[code];
    const fallback = box || pointBox(point);
    return fallback ? [fallback] : [];
  };
  const regionOf = (country) => country.regionId || regionsByCode[country.code] || null;
  const crisesOf = (country) => (country.crisisMemberships || []).map((crisis) => ({
    slug: String(crisis.slug),
    shortTitle: String(crisis.shortTitle || crisis.title || crisis.slug),
    size: Array.isArray(crisis.coverage) ? crisis.coverage.length : Infinity,
  }));

  const result = new Map();
  for (const country of published) {
    const ownCrises = crisesOf(country);
    const ownRegion = regionOf(country);
    const ownBox = bboxOf(country.code);
    const ownPoint = pointOf(country.code);
    const ownProximityBoxes = proximityBoxesOf(country.code, ownBox, ownPoint);
    const candidates = published
      .filter((candidate) => candidate.code !== country.code && candidate.slug !== country.slug)
      .map((candidate) => {
        const candidateCrisisSlugs = new Set(crisesOf(candidate).map((crisis) => crisis.slug));
        const sharedCrises = ownCrises
          .filter((crisis) => candidateCrisisSlugs.has(crisis.slug))
          .sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
        const tensionLabel = tensionLabels.get([country.code, candidate.code].sort().join(':')) || null;
        const candidateBox = bboxOf(candidate.code);
        const candidatePoint = pointOf(candidate.code);
        const distanceKm = greatCircleKm(ownPoint, candidatePoint);
        const gapDegrees = proximityGapDegrees(
          ownProximityBoxes,
          proximityBoxesOf(candidate.code, candidateBox, candidatePoint),
        );
        const nearby = gapDegrees <= NEARBY_GAP_DEGREES
          || ((!ownBox || !candidateBox) && distanceKm <= NEARBY_CENTROID_KM);
        const sameRegion = ownRegion != null && ownRegion !== 'global' && regionOf(candidate) === ownRegion;
        let reason = 'nearest';
        let detail = 'nearest country with a profile';
        if (sharedCrises.length > 0) {
          reason = 'crisis';
          detail = `shares the ${sharedCrises.map((crisis) => crisis.shortTitle).join(' and ')} crisis tracker${sharedCrises.length > 1 ? 's' : ''}`;
        } else if (tensionLabel) {
          reason = 'tension';
          detail = `${tensionLabel} tension pair in the GDELT monitor`;
        } else if (nearby) {
          reason = 'nearby';
          // Only a shared region is named: Russia's box reaches Japan, but
          // Russia is not "nearby in Europe" from Japan's page.
          detail = sameRegion && regionLabels[ownRegion] ? `nearby in ${regionLabels[ownRegion]}` : 'nearby';
        } else if (sameRegion) {
          reason = 'region';
          detail = `also in ${regionLabels[ownRegion] || 'the same region'}`;
        }
        return {
          code: candidate.code,
          name: candidate.name,
          slug: candidate.slug,
          reason,
          detail,
          sharedCrises,
          sameRegion,
          gapDegrees,
          distanceKm,
        };
      })
      .sort(compareCandidates);
    const signalled = candidates.filter((candidate) => candidate.reason !== 'nearest');
    const picked = signalled.slice(0, MAX_RELATED_COUNTRIES);
    if (picked.length < MIN_RELATED_COUNTRIES) {
      const fill = candidates
        .filter((candidate) => candidate.reason === 'nearest')
        .slice(0, MIN_RELATED_COUNTRIES - picked.length);
      picked.push(...fill);
    }
    result.set(country.code, picked.map(({ code, name, slug, reason, detail }) => ({ code, name, slug, reason, detail })));
  }
  return result;
}

export function relatedCountryAnchorText(target) {
  return `${target.name} resilience and risk profile`;
}

export function renderRelatedCountries(country, related, escapeHtml) {
  if (!related?.length) return '';
  return `      <h2>Related country profiles</h2>
      <p>Linked to ${escapeHtml(country.name)} by a shared crisis tracker, a monitored tension pair, proximity or region.</p>
      <ul class="related-countries" data-related-countries>
${related.map((target) => `        <li data-related-reason="${escapeHtml(target.reason)}"><a href="/countries/${escapeHtml(target.slug)}/">${escapeHtml(relatedCountryAnchorText(target))}</a>: ${escapeHtml(target.detail)}.</li>`).join('\n')}
      </ul>`;
}

export function renderCountryProLink(country, escapeHtml) {
  const name = escapeHtml(country.name);
  return `      <p data-country-pro-link>Need ${name} signals in your own workflow? <a href="${escapeHtml(COUNTRY_PRO_LINK_HREF)}" data-umami-event="${COUNTRY_PRO_LINK_EVENT}" data-umami-event-target="${COUNTRY_PRO_LINK_TARGET}" data-umami-event-country="${escapeHtml(country.code)}">Compare World Monitor Pro and API plans for ${name} risk data</a>. Pro adds alert rules and AI digests; API plans serve country resilience and instability data over REST.</p>`;
}

/**
 * Both blocks in one wrapper, so page-length guards can count this bounded
 * navigation block apart from the country prose.
 */
export function renderCountryRelatedLinks(country, related, escapeHtml) {
  return `      <section data-country-related-links aria-label="Related countries and data access">
${[renderRelatedCountries(country, related, escapeHtml), renderCountryProLink(country, escapeHtml)].filter(Boolean).join('\n')}
      </section>`;
}
