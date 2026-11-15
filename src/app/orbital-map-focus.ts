import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { ScreenOffset } from '@/utils/map-point-offset';
import type { MapContainer } from '@/components/MapContainer';

/**
 * The deepest the map zooms while the lookup is open (#10704). The basemap is
 * PMTiles on a WorldMonitor host, and a tile request names the tile that holds
 * the viewport: 0.18 degrees wide at zoom 11 puts the point inside the request,
 * 2.8 degrees wide at zoom 7 does not.
 */
export const ORBITAL_LOOKUP_MAX_ZOOM = 7;

export interface MapCamera {
  lat: number;
  lon: number;
  zoom: number;
}

/** The parts of the dashboard map the lookup needs, registered without loading the lookup at startup. */
export interface OrbitalMapView {
  /** The map's box in client coordinates, or null when it is not on screen. */
  rect(): DOMRect | null;
  /** Centres the point `offset` pixels from the map's centre; false while the map cannot move yet. */
  center(point: GeoPoint, offset: ScreenOffset): boolean;
  /** Where the point is drawn in client coordinates, or null when the renderer cannot say. */
  project(point: GeoPoint): { x: number; y: number } | null;
  /** Stops or resumes the globe's idle spin, which would carry the point out of view. */
  hold(held: boolean): void;
  /** The map's centre and zoom, or null before it has a camera. */
  camera(): MapCamera | null;
  /** Caps how far the map can zoom in, or lifts the cap with null. The map is clamped at once if it is already past it. */
  capZoom(max: number | null): void;
  /** Jumps back with no animation: a gesture during an animated return would publish a centre near the point. */
  restore(camera: MapCamera): void;
}

/** The dashboard map as the lookup drives it. */
export type OrbitalViewport = Pick<MapContainer,
  'getViewportRect' | 'setCenterAt' | 'projectToClient' | 'holdAutoRotate' | 'getCenter' | 'getState' | 'setCenter' | 'capZoom'>;

export function orbitalMapViewFor(getMap: () => OrbitalViewport | null | undefined): OrbitalMapView {
  return {
    rect: () => getMap()?.getViewportRect() ?? null,
    center: (point, offset) => (getMap()?.setCenterAt(point.lat, point.lon, ORBITAL_LOOKUP_MAX_ZOOM, offset) ?? null) !== null,
    project: (point) => getMap()?.projectToClient(point.lat, point.lon) ?? null,
    hold: (held) => getMap()?.holdAutoRotate(held),
    camera: () => {
      const map = getMap();
      const centre = map?.getCenter();
      return centre && map ? { ...centre, zoom: map.getState().zoom } : null;
    },
    capZoom: (max) => getMap()?.capZoom(max),
    restore: ({ lat, lon, zoom }) => void getMap()?.setCenter(lat, lon, zoom, { instant: true }),
  };
}

let view: OrbitalMapView | null = null;

export function setOrbitalMapView(next: OrbitalMapView): () => void {
  view = next;
  return () => {
    if (view === next) view = null;
  };
}

export function getOrbitalMapView(): OrbitalMapView | null {
  return view;
}

const USER_MOVE_EVENTS = ['pointerdown', 'wheel', 'keydown'] as const;
let urlClaimed = false;
let stopWaiting: (() => void) | null = null;

/**
 * A lookup centres the map on the picked point, and the page URL is read by
 * analytics and error reporting, so the map's URL sync keeps the centre it
 * had before the lookup.
 */
export function claimMapUrlCentre(): void {
  stopWaiting?.();
  urlClaimed = true;
}

/** Hands the URL centre back once the user moves the map themselves; until then it still shows the picked point. */
export function releaseMapUrlCentreOnUserMove(map: HTMLElement | null): void {
  stopWaiting?.();
  if (!urlClaimed) return;
  if (!map) {
    urlClaimed = false;
    return;
  }
  const onInput = (event: Event) => {
    if (!(event.target instanceof Node) || !map.contains(event.target)) return;
    stopWaiting?.();
    urlClaimed = false;
  };
  for (const type of USER_MOVE_EVENTS) document.addEventListener(type, onInput, true);
  stopWaiting = () => {
    for (const type of USER_MOVE_EVENTS) document.removeEventListener(type, onInput, true);
    stopWaiting = null;
  };
}

export function isMapUrlCentreClaimed(): boolean {
  return urlClaimed;
}
