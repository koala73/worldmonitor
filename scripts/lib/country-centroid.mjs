// Position for an item a source locates only by country. Generated from the
// country boundaries by scripts/build-country-centroids.mjs.
import centroids from '../data/country-centroids.json' with { type: 'json' };

/** @returns {{ lat: number, lng: number } | null} */
export function countryCentroid(code) {
  const point = centroids[String(code ?? '').toUpperCase()];
  return point ? { lat: point[0], lng: point[1] } : null;
}
