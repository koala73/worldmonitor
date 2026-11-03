// Plane and sphere helpers for hit-testing and measuring map features.
import { haversineKm } from './geo.mjs';

export function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const u = len2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  return Math.hypot(px - (x0 + dx * u), py - (y0 + dy * u));
}

export function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polylineKm(points) {
  if (!points || points.length < 2) return 0;
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]);
  return km;
}
