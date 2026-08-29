/**
 * Satellite classification — CelesTrak source group → operator-legible class.
 *
 * The catalog already tags every satellite with the CelesTrak group it was
 * ingested from (`CATALOG_GROUPS` in satellites.js), so classification is a
 * pure lookup: no extra fetch, no heuristics, no per-frame work. This module is
 * the single source of truth for the class a satellite belongs to, the label
 * shown on its card, and the point color it renders in — the render path, the
 * tracked card, and the row legend all read the same table, so a palette edit
 * can never leave one surface disagreeing with another.
 *
 * Deliberately Cesium-free: colors are CSS hex strings that satellites.js
 * converts once at module load. That keeps this file unit-testable and lets the
 * legend swatches reuse the exact same strings the points are drawn with.
 *
 * Class order below is the legend order: crewed first (the objects people look
 * for), then the constellations users can actually name, then the grab-bag.
 */

/**
 * Class registry. `label` is the card/legend token, `color` the point color,
 * `blurb` the plain-language gloss for the legend tooltip.
 * @type {Readonly<Record<string, { label: string, color: string, blurb: string }>>}
 */
export const SATELLITE_CLASSES = Object.freeze({
  station: Object.freeze({
    label: 'STATION',
    // Warm white — "crewed", and the brightest class in the sky. Deliberately
    // NOT amber: 40-48deg amber is the app's known-military convention
    // (flights.js MIL_TINT / militaryFlights.js MIL_ICON_COLOR) and must not
    // leak into another domain. Slightly warm so it also separates from the
    // pure white the civilian air fleet draws in.
    color: '#fff6e5',
    blurb: 'Crewed stations and their visiting vehicles',
  }),
  nav: Object.freeze({
    label: 'NAV',
    // Cyan — the strongest accent goes to the class users actually name
    // ("how many GPS satellites are up?"). Takes over the slot the catch-all
    // VISUAL group used to occupy, so this adds no new hue to the app.
    color: '#4fd8ff',
    blurb: 'GNSS navigation — GPS, GLONASS, Galileo',
  }),
  geo: Object.freeze({
    label: 'GEO',
    // Violet, unchanged. Already the app's "space" semantic (the detection
    // overlay paints the SAT tier #bda4ff), and the geostationary belt draws
    // as one clean equatorial ring at globe scale.
    color: '#c89bff',
    blurb: 'Geostationary belt — comms and weather, fixed over the equator',
  }),
  visual: Object.freeze({
    label: 'VISUAL',
    // Muted blue-gray. This is the catch-all bucket, so it gives up the bright
    // cyan it used to hold and recedes behind the three classes that mean
    // something. Still well clear of the dense shell by luminance.
    color: '#9fb3c4',
    blurb: 'Brightest naked-eye objects — CelesTrak visual group',
  }),
  comms: Object.freeze({
    label: 'COMMS',
    // Dim slate — thousands of these appear in DENSE mode. They must read as
    // texture behind the core catalog, never compete with it. Rec.601 luma
    // ~0.40 against VISUAL's ~0.69 keeps the two separable even when the
    // NVG/FLIR shaders collapse the scene to a single channel.
    color: '#54697f',
    blurb: 'Broadband constellation shell — shown only in DENSE mode',
  }),
});

/** Legend/report order for the classes above. */
export const SATELLITE_CLASS_ORDER = Object.freeze(['station', 'nav', 'geo', 'visual', 'comms']);

/**
 * CelesTrak group tag → { class, subtype }. Subtype names the specific
 * constellation so the card can read "NAV · GPS" rather than a bare "NAV".
 * Keys must stay in sync with CATALOG_GROUPS + the 'dense' tag in satellites.js.
 */
const GROUP_CLASS = Object.freeze({
  stations: Object.freeze({ klass: 'station', subtype: null }),
  visual: Object.freeze({ klass: 'visual', subtype: null }),
  'gps-ops': Object.freeze({ klass: 'nav', subtype: 'GPS' }),
  glonass: Object.freeze({ klass: 'nav', subtype: 'GLONASS' }),
  galileo: Object.freeze({ klass: 'nav', subtype: 'GALILEO' }),
  geo: Object.freeze({ klass: 'geo', subtype: null }),
  dense: Object.freeze({ klass: 'comms', subtype: 'STARLINK' }),
});

/** Unknown groups fall back to the neutral bucket rather than vanishing. */
const FALLBACK = Object.freeze({ klass: 'visual', subtype: null });

/**
 * The ISS is always a STATION, whichever group ingested it. CelesTrak lists it
 * in `visual` as well as `stations`, and a catalog rebuild survives a partial
 * group outage — so a dropped stations feed would otherwise file the ISS under
 * VISUAL in both its label and the legend tally.
 */
const ISS_CLASS = Object.freeze({ klass: 'station', subtype: 'ISS' });

/**
 * Resolve a satellite to its class key and constellation subtype. This is the
 * ONLY place the ISS special case lives; the label and the legend tally both
 * route through here so they can never disagree about what the ISS is.
 * @param {string|undefined|null} group CelesTrak group tag (see GROUP_CLASS).
 * @param {{ isIss?: boolean }} [options] Whether this satellite is the ISS.
 * @returns {{ klass: string, subtype: string|null }} Class key and subtype.
 */
export function satelliteClassOf(group, { isIss = false } = {}) {
  if (isIss) return ISS_CLASS;
  return GROUP_CLASS[group] || FALLBACK;
}

/**
 * Point color for a catalog group, as a CSS hex string.
 * @param {string|undefined|null} group CelesTrak group tag.
 * @returns {string} CSS hex color.
 */
export function satelliteClassColor(group) {
  return SATELLITE_CLASSES[satelliteClassOf(group).klass].color;
}

/**
 * Operator-facing class label for a satellite — the text field shown on the
 * tracked card and the detection overlay ("NAV · GPS", "GEO", "STATION · ISS").
 * The ISS is the one object named individually: it is the reason most people
 * open this layer, and its dot is already styled apart from its class.
 *
 * The ISS is always a STATION regardless of which group ingested it — see
 * satelliteClassOf, which owns that rule for every consumer.
 * @param {string|undefined|null} group CelesTrak group tag.
 * @param {{ isIss?: boolean }} [options] Whether this is the ISS.
 * @returns {string} Display label.
 */
export function satelliteClassLabel(group, { isIss = false } = {}) {
  const { klass, subtype } = satelliteClassOf(group, { isIss });
  const base = SATELLITE_CLASSES[klass].label;
  return subtype ? `${base} · ${subtype}` : base;
}

/**
 * Tally satellites into a class → count record.
 * Split from the legend builder so the counting rule stays independent of how
 * the legend is presented. Entries may be bare group tags, or `{ group, isIss }`
 * descriptors when the caller can identify the ISS — the tally classifies
 * through satelliteClassOf, so the legend and the card always agree.
 * @param {Iterable<string|undefined|null|{group?: string, isIss?: boolean}>} entries
 *   One entry per satellite.
 * @returns {Record<string, number>} Class key → count.
 */
export function tallySatelliteClasses(entries) {
  const counts = Object.create(null);
  for (const entry of entries || []) {
    const descriptor = entry && typeof entry === 'object' ? entry : { group: entry };
    const { klass } = satelliteClassOf(descriptor.group, { isIss: descriptor.isIss });
    counts[klass] = (counts[klass] || 0) + 1;
  }
  return counts;
}

/**
 * Build the layer-row legend from a class tally.
 * Classes with no members are omitted so the legend never advertises a class
 * that is not on screen (COMMS only appears once DENSE is on).
 * @param {Record<string, number>} counts Class key → count (see tallySatelliteClasses).
 * @returns {Array<{ klass: string, label: string, color: string, blurb: string, count: number }>}
 *   Present classes in legend order.
 */
export function satelliteClassLegend(counts) {
  const result = [];
  for (const klass of SATELLITE_CLASS_ORDER) {
    const count = counts?.[klass];
    if (!(count > 0)) continue;
    const spec = SATELLITE_CLASSES[klass];
    result.push({ klass, label: spec.label, color: spec.color, blurb: spec.blurb, count });
  }
  return result;
}
