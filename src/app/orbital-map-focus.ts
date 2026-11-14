import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { ScreenOffset } from '@/utils/map-point-offset';

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
  /** Hides or redraws the dashboard's data layers without changing the saved layer toggles. */
  suppressLayers(suppressed: boolean): void;
  /** The map's centre and zoom, or null before it has a camera. */
  camera(): MapCamera | null;
  restore(camera: MapCamera): void;
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
