/**
 * Computes a zoom-adaptive supercluster radius in pixels.
 *
 * At low zoom levels the radius is expanded so that geographically distant
 * points on-screen are grouped into fewer, larger clusters — reducing the
 * number of draw calls and keeping the map readable.  At high zoom levels the
 * radius contracts to let clusters expand into individual markers sooner.
 *
 * @param baseRadius - Nominal pixel radius calibrated for mid-zoom (~6).
 * @param zoom       - Integer map zoom level returned by supercluster.
 * @returns Adjusted pixel radius clamped to a reasonable range.
 */
export function getDynamicClusterRadius(baseRadius: number, zoom: number): number {
  if (zoom <= 2) return Math.round(baseRadius * 1.5);
  if (zoom <= 4) return Math.round(baseRadius * 1.25);
  if (zoom >= 10) return Math.round(baseRadius * 0.75);
  return baseRadius;
}
