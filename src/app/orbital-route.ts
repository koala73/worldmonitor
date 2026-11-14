import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { OrbitalTrackSurface } from '@/app/orbital-watch';
import { buildOrbitalShareFragment, parseOrbitalShareFragment } from '@/utils/urlState';

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

/** Written with the share link's 0.01-degree point, so the address bar and history hold no finer place. */
export function formatOrbitalRoute(point: GeoPoint, view: OrbitalRouteView): string {
  return `#${buildOrbitalShareFragment(point, null, view)}`;
}

/** A route followed from an older or hand-written link is rewritten at the share link's precision, and returned as written. */
function roundRouteInPlace(route: OrbitalRoute): OrbitalRoute {
  const rounded = formatOrbitalRoute(route.point, route.view);
  if (window.location.hash !== rounded) {
    const url = new URL(window.location.href);
    url.hash = rounded;
    try {
      history.replaceState(history.state, '', url.toString());
    } catch {
      // A sandboxed or file document can refuse; the lookup still opens.
    }
  }
  return parseOrbitalRoute(rounded) ?? route;
}

function applyRoute(map: () => OrbitalTrackSurface | null): void {
  const parsed = parseOrbitalRoute(window.location.hash);
  const route = parsed && roundRouteInPlace(parsed);
  void import('@/app/orbital-watch').then(({ openOrbitalWatch, leaveOrbitalFullView }) => {
    if (route) openOrbitalWatch(route.point, document.getElementById('mapContainer'), route.view, map());
    else leaveOrbitalFullView();
  });
}

/** Opens the lookup when the page loads or navigates to an orbital route. */
export function watchOrbitalRoute(map: () => OrbitalTrackSurface | null = () => null): () => void {
  // A share link (0.01-degree point, optional pass) is taken by App once the map is up. A finer
  // route from an older link is rewritten as that share link here, so App opens it once.
  const initial = parseOrbitalRoute(window.location.hash);
  if (initial && !parseOrbitalShareFragment(window.location.hash)) roundRouteInPlace(initial);
  let routed = parseOrbitalRoute(window.location.hash) !== null;
  const onHashChange = () => {
    const next = parseOrbitalRoute(window.location.hash) !== null;
    if (next || routed) applyRoute(map);
    routed = next;
  };
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}
