/**
 * @module annotationGeoJson
 * @description Pure conversion between the runtime annotation model and a GeoJSON
 * FeatureCollection — a durable, testable interchange format for saving, exporting,
 * importing, sharing, and fixture-testing annotations. It is NOT a renderer input:
 * the Cesium/SVG renderers keep consuming runtime annotation objects. This module is
 * deliberately Cesium-free and dependency-free so it can run in tests and any context.
 *
 * Mapping (one Feature per mark; project fields namespaced `gev:`):
 *   pin | highlight | label  ->  Point      (anchor)
 *   arrow                     ->  LineString (anchor -> to)
 *   route                     ->  LineString (the routed path)
 *   area (with a ring)        ->  Polygon    (the footprint ring; centroid in `gev:anchor`)
 *   area (no ring)            ->  Point      (degenerate area; renders as a marker)
 *
 * Coordinates are GeoJSON positions `[lon, lat]`, or `[lon, lat, height]` when a height
 * is present (anchor / route / arrow). Area ring vertices are 2D `[lon, lat]` (the runtime
 * ring has no per-vertex height). Conversions are LOSSLESS for the semantic fields; transient
 * render state (alpha/bornAt/createdAt/expiring) is intentionally NOT carried — an importer
 * re-initializes it.
 */

const VALID_TYPES = new Set(['pin', 'highlight', 'label', 'arrow', 'route', 'area']);

/** {lon,lat,height?} -> GeoJSON position, or null if not a finite lon/lat. */
function toPosition(p) {
  if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return null;
  return Number.isFinite(p.height) ? [p.lon, p.lat, p.height] : [p.lon, p.lat];
}

/** GeoJSON position -> {lon,lat,height?}, or null if malformed. */
function fromPosition(c) {
  if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  return Number.isFinite(c[2]) ? { lon: c[0], lat: c[1], height: c[2] } : { lon: c[0], lat: c[1] };
}

/** Mean of a runtime ring (`[[lon,lat],...]`), used as a fallback area anchor on import. */
function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const [lon, lat] of ring) { sx += lon; sy += lat; }
  return { lon: sx / ring.length, lat: sy / ring.length };
}

/**
 * Convert one runtime annotation object to a GeoJSON Feature.
 * @param {object} anno - A runtime annotation (as produced by the engine).
 * @returns {object|null} A GeoJSON Feature, or null if `anno` can't form a valid geometry.
 */
export function annotationToFeature(anno) {
  if (!anno || typeof anno !== 'object' || !VALID_TYPES.has(anno.type)) return null;
  const type = anno.type;
  const properties = {
    'gev:type': type,
    'gev:id': anno.id ?? null,
    'gev:label': anno.label ?? null,
    'gev:color': anno.color ?? null,
    'gev:ttlMs': anno.ttlMs ?? null,
  };
  let geometry = null;

  if (type === 'route') {
    const coords = (Array.isArray(anno.path) ? anno.path : []).map(toPosition).filter(Boolean);
    if (coords.length < 2) return null;
    geometry = { type: 'LineString', coordinates: coords };
    properties['gev:mode'] = anno.mode ?? null;
    properties['gev:distanceM'] = anno.distanceM ?? null;
    properties['gev:durationS'] = anno.durationS ?? null;
    properties['gev:fallback'] = Boolean(anno.fallback);
  } else if (type === 'arrow') {
    const from = toPosition(anno.anchor);
    const to = toPosition(anno.to);
    if (!from || !to) return null;
    geometry = { type: 'LineString', coordinates: [from, to] };
  } else if (type === 'area' && Array.isArray(anno.ring) && anno.ring.length >= 3) {
    const ring = [];
    for (const pair of anno.ring) {
      if (!Array.isArray(pair) || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1])) return null;
      ring.push([pair[0], pair[1]]);
    }
    // GeoJSON linear rings must be explicitly closed (first === last).
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    geometry = { type: 'Polygon', coordinates: [ring] };
    properties['gev:footprintKind'] = anno.footprintKind ?? null;
    properties['gev:buildingHeight'] = anno.buildingHeight ?? null;
    properties['gev:synthesized'] = Boolean(anno.synthesized);
    const anchor = toPosition(anno.anchor);
    if (anchor) properties['gev:anchor'] = anchor; // preserve the exact centroid, don't recompute
  } else {
    // pin / highlight / label, or a degenerate `area` with no ring -> a Point at the anchor.
    const anchor = toPosition(anno.anchor);
    if (!anchor) return null;
    geometry = { type: 'Point', coordinates: anchor };
    if (type === 'area') {
      properties['gev:footprintKind'] = anno.footprintKind ?? null;
      properties['gev:synthesized'] = Boolean(anno.synthesized);
    }
  }

  return { type: 'Feature', geometry, properties };
}

/**
 * Convert a GeoJSON Feature back to a runtime annotation object (semantic fields only —
 * the importer adds render state). Fails CLOSED: returns null for any malformed feature,
 * unknown `gev:type`, or geometry that doesn't match the declared type.
 * @param {object} feature - A GeoJSON Feature produced by {@link annotationToFeature}.
 * @returns {object|null}
 */
export function featureToAnnotation(feature) {
  if (!feature || feature.type !== 'Feature' || !feature.geometry || !feature.properties) return null;
  const g = feature.geometry;
  const p = feature.properties;
  const type = p['gev:type'];
  if (!VALID_TYPES.has(type)) return null;

  const base = {
    type,
    id: p['gev:id'] ?? null,
    label: p['gev:label'] ?? null,
    color: p['gev:color'] ?? 'primary',
    ttlMs: p['gev:ttlMs'] ?? null,
  };

  if (type === 'route') {
    if (g.type !== 'LineString' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) return null;
    const path = g.coordinates.map(fromPosition);
    if (path.some((x) => !x)) return null;
    return {
      ...base,
      anchor: path[0],
      to: null,
      ring: null,
      path,
      mode: p['gev:mode'] ?? null,
      distanceM: p['gev:distanceM'] ?? null,
      durationS: p['gev:durationS'] ?? null,
      fallback: Boolean(p['gev:fallback']),
    };
  }

  if (type === 'arrow') {
    if (g.type !== 'LineString' || !Array.isArray(g.coordinates) || g.coordinates.length !== 2) return null;
    const from = fromPosition(g.coordinates[0]);
    const to = fromPosition(g.coordinates[1]);
    if (!from || !to) return null;
    return { ...base, anchor: from, to, ring: null };
  }

  if (g.type === 'Polygon') {
    if (type !== 'area' || !Array.isArray(g.coordinates) || !Array.isArray(g.coordinates[0])) return null;
    const raw = g.coordinates[0];
    if (raw.length < 4) return null; // a closed triangle is the minimum (4 positions)
    const ring = [];
    for (const c of raw) {
      if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
      ring.push([c[0], c[1]]);
    }
    // Drop the GeoJSON closing duplicate to match the runtime ring (not explicitly closed).
    const f = ring[0];
    const l = ring[ring.length - 1];
    if (ring.length > 3 && f[0] === l[0] && f[1] === l[1]) ring.pop();
    const anchor = fromPosition(p['gev:anchor']) || ringCentroid(ring);
    return {
      ...base,
      anchor,
      to: null,
      ring,
      footprintKind: p['gev:footprintKind'] ?? null,
      buildingHeight: p['gev:buildingHeight'] ?? null,
      synthesized: Boolean(p['gev:synthesized']),
    };
  }

  // Point geometry — pin / highlight / label, or a degenerate area.
  if (g.type !== 'Point') return null;
  const anchor = fromPosition(g.coordinates);
  if (!anchor) return null;
  const out = { ...base, anchor, to: null, ring: null };
  if (type === 'area') {
    out.footprintKind = p['gev:footprintKind'] ?? null;
    out.buildingHeight = null;
    out.synthesized = Boolean(p['gev:synthesized']);
  }
  return out;
}

/**
 * Convert an array of runtime annotations to a GeoJSON FeatureCollection.
 * Marks that can't form a valid geometry are dropped (not thrown).
 * @param {Array<object>} annotations
 * @returns {{type:'FeatureCollection', features: object[]}}
 */
export function annotationsToFeatureCollection(annotations) {
  const features = (Array.isArray(annotations) ? annotations : [])
    .map(annotationToFeature)
    .filter(Boolean);
  return { type: 'FeatureCollection', features };
}

/**
 * Convert a GeoJSON FeatureCollection back to runtime annotation objects.
 * Malformed features are skipped (fail-closed per feature), never throwing.
 * @param {object} collection
 * @returns {Array<object>}
 */
export function featureCollectionToAnnotations(collection) {
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) return [];
  return collection.features.map(featureToAnnotation).filter(Boolean);
}
