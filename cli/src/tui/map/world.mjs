// World geometry: decodes the packed 50m TopoJSON arcs from the catalog,
// rasterizes land (per country, so choropleths work) and draws coastlines and
// borders in the flat and globe projections.
import { wrapLon } from './geo.mjs';

function decodeVarints(base64) {
  const buf = Buffer.from(base64, 'base64');
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let shift = 0;
    let v = 0;
    for (;;) {
      const b = buf[i++];
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    out.push(v >>> 0);
  }
  return out;
}

const unzig = (n) => (n & 1 ? -((n + 1) / 2) : n / 2);

export function decodeWorld(src) {
  const ints = decodeVarints(src.arcs);
  const [sx, sy] = src.scale;
  const [tx, ty] = src.translate;
  let p = 0;
  const arcCount = ints[p++];
  const arcs = new Array(arcCount);
  for (let a = 0; a < arcCount; a++) {
    const n = ints[p++];
    const pts = new Float64Array(n * 2);
    let x = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
      x += unzig(ints[p++]);
      y += unzig(ints[p++]);
      pts[i * 2] = x * sx + tx;
      pts[i * 2 + 1] = y * sy + ty;
    }
    arcs[a] = pts;
  }
  const arcUse = new Uint8Array(arcCount);
  const countries = src.countries.map((c, index) => {
    for (const poly of c.polys) for (const ring of poly) for (const ai of ring) arcUse[ai < 0 ? ~ai : ai] += 1;
    return { ...c, index };
  });
  const world = { arcs, arcUse, countries, byA2: new Map(), ringCache: new Map(), mask: null };
  for (const c of countries) if (c.a2) world.byA2.set(c.a2, c);
  for (const c of countries) {
    c.centroid = countryCentroid(world, c);
    c.area = countryArea(world, c);
  }
  return world;
}

// Ring as an array of [lon, lat], unwrapped so consecutive points never jump
// across the antimeridian (Russia, Fiji, Antarctica).
export function ringPoints(world, ring) {
  const key = ring.join(',');
  let pts = world.ringCache.get(key);
  if (pts) return pts;
  pts = [];
  for (const index of ring) {
    const arc = world.arcs[index < 0 ? ~index : index];
    const n = arc.length / 2;
    const rev = index < 0;
    for (let k = 0; k < n; k++) {
      const i = rev ? n - 1 - k : k;
      if (pts.length && k === 0) continue; // shared junction
      pts.push([arc[i * 2], arc[i * 2 + 1]]);
    }
  }
  for (let i = 1; i < pts.length; i++) {
    let d = pts[i][0] - pts[i - 1][0];
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    pts[i] = [pts[i - 1][0] + d, pts[i][1]];
  }
  world.ringCache.set(key, pts);
  return pts;
}

function countryCentroid(world, c) {
  let best = null;
  let bestArea = -1;
  for (const poly of c.polys) {
    const pts = ringPoints(world, poly[0]);
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      const f = x0 * y1 - x1 * y0;
      a += f;
      cx += (x0 + x1) * f;
      cy += (y0 + y1) * f;
    }
    const area = Math.abs(a) / 2;
    if (area > bestArea && a !== 0) {
      bestArea = area;
      best = [wrapLon(cx / (3 * a)), cy / (3 * a)];
    }
  }
  return best || [0, 0];
}

// Approximate area in square degrees at the equator (longitude scaled by cos lat).
function countryArea(world, c) {
  let total = 0;
  for (const poly of c.polys) {
    const pts = ringPoints(world, poly[0]);
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
      a += (x0 * k * y1 - x1 * k * y0);
    }
    total += Math.abs(a) / 2;
  }
  return total;
}

export function countryCentroidByA2(world, a2) {
  const c = world.byA2.get(String(a2 || '').toUpperCase());
  return c ? { lon: c.centroid[0], lat: c.centroid[1], name: c.name } : null;
}

// Equirectangular country mask for the globe (inverse sampling). 0 = ocean,
// n = countries[n - 1]. Built lazily once; ~2 MB.
export function worldMask(world, W = 1800, H = 900) {
  if (world.mask && world.mask.W === W) return world.mask;
  const idx = new Uint16Array(W * H);
  const toX = (lon) => ((lon + 180) / 360) * W;
  const toY = (lat) => ((90 - lat) / 180) * H;
  for (const c of world.countries) {
    for (const poly of c.polys) {
      const rings = poly.map((ring) => ringPoints(world, ring));
      // Antimeridian-crossing rings are drawn at both wrap offsets.
      const offsets = new Set([0]);
      for (const r of rings) for (const [lon] of r) {
        if (lon > 180) offsets.add(-360);
        if (lon < -180) offsets.add(360);
      }
      for (const off of offsets) fillMaskRings(idx, W, H, rings.map((r) => r.map(([lon, lat]) => [toX(lon + off), toY(lat)])), c.index + 1);
    }
  }
  world.mask = { W, H, idx, get(lon, lat) {
    const x = Math.min(W - 1, Math.max(0, Math.floor(toX(lon))));
    const y = Math.min(H - 1, Math.max(0, Math.floor(toY(lat))));
    return idx[y * W + x];
  } };
  return world.mask;
}

function fillMaskRings(idx, W, H, rings, value) {
  const edges = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a[1] === b[1]) continue;
      const [x0, y0, x1, y1] = a[1] < b[1] ? [a[0], a[1], b[0], b[1]] : [b[0], b[1], a[0], a[1]];
      edges.push([x0, y0, x1, y1, (x1 - x0) / (y1 - y0)]);
      if (y0 < minY) minY = y0;
      if (y1 > maxY) maxY = y1;
    }
  }
  if (!edges.length) return;
  edges.sort((p, q) => p[1] - q[1]);
  const active = [];
  let next = 0;
  const xs = [];
  for (let py = Math.max(0, Math.ceil(minY - 0.5)); py <= Math.min(H - 1, Math.floor(maxY - 0.5)); py++) {
    const y = py + 0.5;
    while (next < edges.length && edges[next][1] <= y) active.push(edges[next++]);
    xs.length = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      const e = active[i];
      if (e[3] <= y) {
        active[i] = active[active.length - 1];
        active.pop();
        continue;
      }
      xs.push(e[0] + (y - e[1]) * e[4]);
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i] - 0.5));
      const to = Math.min(W - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = from; x <= to; x++) idx[py * W + x] = value;
    }
  }
}

// --- rendering ------------------------------------------------------------------

// opts.fillColor(country) -> colour | null; opts.coast / opts.border colours.
export function renderWorld(canvas, proj, world, opts = {}) {
  if (proj.mode === 'globe') renderGlobe(canvas, proj, world, opts);
  else renderFlat(canvas, proj, world, opts);
}

function renderFlat(canvas, proj, world, { fillColor, coast, border, fill = true, borders = true, pattern = 0 }) {
  const lon0 = proj.center.lon;
  const W = canvas.w;
  const H = canvas.h;
  const project = (pts) => {
    const out = new Array(pts.length);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const base = wrapLon(pts[0][0] - lon0);
    for (let i = 0; i < pts.length; i++) {
      const dlon = base + (pts[i][0] - pts[0][0]);
      const [x, y] = proj.toDotRel(dlon, pts[i][1]);
      out[i] = [x, y];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { pts: out, minX, maxX, minY, maxY };
  };
  const offsetsFor = (minX, maxX) => {
    const offs = [];
    for (const o of [-proj.wrapOffset, 0, proj.wrapOffset]) if (maxX + o >= 0 && minX + o < W) offs.push(o);
    return offs;
  };
  if (fill) {
    for (const c of world.countries) {
      const color = fillColor ? fillColor(c) : null;
      if (!color) continue;
      for (const poly of c.polys) {
        const rings = poly.map((ring) => project(ringPoints(world, ring)));
        const outer = rings[0];
        if (outer.maxY < 0 || outer.minY >= H) continue;
        for (const off of offsetsFor(outer.minX, outer.maxX)) {
          const shifted = off === 0 ? rings.map((r) => r.pts) : rings.map((r) => r.pts.map(([x, y]) => [x + off, y]));
          canvas.fillRings(shifted, color, 1, pattern);
        }
      }
    }
  }
  if (borders) {
    for (let a = 0; a < world.arcs.length; a++) {
      const color = world.arcUse[a] > 1 ? border : coast;
      if (!color) continue;
      const arc = world.arcs[a];
      const n = arc.length / 2;
      const pts = new Array(n);
      for (let i = 0; i < n; i++) pts[i] = [arc[i * 2], arc[i * 2 + 1]];
      for (let i = 1; i < n; i++) {
        let d = pts[i][0] - pts[i - 1][0];
        if (d > 180) d -= 360;
        else if (d < -180) d += 360;
        pts[i] = [pts[i - 1][0] + d, pts[i][1]];
      }
      const { pts: out, minX, maxX, minY, maxY } = project(pts);
      if (maxY < 0 || minY >= H) continue;
      for (const off of offsetsFor(minX, maxX)) {
        for (let i = 1; i < out.length; i++) canvas.line(out[i - 1][0] + off, out[i - 1][1], out[i][0] + off, out[i][1], color, 2);
      }
    }
  }
}

function renderGlobe(canvas, proj, world, { fillColor, coast, border, fill = true, borders = true, outline, pattern = 0 }) {
  const mask = worldMask(world);
  const colors = new Array(world.countries.length + 1).fill(null);
  if (fill) {
    for (const c of world.countries) colors[c.index + 1] = fillColor ? fillColor(c) : null;
    const R = proj.R;
    const x0 = Math.max(0, Math.floor(proj.cx - R));
    const x1 = Math.min(canvas.w - 1, Math.ceil(proj.cx + R));
    const y0 = Math.max(0, Math.floor(proj.cy - R));
    const y1 = Math.min(canvas.h - 1, Math.ceil(proj.cy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const g = proj.fromDot(x + 0.5, y + 0.5);
        if (!g) continue;
        const v = mask.get(g.lon, g.lat);
        if (!v) continue;
        const color = colors[v];
        if (!color) continue;
        if (pattern === 1 && y % 2 === 1) continue;
        if (pattern === 2 && (x + y) % 2) continue;
        canvas.dot(x, y, color, 1);
      }
    }
  }
  if (outline) canvas.circle(proj.cx, proj.cy, proj.R + 0.5, outline, 0);
  if (borders) {
    for (let a = 0; a < world.arcs.length; a++) {
      const color = world.arcUse[a] > 1 ? border : coast;
      if (!color) continue;
      const arc = world.arcs[a];
      const n = arc.length / 2;
      let prev = null;
      for (let i = 0; i < n; i++) {
        const [x, y, vis] = proj.toDot(arc[i * 2], arc[i * 2 + 1]);
        if (prev && vis && prev[2]) canvas.line(prev[0], prev[1], x, y, color, 2);
        prev = [x, y, vis];
      }
    }
  }
}

// Graticule every `step` degrees, dotted.
export function renderGraticule(canvas, proj, color, step = 30) {
  const draw = (pts) => {
    let prev = null;
    for (const [lon, lat] of pts) {
      const [x, y, vis] = proj.toDot(lon, lat);
      if (prev && vis && prev[2] && Math.abs(x - prev[0]) < canvas.w / 2) canvas.line(prev[0], prev[1], x, y, color, -1, 2, 0);
      prev = [x, y, vis];
    }
  };
  for (let lat = -60; lat <= 60; lat += step) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, lat]);
    draw(pts);
  }
  for (let lon = -180; lon < 180; lon += step) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += 2) pts.push([lon, lat]);
    draw(pts);
  }
}

// Day/night terminator line (where the sun is on the horizon).
export function terminatorPoints(sun, steps = 180) {
  const pts = [];
  const δ = (sun.lat * Math.PI) / 180;
  for (let i = 0; i <= steps; i++) {
    const lon = -180 + (360 * i) / steps;
    const h = ((lon - sun.lon) * Math.PI) / 180;
    const lat = Math.atan(-Math.cos(h) / Math.tan(δ === 0 ? 1e-6 : δ));
    pts.push([lon, (lat * 180) / Math.PI]);
  }
  return pts;
}
