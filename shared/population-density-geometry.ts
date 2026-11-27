/** Ray-cast containment for the generated density-country rings. */
export type Ring = number[][];

const LATITUDE_BANDS = new WeakMap<Ring, Map<number, number[]>>();

/** Edge end-indices whose latitude range overlaps the query's one-degree bands. */
export function ringEdgesNearLatitude(ring: Ring, lat: number, margin = 0): number[] {
  let bands = LATITUDE_BANDS.get(ring);
  if (!bands) {
    bands = new Map();
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const south = Math.floor(Math.min(ring[i]![1]!, ring[j]![1]!));
      const north = Math.floor(Math.max(ring[i]![1]!, ring[j]![1]!));
      for (let band = south; band <= north; band++) {
        let edges = bands.get(band);
        if (!edges) bands.set(band, edges = []);
        edges.push(i);
      }
    }
    LATITUDE_BANDS.set(ring, bands);
  }
  const south = Math.floor(lat - margin);
  const north = Math.floor(lat + margin);
  if (south === north) return bands.get(south) ?? [];
  const edges = new Set<number>();
  for (let band = south; band <= north; band++) {
    for (const i of bands.get(band) ?? []) edges.add(i);
  }
  return [...edges];
}

export function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (const i of ringEdgesNearLatitude(ring, lat)) {
    const j = i === 0 ? ring.length - 1 : i - 1;
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi! > lat) !== (yj! > lat) && lon < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) {
      inside = !inside;
    }
  }
  return inside;
}
