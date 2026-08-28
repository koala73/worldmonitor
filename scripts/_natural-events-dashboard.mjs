/**
 * Dashboard-sized projection of natural-event forecast cones (#7288).
 *
 * `natural:events:v1` is the canonical Redis key and the slow-tier bootstrap
 * key. NHC forecast cones arrive as raw ArcGIS rings — on 2026-08-28 four
 * active storms contributed ~346 KB of `conePolygon` vertices and pushed the
 * published slow body past its 1,482,865 B ceiling and the 3,000 ms mobile
 * abort. The map draws a filled cone at world/regional zoom; it does not need
 * 1,700–1,900 vertices per storm.
 *
 * This helper is a publish-time compact, like `_wildfire-dashboard`: the
 * canonical Redis value stays intact for RPC / MCP / detail reads. The
 * publisher and the Edge Redis fallback both apply it so a missed R2 read
 * cannot reintroduce the fat cones.
 *
 * Edge-safe: no `node:` imports. Keep this file byte-identical to
 * `api/_natural-events-dashboard.js`.
 */

export const NATURAL_EVENTS_CONE_SIMPLIFY_TOLERANCE_DEG = 0.05;
export const NATURAL_EVENTS_CONE_COORD_DECIMALS = 4;
export const NATURAL_EVENTS_CONE_MAX_POINTS = 96;

function compactCoord(value) {
  return Number.isFinite(value) ? Number(value.toFixed(NATURAL_EVENTS_CONE_COORD_DECIMALS)) : value;
}

function toLonLat(point) {
  if (Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
    return { lon: point[0], lat: point[1] };
  }
  if (point && typeof point === 'object' && !Array.isArray(point)) {
    const lon = Number(point.lon);
    const lat = Number(point.lat);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat };
  }
  return null;
}

function ringPoints(ring) {
  if (Array.isArray(ring)) return ring;
  if (ring && typeof ring === 'object' && Array.isArray(ring.points)) return ring.points;
  return null;
}

function samePoint(a, b) {
  return a.lon === b.lon && a.lat === b.lat;
}

function perpendicularDistance(point, start, end) {
  const dx = end.lon - start.lon;
  const dy = end.lat - start.lat;
  const denom = Math.hypot(dx, dy);
  if (denom === 0) return Math.hypot(point.lon - start.lon, point.lat - start.lat);
  return Math.abs(dy * point.lon - dx * point.lat + end.lon * start.lat - end.lat * start.lon) / denom;
}

function rdp(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const segment = stack.pop();
    const startIndex = segment[0];
    const endIndex = segment[1];
    if (endIndex - startIndex <= 1) continue;

    const first = points[startIndex];
    const last = points[endIndex];
    let index = 0;
    let maxDist = 0;
    for (let i = startIndex + 1; i < endIndex; i += 1) {
      const distance = perpendicularDistance(points[i], first, last);
      if (distance > maxDist) {
        maxDist = distance;
        index = i;
      }
    }

    if (maxDist > tolerance) {
      keep[index] = true;
      stack.push([startIndex, index], [index, endIndex]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

function simplifyClosedRing(points, tolerance) {
  if (tolerance <= 0 || points.length <= 5) return points.slice();
  const closed = samePoint(points[0], points[points.length - 1]);
  const open = closed ? points.slice(0, -1) : points.slice();
  if (open.length <= 4) return points.slice();

  let far = 0;
  let farDist = -1;
  for (let i = 1; i < open.length; i += 1) {
    const distance = Math.hypot(open[i].lon - open[0].lon, open[i].lat - open[0].lat);
    if (distance > farDist) {
      farDist = distance;
      far = i;
    }
  }

  const first = rdp(open.slice(0, far + 1), tolerance);
  const second = rdp([...open.slice(far), open[0]], tolerance);
  const merged = [...first.slice(0, -1), ...second.slice(0, -1)];
  if (merged.length < 4) return points.slice();
  const result = [...merged, merged[0]];
  return result.length < points.length ? result : points.slice();
}

function dedupeAdjacent(points) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && samePoint(last, point)) continue;
    out.push(point);
  }
  if (out.length >= 2 && samePoint(out[0], out[out.length - 1]) === false) {
    out.push(out[0]);
  }
  return out;
}

function capClosedRing(points, maxPoints) {
  const closed = points.length >= 2 && samePoint(points[0], points[points.length - 1]);
  const open = closed ? points.slice(0, -1) : points.slice();
  if (open.length + 1 <= maxPoints) {
    return open.length === 0 ? points : [...open, open[0]];
  }

  const keepOpen = maxPoints - 1;
  const stride = (open.length - 1) / (keepOpen - 1);
  const sampled = [open[0]];
  for (let i = 1; i < keepOpen - 1; i += 1) {
    sampled.push(open[Math.round(i * stride)]);
  }
  sampled.push(open[open.length - 1]);
  return dedupeAdjacent([...sampled, sampled[0]]);
}

function wrapRing(original, points) {
  if (Array.isArray(original)) {
    if (original.length > 0 && Array.isArray(original[0])) {
      return points.map((point) => [point.lon, point.lat]);
    }
    return points;
  }
  return { ...original, points };
}

export function simplifyNaturalEventConeRing(ring) {
  const raw = ringPoints(ring);
  if (!raw || raw.length < 4) return ring;

  const parsed = [];
  for (const item of raw) {
    const point = toLonLat(item);
    if (point) parsed.push(point);
  }
  if (parsed.length < 4) return ring;

  const simplified = simplifyClosedRing(parsed, NATURAL_EVENTS_CONE_SIMPLIFY_TOLERANCE_DEG);
  const rounded = dedupeAdjacent(simplified.map((point) => ({
    lon: compactCoord(point.lon),
    lat: compactCoord(point.lat),
  })));
  const capped = capClosedRing(rounded, NATURAL_EVENTS_CONE_MAX_POINTS);
  if (capped.length < 4) return ring;
  if (capped.length >= parsed.length && JSON.stringify(capped) === JSON.stringify(parsed)) {
    return ring;
  }
  return wrapRing(ring, capped);
}

export function compactNaturalEventsDashboardPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.events)) {
    return value;
  }

  let changed = false;
  const events = value.events.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event) || !Array.isArray(event.conePolygon)) {
      return event;
    }
    if (event.conePolygon.length === 0) return event;

    const conePolygon = event.conePolygon.map((ring) => {
      const next = simplifyNaturalEventConeRing(ring);
      if (next !== ring) changed = true;
      return next;
    });
    if (conePolygon.every((ring, index) => ring === event.conePolygon[index])) return event;
    return { ...event, conePolygon };
  });

  if (!changed) return value;
  return { ...value, events };
}
