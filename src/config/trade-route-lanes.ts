/**
 * The part of a trade route that one country pair actually sails.
 *
 * A route has one fixed `from` and `to` port, so a pair that shares it (India
 * on the Gulf-Asia route, Korea on China-Europe) used to get the whole route:
 * the map ran on to Singapore or Rotterdam, and every chokepoint past the
 * destination was reported. The route explorer's server handler uses this to
 * draw `primaryRouteGeometry` and to filter chokepoint exposure; the browser
 * uses it to highlight the same lane for visitors without a lane response.
 */

import { resolveCountryCode } from '../../shared/country-code-resolve';
import { STRATEGIC_WATERWAYS } from './geo';
import { PORTS } from './ports';
import { TRADE_ROUTES } from './trade-routes';

export interface LanePoint {
  lon: number;
  lat: number;
}

export interface Lane {
  geometry: LanePoint[];
  /** Waypoint ids (chokepoints) strictly between the two lane ends. */
  waypointIds: Set<string>;
}

interface ChainPoint {
  id: string;
  point: LanePoint;
}

interface LaneAnchor {
  /** Position along the route chain: segment index plus fraction. */
  param: number;
  point: LanePoint;
  /** True when the port was placed on the chokepoint at `param`, which then counts as crossed. */
  snapped?: boolean;
}

/**
 * Resolve coordinates for a `TradeRoute` endpoint or waypoint: a `PORTS` entry
 * or a strategic waterway. The waterway coordinates match the server's
 * chokepoint registry; tests/route-explorer-lane.test.mts pins that.
 */
function lookupWaypointCoord(waypointId: string): LanePoint | null {
  const port = PORTS.find((p) => p.id === waypointId);
  if (port) return { lon: port.lon, lat: port.lat };
  const waterway = STRATEGIC_WATERWAYS.find((w) => w.id === waypointId);
  if (waterway) return { lon: waterway.lon, lat: waterway.lat };
  return null;
}

/** Cargo ports that can end a lane, by ISO2. Naval bases are excluded. */
const CARGO_PORTS_BY_ISO2: ReadonlyMap<string, ChainPoint[]> = (() => {
  const byIso2 = new Map<string, ChainPoint[]>();
  for (const port of PORTS) {
    if (port.type === 'naval') continue;
    const iso2 = resolveCountryCode(port.country);
    if (!iso2) continue;
    const list = byIso2.get(iso2) ?? [];
    list.push({ id: port.id, point: { lon: port.lon, lat: port.lat } });
    byIso2.set(iso2, list);
  }
  return byIso2;
})();

function portIso2(portId: string): string | null {
  const port = PORTS.find((p) => p.id === portId);
  return port ? resolveCountryCode(port.country) : null;
}

/** A port further than this from the route is used only when it is the nearest one. */
const LANE_PORT_RADIUS_KM = 1500;

/** Signed longitude difference folded into [-180, 180). */
function lonDelta(delta: number): number {
  return ((((delta + 180) % 360) + 360) % 360) - 180;
}

function haversineKm(a: LanePoint, b: LanePoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = lonDelta(b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Where `point` sits along `chain`, as segment index plus fraction, and its
 * great-circle distance to that spot. The fraction comes from a local
 * equirectangular projection; longitudes are unwrapped against each segment
 * start, so trans-Pacific legs project correctly.
 */
function projectOntoChain(chain: ChainPoint[], point: LanePoint): { param: number; distanceKm: number } {
  let best = { param: 0, distanceKm: Number.POSITIVE_INFINITY };
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]!.point;
    const b = chain[i + 1]!.point;
    const scale = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    const dx = lonDelta(b.lon - a.lon) * scale;
    const dy = b.lat - a.lat;
    const px = lonDelta(point.lon - a.lon) * scale;
    const py = point.lat - a.lat;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
    const onRoute = { lon: a.lon + lonDelta(b.lon - a.lon) * t, lat: a.lat + dy * t };
    const distanceKm = haversineKm(point, onRoute);
    if (distanceKm < best.distanceKm) best = { param: i + t, distanceKm };
  }
  return best;
}

/**
 * Possible lane ends in `iso2`. When the route's own endpoint is in that
 * country it is the only candidate. Otherwise every cargo port within
 * LANE_PORT_RADIUS_KM of the route is a candidate, or the nearest port when
 * none is that close. Empty when the country has no modeled port.
 */
function laneCandidates(iso2: string, chain: ChainPoint[]): LaneAnchor[] {
  const last = chain.length - 1;
  if (portIso2(chain[0]!.id) === iso2) return [{ param: 0, point: chain[0]!.point }];
  if (portIso2(chain[last]!.id) === iso2) return [{ param: last, point: chain[last]!.point }];
  const projected = (CARGO_PORTS_BY_ISO2.get(iso2) ?? [])
    .map((port) => ({ ...projectOntoChain(chain, port.point), point: port.point }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const near = projected.filter((p) => p.distanceKm <= LANE_PORT_RADIUS_KM);
  return (near.length > 0 ? near : projected.slice(0, 1))
    .map(({ param, distanceKm, point }) => snapToChokepoint(chain, param, distanceKm, point));
}

/** A port nearer a chokepoint than this multiple of its route distance is placed on it. */
const CHOKEPOINT_SNAP_RATIO = 1.5;
/** A port this close to a chokepoint is placed on it whatever its route distance. */
const CHOKEPOINT_SNAP_KM = 500;

/**
 * Straight legs cannot tell which side of a strait a port lies on. The
 * Hormuz to Bab el-Mandeb leg crosses the UAE and passes 5 km from Jebel Ali,
 * so Jebel Ali projects past Hormuz although it is inside the Gulf; Laem
 * Chabang projects short of Malacca although ships reach it through the
 * strait. A port within CHOKEPOINT_SNAP_KM of a chokepoint at either end of
 * its leg, or nearer it than CHOKEPOINT_SNAP_RATIO times its distance from the
 * route, is placed on that chokepoint, and laneBetween counts it as crossed.
 * Unsure means exposed, never safe.
 */
function snapToChokepoint(chain: ChainPoint[], param: number, distanceKm: number, point: LanePoint): LaneAnchor {
  const segment = Math.floor(param);
  const last = chain.length - 1;
  let anchor: LaneAnchor = { param, point };
  let nearestKm = Math.max(CHOKEPOINT_SNAP_KM, CHOKEPOINT_SNAP_RATIO * distanceKm);
  for (const index of new Set([segment, Math.ceil(param)])) {
    if (index <= 0 || index >= last) continue;
    const km = haversineKm(point, chain[index]!.point);
    if (km < nearestKm) {
      nearestKm = km;
      anchor = { param: index, point, snapped: true };
    }
  }
  return anchor;
}

function laneBetween(chain: ChainPoint[], origin: LaneAnchor, destination: LaneAnchor): Lane {
  const low = Math.min(origin.param, destination.param);
  const high = Math.max(origin.param, destination.param);
  const snappedTo = new Set([origin, destination].filter((a) => a.snapped).map((a) => a.param));
  const between = chain.filter((_, index) => (index > low && index < high) || snappedTo.has(index));
  if (origin.param > destination.param) between.reverse();
  return {
    geometry: [origin.point, ...between.map((c) => c.point), destination.point],
    waypointIds: new Set(between.map((c) => c.id)),
  };
}

function laneLengthKm(lane: Lane): number {
  let km = 0;
  for (let i = 1; i < lane.geometry.length; i++) km += haversineKm(lane.geometry[i - 1]!, lane.geometry[i]!);
  return km;
}

/**
 * Build the lane for one country pair on a trade route. The lane starts and
 * ends at a port in each requested country, runs the route backwards when the
 * pair is reversed, and keeps only the waypoints between its two ends. When a
 * country has several candidate ports, the pair of ends that keeps the most
 * chokepoints wins, then the shorter lane: a risk view must not drop Hormuz
 * for the UAE because Fujairah sits outside it. When either country has no
 * modeled port the lane keeps the full route's chokepoints.
 */
export function buildLane(routeId: string, fromIso2: string, toIso2: string): Lane {
  const empty: Lane = { geometry: [], waypointIds: new Set() };
  if (!routeId) return empty;
  const route = TRADE_ROUTES.find((r) => r.id === routeId);
  if (!route) return empty;
  const chain: ChainPoint[] = [];
  for (const id of [route.from, ...route.waypoints, route.to]) {
    const point = lookupWaypointCoord(id);
    if (point) chain.push({ id, point });
  }
  if (chain.length < 2) return { geometry: chain.map((c) => c.point), waypointIds: new Set() };

  const last = chain.length - 1;
  const routeEnd = (param: number): LaneAnchor => ({ param, point: chain[param]!.point });
  const fromCandidates = laneCandidates(fromIso2, chain);
  const toCandidates = laneCandidates(toIso2, chain);

  // A side with no modeled port gives no evidence of where on the route it
  // sits, so the lane keeps every chokepoint on the route, as it did before.
  // The drawing runs from the known end to the route end farther from it.
  if (fromCandidates.length === 0 || toCandidates.length === 0) {
    const allWaypoints = new Set(chain.slice(1, last).map((c) => c.id));
    const known = fromCandidates[0] ?? toCandidates[0];
    if (!known) return { geometry: chain.map((c) => c.point), waypointIds: allWaypoints };
    const far = routeEnd(known.param > last / 2 ? 0 : last);
    const drawn = fromCandidates.length > 0 ? laneBetween(chain, known, far) : laneBetween(chain, far, known);
    return { geometry: drawn.geometry, waypointIds: allWaypoints };
  }

  let best: { lane: Lane; km: number } | null = null;
  for (const origin of fromCandidates) {
    for (const destination of toCandidates) {
      const lane = laneBetween(chain, origin, destination);
      const km = laneLengthKm(lane);
      if (!best
        || lane.waypointIds.size > best.lane.waypointIds.size
        || (lane.waypointIds.size === best.lane.waypointIds.size && km < best.km)) {
        best = { lane, km };
      }
    }
  }
  return best!.lane;
}
