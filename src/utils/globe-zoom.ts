const GLOBE_ZOOM_ANCHORS = [
  { zoom: 1, altitude: 1.8 },
  { zoom: 2, altitude: 1.5 },
  // Named MENA/EU presets historically use altitude 1.2. Keeping it as an
  // explicit logical anchor makes their URL serialization round-trip exactly.
  { zoom: 2.5, altitude: 1.2 },
  { zoom: 3, altitude: 0.8 },
  { zoom: 4, altitude: 0.5 },
  { zoom: 5, altitude: 0.3 },
  { zoom: 6, altitude: 0.15 },
  { zoom: 7, altitude: 0.08 },
  { zoom: 8, altitude: 0.04 },
  { zoom: 9, altitude: 0.02 },
  { zoom: 10, altitude: 0.01 },
] as const;

const MIN_ZOOM = GLOBE_ZOOM_ANCHORS[0].zoom;
const MAX_ZOOM = GLOBE_ZOOM_ANCHORS[GLOBE_ZOOM_ANCHORS.length - 1]!.zoom;

function interpolateLogAltitude(
  zoom: number,
  farther: (typeof GLOBE_ZOOM_ANCHORS)[number],
  nearer: (typeof GLOBE_ZOOM_ANCHORS)[number],
): number {
  const progress = (zoom - farther.zoom) / (nearer.zoom - farther.zoom);
  return Math.exp(
    Math.log(farther.altitude)
    + progress * (Math.log(nearer.altitude) - Math.log(farther.altitude)),
  );
}

/** Converts the dashboard's logical 1-10 zoom scale to globe.gl altitude. */
export function mapZoomToGlobeAltitude(zoom: number | null | undefined): number {
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
    return GLOBE_ZOOM_ANCHORS[0].altitude;
  }
  const boundedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  if (boundedZoom === MIN_ZOOM) return GLOBE_ZOOM_ANCHORS[0].altitude;
  if (boundedZoom === MAX_ZOOM) {
    return GLOBE_ZOOM_ANCHORS[GLOBE_ZOOM_ANCHORS.length - 1]!.altitude;
  }
  const exactAnchor = GLOBE_ZOOM_ANCHORS.find((anchor) => anchor.zoom === boundedZoom);
  if (exactAnchor) return exactAnchor.altitude;
  for (let index = 0; index < GLOBE_ZOOM_ANCHORS.length - 1; index += 1) {
    const farther = GLOBE_ZOOM_ANCHORS[index]!;
    const nearer = GLOBE_ZOOM_ANCHORS[index + 1]!;
    if (boundedZoom < farther.zoom || boundedZoom > nearer.zoom) continue;
    return interpolateLogAltitude(boundedZoom, farther, nearer);
  }
  return GLOBE_ZOOM_ANCHORS[GLOBE_ZOOM_ANCHORS.length - 1]!.altitude;
}

/**
 * Converts globe.gl camera altitude into the dashboard's logical 1-10 zoom
 * scale. Interpolation keeps context honest after wheel/pinch zooms as well as
 * the exact altitude presets used by setView/setCenter.
 */
export function globeAltitudeToMapZoom(altitude: number | null | undefined): number {
  if (typeof altitude !== 'number' || !Number.isFinite(altitude)) return 1;
  if (altitude >= GLOBE_ZOOM_ANCHORS[0].altitude) return 1;
  const last = GLOBE_ZOOM_ANCHORS[GLOBE_ZOOM_ANCHORS.length - 1]!;
  if (altitude <= last.altitude) return last.zoom;
  const exactAnchor = GLOBE_ZOOM_ANCHORS.find((anchor) => anchor.altitude === altitude);
  if (exactAnchor) return exactAnchor.zoom;

  for (let index = 0; index < GLOBE_ZOOM_ANCHORS.length - 1; index += 1) {
    const farther = GLOBE_ZOOM_ANCHORS[index]!;
    const nearer = GLOBE_ZOOM_ANCHORS[index + 1]!;
    if (altitude > farther.altitude || altitude < nearer.altitude) continue;
    const progress = (Math.log(farther.altitude) - Math.log(altitude))
      / (Math.log(farther.altitude) - Math.log(nearer.altitude));
    return farther.zoom + progress * (nearer.zoom - farther.zoom);
  }

  return 1;
}
