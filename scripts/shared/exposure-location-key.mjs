/** One exposure row per rounded location (~100 m); shared with scripts-only workers.
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
export function exposureLocationKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}
