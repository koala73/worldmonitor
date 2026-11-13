import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { ScreenOffset } from '@/utils/map-point-offset';

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
