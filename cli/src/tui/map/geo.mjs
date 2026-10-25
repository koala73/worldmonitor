// Map geometry: the two projections the terminal map uses (equirectangular
// for the flat map, orthographic for the globe), the sun position for the
// day/night terminator, and small helpers shared by the layers.
//
// Coordinates: lon/lat in degrees; "dots" are braille dots, 2 per cell column
// and 4 per cell row, which makes a dot square on a typical 1:2 terminal cell.

export const DEG = Math.PI / 180;

// Arithmetic, not a loop: feeds can carry huge longitudes, and adding 360 to
// 1e17 leaves it unchanged.
export function wrapLon(lon) {
  if (!Number.isFinite(lon) || (lon >= -180 && lon < 180)) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 160;
export const GLOBE_ZOOM_MIN = 0.6;
export const GLOBE_ZOOM_MAX = 12;

export function defaultView() {
  return { mode: 'flat', lon: 15, lat: 18, zoom: 1 };
}

// Keep the flat viewport inside the poles and the globe zoom in range.
export function normalizeView(view, w, h) {
  const v = { ...view };
  if (v.mode === 'globe') {
    v.zoom = clamp(v.zoom, GLOBE_ZOOM_MIN, GLOBE_ZOOM_MAX);
    v.lat = clamp(v.lat, -89, 89);
    v.lon = wrapLon(v.lon);
    return v;
  }
  v.zoom = clamp(v.zoom, ZOOM_MIN, ZOOM_MAX);
  const k = (w / 360) * v.zoom; // dots per degree
  const halfSpan = h / (2 * k);
  if (halfSpan >= 90) v.lat = 0;
  else v.lat = clamp(v.lat, -90 + halfSpan, 90 - halfSpan);
  v.lon = wrapLon(v.lon);
  return v;
}

// Great-circle distance in km.
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Move a point along a heading (degrees clockwise from north) by km.
export function destination(lat, lon, headingDeg, km) {
  const d = km / 6371;
  const br = headingDeg * DEG;
  const φ1 = lat * DEG;
  const λ1 = lon * DEG;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(br));
  const λ2 = λ1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 / DEG, lon: wrapLon(λ2 / DEG) };
}

export function fmtCoord(lat, lon) {
  const la = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${la} ${lo}`;
}

// --- projections ------------------------------------------------------------

// Equirectangular: zoom 1 fits 360° of longitude across the viewport width.
function equirect(view, w, h) {
  const k = (w / 360) * view.zoom;
  const cx = w / 2;
  const cy = h / 2;
  const lon0 = view.lon;
  const lat0 = view.lat;
  return {
    mode: 'flat',
    w,
    h,
    k,
    dotsPerDeg: k,
    lonSpan: w / k,
    latSpan: h / k,
    center: { lon: lon0, lat: lat0 },
    // dlon relative to the centre, already unwrapped by the caller when continuity matters.
    toDotRel(dlon, lat) {
      return [cx + dlon * k, cy - (lat - lat0) * k];
    },
    toDot(lon, lat) {
      const dlon = wrapLon(lon - lon0);
      return [cx + dlon * k, cy - (lat - lat0) * k, true];
    },
    fromDot(x, y) {
      const lat = lat0 - (y - cy) / k;
      if (lat < -90 || lat > 90) return null;
      return { lon: wrapLon(lon0 + (x - cx) / k), lat };
    },
    // Longitude range of the viewport (may exceed ±180 when it straddles the antimeridian).
    bbox() {
      const west = lon0 - w / (2 * k);
      const east = lon0 + w / (2 * k);
      const south = Math.max(-90, lat0 - h / (2 * k));
      const north = Math.min(90, lat0 + h / (2 * k));
      return [west, south, east, north];
    },
    visible() {
      return true;
    },
    wrapOffset: 360 * k,
  };
}

// Orthographic globe centred on view.lon/lat; zoom 1 fits the disc in the viewport.
function orthographic(view, w, h) {
  const R = Math.max(4, 0.47 * Math.min(w, h) * view.zoom);
  const cx = w / 2;
  const cy = h / 2;
  const φ0 = view.lat * DEG;
  const λ0 = view.lon * DEG;
  const sinφ0 = Math.sin(φ0);
  const cosφ0 = Math.cos(φ0);
  return {
    mode: 'globe',
    w,
    h,
    R,
    cx,
    cy,
    dotsPerDeg: (R * Math.PI) / 180,
    center: { lon: view.lon, lat: view.lat },
    toDot(lon, lat) {
      const φ = lat * DEG;
      const dλ = lon * DEG - λ0;
      const cosφ = Math.cos(φ);
      const sinφ = Math.sin(φ);
      const cosc = sinφ0 * sinφ + cosφ0 * cosφ * Math.cos(dλ);
      const x = cx + R * cosφ * Math.sin(dλ);
      const y = cy - R * (cosφ0 * sinφ - sinφ0 * cosφ * Math.cos(dλ));
      return [x, y, cosc > 0.001];
    },
    fromDot(x, y) {
      const dx = (x - cx) / R;
      const dy = -(y - cy) / R;
      const ρ = Math.sqrt(dx * dx + dy * dy);
      if (ρ > 1) return null;
      const c = Math.asin(ρ);
      const sinc = Math.sin(c);
      const cosc = Math.cos(c);
      const lat = ρ === 0 ? view.lat : Math.asin(cosc * sinφ0 + (dy * sinc * cosφ0) / ρ) / DEG;
      const lon = ρ === 0 ? view.lon : (λ0 + Math.atan2(dx * sinc, ρ * cosφ0 * cosc - dy * sinφ0 * sinc)) / DEG;
      return { lon: wrapLon(lon), lat };
    },
    bbox() {
      return [-180, -90, 180, 90];
    },
    visible(lon, lat) {
      const φ = lat * DEG;
      const dλ = lon * DEG - λ0;
      return sinφ0 * Math.sin(φ) + cosφ0 * Math.cos(φ) * Math.cos(dλ) > 0.001;
    },
    inDisc(x, y) {
      const dx = x - cx;
      const dy = y - cy;
      return dx * dx + dy * dy <= R * R;
    },
  };
}

export function makeProjector(view, w, h) {
  return view.mode === 'globe' ? orthographic(view, w, h) : equirect(view, w, h);
}

// Zoom keeping the geographic point under (x, y) fixed on screen.
export function zoomAt(view, w, h, factor, x, y) {
  const before = makeProjector(view, w, h);
  const anchor = x === undefined ? null : before.fromDot(x, y);
  const next = normalizeView({ ...view, zoom: view.zoom * factor }, w, h);
  if (!anchor) return next;
  const after = makeProjector(next, w, h);
  if (next.mode === 'globe') {
    // Keep the globe centred; rotating towards the anchor feels better than drifting.
    const shift = 0.35 * (1 - 1 / factor);
    return normalizeView({ ...next, lon: next.lon + wrapLon(anchor.lon - next.lon) * shift, lat: next.lat + (anchor.lat - next.lat) * shift }, w, h);
  }
  const [ax, ay] = after.toDot(anchor.lon, anchor.lat);
  const dlon = (ax - x) / after.k;
  const dlat = -(ay - y) / after.k;
  return normalizeView({ ...next, lon: next.lon + dlon, lat: next.lat + dlat }, w, h);
}

// Pan by a number of dots.
export function panBy(view, w, h, dx, dy) {
  const p = makeProjector(view, w, h);
  if (view.mode === 'globe') {
    const degPerDot = 90 / p.R;
    return normalizeView({ ...view, lon: view.lon - dx * degPerDot, lat: view.lat + dy * degPerDot }, w, h);
  }
  return normalizeView({ ...view, lon: view.lon - dx / p.k, lat: view.lat + dy / p.k }, w, h);
}

// --- sun ----------------------------------------------------------------------

// Subsolar point (where the sun is overhead) for the day/night terminator.
export function subsolarPoint(now = Date.now()) {
  const n = now / 86400000 - 10957.5; // days since J2000.0
  const L = ((280.46 + 0.9856474 * n) % 360 + 360) % 360;
  const g = (((357.528 + 0.9856003 * n) % 360) + 360) % 360;
  const λ = L + 1.915 * Math.sin(g * DEG) + 0.02 * Math.sin(2 * g * DEG);
  const ε = 23.439 - 0.0000004 * n;
  const δ = Math.asin(Math.sin(ε * DEG) * Math.sin(λ * DEG));
  const α = Math.atan2(Math.cos(ε * DEG) * Math.sin(λ * DEG), Math.cos(λ * DEG));
  const gmstHours = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const lon = wrapLon(α / DEG - gmstHours * 15);
  return { lat: δ / DEG, lon };
}

// Cosine of the solar zenith angle: > 0 day, < 0 night.
export function daylight(lat, lon, sun) {
  const φ = lat * DEG;
  const δ = sun.lat * DEG;
  return Math.sin(φ) * Math.sin(δ) + Math.cos(φ) * Math.cos(δ) * Math.cos((lon - sun.lon) * DEG);
}

// 0 = full night … 1 = full day, with a soft twilight band.
export function dayFactor(lat, lon, sun) {
  const c = daylight(lat, lon, sun);
  return clamp((c + 0.12) / 0.3, 0, 1);
}
