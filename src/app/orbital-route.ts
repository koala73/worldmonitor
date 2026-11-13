import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';

export type OrbitalRouteView = 'sheet' | 'full';

export interface OrbitalRoute {
  point: GeoPoint;
  view: OrbitalRouteView;
}

const ROUTE_RE = /^#?orbital=(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:&view=(full))?$/;

/** Reads `#orbital=<lat>,<lon>[&view=full]`. */
export function parseOrbitalRoute(hash: string): OrbitalRoute | null {
  const match = ROUTE_RE.exec(hash);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { point: { lat, lon }, view: match[3] === 'full' ? 'full' : 'sheet' };
}

export function formatOrbitalRoute(point: GeoPoint, view: OrbitalRouteView): string {
  return `#orbital=${point.lat.toFixed(4)},${point.lon.toFixed(4)}${view === 'full' ? '&view=full' : ''}`;
}

function applyRoute(): void {
  const route = parseOrbitalRoute(window.location.hash);
  void import('@/app/orbital-watch').then(({ openOrbitalWatch, leaveOrbitalFullView }) => {
    if (route) openOrbitalWatch(route.point, document.getElementById('mapContainer'), route.view);
    else leaveOrbitalFullView();
  });
}

/** Opens the lookup when the page loads or navigates to an orbital route. */
export function watchOrbitalRoute(): () => void {
  if (parseOrbitalRoute(window.location.hash)) applyRoute();
  let routed = parseOrbitalRoute(window.location.hash) !== null;
  const onHashChange = () => {
    const next = parseOrbitalRoute(window.location.hash) !== null;
    if (next || routed) applyRoute();
    routed = next;
  };
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}
