// src/data/tr3bRegistry.js
/**
 * @module tr3bRegistry
 * @description Session-scoped registry of contacts the operator has converted
 * into a TR-3B (the black-triangle Easter egg).
 *
 * Shared, module-level, cross-layer state — the same pattern as
 * `militaryRegistry.js`: identity is the ICAO 24-bit address, so a contact
 * stays converted whether the civil `flights` layer or the `military` layer
 * happens to own it, and a layer handoff never loses (or duplicates) the
 * conversion.
 *
 * DELIBERATELY NOT PERSISTED. No localStorage, no share-link param, no schema
 * change: the conversion lives for the page session and dies with a reload.
 * Layer teardown also leaves the set intact ON PURPOSE — the set holds nothing
 * but hex strings the user personally clicked (bounded by their own clicks),
 * and re-tracking the same aircraft after a layer restart should still show the
 * triangle. Only a reload resets it.
 */

/** @type {Set<string>} Converted contact ids, lower-cased ICAO 24-bit hex. */
const _converted = new Set();

/** The class/type label a converted contact reports in place of its real type. */
export const TR3B_TYPE_LABEL = 'TR-3B';

/**
 * The `aircraftClass` a converted contact reports to the analyst engine.
 *
 * Lower-case and hyphen-free to match the `classifyAircraft()` vocabulary
 * (`airliner`, `fastjet`, …) that every other analyst record uses — the engine
 * treats `aircraftClass` as a free-text field, so this is just one more value
 * to filter and group on, never an enum it has to know about. Deliberately the
 * STYLE-INDEPENDENT id, not the `tr3bHot` sprite variant: a query must return
 * the same answer in FLIR as in Normal.
 */
export const TR3B_CLASS = 'tr3b';

/** @param {*} id Raw contact id. @returns {string} Normalized registry key. */
function key(id) {
  return String(id ?? '').trim().toLowerCase();
}

/**
 * Whether a contact is currently rendered as a TR-3B.
 * @param {string} id ICAO 24-bit address (any case).
 * @returns {boolean}
 */
export function isTr3b(id) {
  const k = key(id);
  return k ? _converted.has(k) : false;
}

/**
 * Explicitly set a contact's conversion state.
 * @param {string} id ICAO 24-bit address.
 * @param {boolean} on True to convert, false to restore.
 * @returns {boolean} The resulting state (false for an unusable id).
 */
export function setTr3b(id, on) {
  const k = key(id);
  if (!k) return false;
  if (on === true) _converted.add(k);
  else _converted.delete(k);
  return _converted.has(k);
}

/**
 * Flip a contact between its real silhouette and the TR-3B.
 * @param {string} id ICAO 24-bit address.
 * @returns {boolean} The resulting state (false for an unusable id).
 */
export function toggleTr3b(id) {
  return setTr3b(id, !isTr3b(id));
}

/** @returns {string[]} Every currently converted id (lower-case hex). */
export function tr3bConvertedIds() {
  return [..._converted];
}

/** @returns {number} How many contacts are converted right now. */
export function tr3bCount() {
  return _converted.size;
}

/** Drop every conversion. Test/reset seam — production has no caller. */
export function clearTr3bRegistry() {
  _converted.clear();
}

/**
 * Resolve the sprite kind a contact's billboard should draw.
 *
 * Returns the aircraft's own class untouched for an unconverted contact, so
 * layers can route every `aircraftIcon()` call through this without changing
 * ordinary behaviour. Only the IMAGE is swapped: billboard scale still follows
 * the real class, so a converted 737 keeps a 737's on-screen footprint.
 * @param {string} id ICAO 24-bit address.
 * @param {string|undefined} klass The contact's classifyAircraft() kind.
 * @param {{hot?: boolean}} [options] `hot` = an IR/thermal style is active.
 * @returns {string|undefined} Sprite kind for `aircraftIcon()`.
 */
export function tr3bIconKind(id, klass, { hot = false } = {}) {
  if (!isTr3b(id)) return klass;
  return hot === true ? 'tr3bHot' : 'tr3b';
}

/**
 * Class/type label override for a converted contact.
 * @param {string} id ICAO 24-bit address.
 * @param {*} [fallback=null] Real label to use when the contact is not converted.
 * @returns {*} `'TR-3B'` when converted, else `fallback`.
 */
export function tr3bTypeLabel(id, fallback = null) {
  return isTr3b(id) ? TR3B_TYPE_LABEL : fallback;
}

/**
 * Analyst-record `aircraftClass` override for a converted contact, so a query
 * or superlative agrees with the triangle on screen instead of reporting the
 * airframe the conversion replaced.
 * @param {string} id ICAO 24-bit address.
 * @param {*} [fallback=null] Real class to use when the contact is not converted.
 * @returns {*} `'tr3b'` when converted, else `fallback`.
 */
export function tr3bAircraftClass(id, fallback = null) {
  return isTr3b(id) ? TR3B_CLASS : fallback;
}
