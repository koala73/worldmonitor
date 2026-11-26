// 3D engine for the Phenomena stage: an orbiting perspective camera, easing,
// and generators that turn storyboard elements into world-space points and
// segments. Everything is deterministic in time so a scene replays identically.
import { mix } from '../term/ansi.mjs';

export const DEG = Math.PI / 180;

export function ease(t, kind = 'inout') {
  const x = Math.max(0, Math.min(1, t));
  if (kind === 'linear') return x;
  if (kind === 'in') return x * x;
  if (kind === 'out') return 1 - (1 - x) * (1 - x);
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpCamera(a, b, t) {
  return { yaw: lerp(a.yaw, b.yaw, t), pitch: lerp(a.pitch, b.pitch, t), dist: lerp(a.dist, b.dist, t), target: [0, 1, 2].map((i) => lerp(a.target[i], b.target[i], t)) };
}

// A projector from world space to canvas dots. The camera orbits `target` at
// `dist`, looking at it; `fov` is the vertical field of view in degrees.
export function makeCamera({ yaw = 20, pitch = 15, dist = 7, target = [0, 0, 0], fov = 50 }, w, h) {
  const cy = Math.cos(yaw * DEG);
  const sy = Math.sin(yaw * DEG);
  const cp = Math.cos(pitch * DEG);
  const sp = Math.sin(pitch * DEG);
  const eye = [target[0] + dist * cp * sy, target[1] + dist * sp, target[2] + dist * cp * cy];
  const f = h / 2 / Math.tan((fov * DEG) / 2);
  const cx = w / 2;
  const cyy = h / 2;
  return {
    eye,
    dist,
    w,
    h,
    f,
    // Returns [x, y, depth] in dots, or null when behind the eye. depth is 0 (near) .. 1 (far) relative to dist.
    project(p) {
      // translate
      let x = p[0] - eye[0];
      let y = p[1] - eye[1];
      let z = p[2] - eye[2];
      // rotate by -yaw around Y
      const x1 = x * cy - z * sy;
      const z1 = x * sy + z * cy;
      // rotate by -pitch around X
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      x = x1;
      y = y2;
      z = -z2; // camera looks down -z; make depth positive in front
      if (z < 0.05) return null;
      return [cx + (f * x) / z, cyy - (f * y) / z, Math.max(0, Math.min(1, (z - dist * 0.4) / (dist * 1.4)))];
    },
    scaleAt(p) {
      const q = this.project(p);
      return q ? f / Math.max(0.05, dist) : 0;
    },
  };
}

// Depth-cued colour: far points fade toward the panel background.
export function cue(color, bg, depth, min = 0.3) {
  return mix(bg, color, min + (1 - min) * (1 - depth));
}

// Deterministic pseudo-random in [0, 1).
export function rnd(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Rotate a point around the Y axis (degrees) about the origin, then the X axis.
export function rotY(p, deg) {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

export function rotX(p, deg) {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

// --- generators: each returns { points: [[x,y,z]...], segments: [[a,b]...] } in world space ---

export function sphereWire(r, lat = 5, lon = 10, spinDeg = 0) {
  const segs = [];
  const steps = 28;
  for (let i = 1; i < lat; i++) {
    const phi = (i / lat) * Math.PI - Math.PI / 2;
    const rr = r * Math.cos(phi);
    const y = r * Math.sin(phi);
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2 + spinDeg * DEG;
      const b = ((k + 1) / steps) * Math.PI * 2 + spinDeg * DEG;
      segs.push([[rr * Math.cos(a), y, rr * Math.sin(a)], [rr * Math.cos(b), y, rr * Math.sin(b)]]);
    }
  }
  for (let j = 0; j < lon; j++) {
    const a = (j / lon) * Math.PI * 2 + spinDeg * DEG;
    for (let k = 0; k < steps / 2; k++) {
      const p0 = (k / (steps / 2)) * Math.PI - Math.PI / 2;
      const p1 = ((k + 1) / (steps / 2)) * Math.PI - Math.PI / 2;
      segs.push([[r * Math.cos(p0) * Math.cos(a), r * Math.sin(p0), r * Math.cos(p0) * Math.sin(a)], [r * Math.cos(p1) * Math.cos(a), r * Math.sin(p1), r * Math.cos(p1) * Math.sin(a)]]);
    }
  }
  return { points: [], segments: segs };
}

// Continents as dots on a sphere, from the map's 1800×900 land mask (lon/lat).
export function earthPoints(mask, r, spinDeg = 0, stepDeg = 4) {
  const pts = [];
  if (!mask) return sphereWire(r, 6, 12, spinDeg);
  for (let lat = -84; lat <= 84; lat += stepDeg) {
    const cl = Math.cos(lat * DEG);
    const lonStep = Math.max(stepDeg, stepDeg / Math.max(0.2, cl));
    for (let lon = -180; lon < 180; lon += lonStep) {
      if (!mask.land(lon, lat)) continue;
      const a = (lon + spinDeg) * DEG;
      pts.push([r * cl * Math.cos(a), r * Math.sin(lat * DEG), -r * cl * Math.sin(a)]);
    }
  }
  const wire = sphereWire(r, 4, 8, spinDeg);
  return { points: pts, segments: wire.segments };
}

export function galaxyPoints(r, arms = 2, n = 500, spinDeg = 0, seed = 1) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const arm = i % arms;
    const t = rnd(seed + i * 3.1);
    const rad = r * Math.sqrt(t);
    const ang = (arm / arms) * Math.PI * 2 + rad * 2.2 + (rnd(seed + i * 7.7) - 0.5) * 0.6 + spinDeg * DEG;
    const y = (rnd(seed + i * 5.3) - 0.5) * 0.08 * r * (1 - t);
    pts.push([rad * Math.cos(ang), y, rad * Math.sin(ang)]);
  }
  for (let i = 0; i < n / 6; i++) {
    const rad = r * 0.18 * rnd(seed + i * 1.7);
    const ang = rnd(seed + i * 2.9) * Math.PI * 2;
    pts.push([rad * Math.cos(ang), (rnd(seed + i * 4.1) - 0.5) * 0.12 * r, rad * Math.sin(ang)]);
  }
  return { points: pts, segments: [] };
}

export function cloudPoints(r, n = 300, seed = 2) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const u = rnd(seed + i * 1.3) * 2 - 1;
    const th = rnd(seed + i * 2.7) * Math.PI * 2;
    const rad = r * Math.cbrt(rnd(seed + i * 3.9));
    const s = Math.sqrt(1 - u * u);
    pts.push([rad * s * Math.cos(th), rad * u, rad * s * Math.sin(th)]);
  }
  return { points: pts, segments: [] };
}

export function latticePoints(nx, ny, nz, spacing) {
  const pts = [];
  const segs = [];
  const ox = ((nx - 1) * spacing) / 2;
  const oy = ((ny - 1) * spacing) / 2;
  const oz = ((nz - 1) * spacing) / 2;
  const at = (i, j, k) => [i * spacing - ox, j * spacing - oy, k * spacing - oz];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        const p = at(i, j, k);
        pts.push(p);
        if (i + 1 < nx) segs.push([p, at(i + 1, j, k)]);
        if (j + 1 < ny) segs.push([p, at(i, j + 1, k)]);
        if (k + 1 < nz) segs.push([p, at(i, j, k + 1)]);
      }
  return { points: pts, segments: segs };
}

export function helixPath(r, turns, h, spinDeg = 0, double = true) {
  const segs = [];
  const steps = Math.round(turns * 24);
  const strand = (phase) => {
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * turns * Math.PI * 2 + phase + spinDeg * DEG;
      const p = [r * Math.cos(a), (i / steps) * h - h / 2, r * Math.sin(a)];
      if (prev) segs.push([prev, p]);
      prev = p;
    }
  };
  strand(0);
  if (double) {
    strand(Math.PI);
    for (let i = 0; i <= steps; i += 3) {
      const a = (i / steps) * turns * Math.PI * 2 + spinDeg * DEG;
      const y = (i / steps) * h - h / 2;
      segs.push([[r * Math.cos(a), y, r * Math.sin(a)], [-r * Math.cos(a), y, -r * Math.sin(a)]]);
    }
  }
  return { points: [], segments: segs };
}

export function torusWire(R, r, spinDeg = 0) {
  const segs = [];
  const nu = 24;
  const nv = 8;
  const p = (u, v) => {
    const a = (u / nu) * Math.PI * 2 + spinDeg * DEG;
    const b = (v / nv) * Math.PI * 2;
    return [(R + r * Math.cos(b)) * Math.cos(a), r * Math.sin(b), (R + r * Math.cos(b)) * Math.sin(a)];
  };
  for (let u = 0; u < nu; u++) for (let v = 0; v < nv; v++) segs.push([p(u, v), p(u + 1, v)], [p(u, v), p(u, v + 1)]);
  return { points: [], segments: segs };
}

// A paraboloid dish opening toward +y.
export function dishWire(r, depth, spinDeg = 0) {
  const segs = [];
  const rings = 4;
  const spokes = 12;
  const p = (k, a) => {
    const rr = (k / rings) * r;
    return [rr * Math.cos(a + spinDeg * DEG), (rr * rr * depth) / (r * r) - depth / 2, rr * Math.sin(a + spinDeg * DEG)];
  };
  for (let k = 1; k <= rings; k++) for (let i = 0; i < 24; i++) segs.push([p(k, (i / 24) * Math.PI * 2), p(k, ((i + 1) / 24) * Math.PI * 2)]);
  for (let i = 0; i < spokes; i++) for (let k = 0; k < rings; k++) segs.push([p(k, (i / spokes) * Math.PI * 2), p(k + 1, (i / spokes) * Math.PI * 2)]);
  // feed arm
  segs.push([[0, -depth / 2, 0], [0, depth * 0.9, 0]]);
  return { points: [[0, depth * 0.9, 0]], segments: segs };
}

// Vertical detector strings with optical modules (IceCube, KM3NeT).
export function stringsPoints(n, h, spacing, doms) {
  const pts = [];
  const segs = [];
  const side = Math.ceil(Math.sqrt(n));
  let c = 0;
  for (let i = 0; i < side && c < n; i++)
    for (let j = 0; j < side && c < n; j++, c++) {
      const x = (i - (side - 1) / 2) * spacing;
      const z = (j - (side - 1) / 2) * spacing;
      segs.push([[x, -h / 2, z], [x, h / 2, z]]);
      for (let d = 0; d < doms; d++) pts.push([x, -h / 2 + ((d + 0.5) / doms) * h, z]);
    }
  return { points: pts, segments: segs };
}

export function boxWire(w, h, d) {
  const c = [];
  for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) for (const z of [-d / 2, d / 2]) c.push([x, y, z]);
  const segs = [];
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) if ([c[i][0] !== c[j][0], c[i][1] !== c[j][1], c[i][2] !== c[j][2]].filter(Boolean).length === 1) segs.push([c[i], c[j]]);
  return { points: [], segments: segs };
}

export function gridWire(size, step) {
  const segs = [];
  for (let v = -size; v <= size + 1e-9; v += step) segs.push([[v, 0, -size], [v, 0, size]], [[-size, 0, v], [size, 0, v]]);
  return { points: [], segments: segs };
}

export function ringPath(r, tiltDeg = 0, spinDeg = 0, steps = 36) {
  const segs = [];
  let prev = null;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2 + spinDeg * DEG;
    const p = rotX([r * Math.cos(a), 0, r * Math.sin(a)], tiltDeg);
    if (prev) segs.push([prev, p]);
    prev = p;
  }
  return { points: [], segments: segs };
}

export function waveSurface(w, d, amp, freq, phase) {
  const segs = [];
  const nx = 16;
  const nz = 8;
  const p = (i, k) => {
    const x = (i / nx - 0.5) * w;
    const z = (k / nz - 0.5) * d;
    return [x, amp * Math.sin(x * freq + phase) * Math.cos(z * freq * 0.5 + phase * 0.7), z];
  };
  for (let i = 0; i <= nx; i++) for (let k = 0; k <= nz; k++) {
    if (i < nx) segs.push([p(i, k), p(i + 1, k)]);
    if (k < nz) segs.push([p(i, k), p(i, k + 1)]);
  }
  return { points: [], segments: segs };
}

export function coneWire(r, h, spinDeg = 0) {
  const segs = [];
  const apex = [0, h / 2, 0];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + spinDeg * DEG;
    const b = ((i + 1) / 16) * Math.PI * 2 + spinDeg * DEG;
    const p0 = [r * Math.cos(a), -h / 2, r * Math.sin(a)];
    segs.push([p0, [r * Math.cos(b), -h / 2, r * Math.sin(b)]]);
    if (i % 2 === 0) segs.push([p0, apex]);
  }
  return { points: [apex], segments: segs };
}

export function atomShape(r, shells, t) {
  const pts = [];
  const segs = [];
  const nuc = cloudPoints(r * 0.12, 24, 9);
  pts.push(...nuc.points);
  for (let s = 0; s < shells; s++) {
    const rr = r * (0.45 + (0.55 * s) / Math.max(1, shells - 1));
    const tilt = s * (180 / (shells + 1)) - 60;
    const ring = ringPath(rr, tilt, s * 37, 40);
    segs.push(...ring.segments);
    const a = t * (2.5 - s * 0.5) + s;
    pts.push(rotX([rr * Math.cos(a), 0, rr * Math.sin(a)], tilt));
  }
  return { points: pts, segments: segs };
}

// Expanding ring: radius grows r0 → r1 every `period` seconds.
export function pulseRing(r0, r1, period, tiltDeg, t) {
  const k = (t % period) / period;
  return { ...ringPath(lerp(r0, r1, k), tiltDeg, 0, 40), fade: 1 - k };
}

// Particle positions at time t for an emitter element.
export function particlePoints(e, t) {
  const pts = [];
  const dir = norm(e.dir);
  const side = norm(cross(dir, Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const up = cross(side, dir);
  for (let i = 0; i < e.n; i++) {
    const birth = (i / e.n) * e.life;
    const age = (((t - birth) % e.life) + e.life) % e.life;
    const u = (rnd(i * 1.7 + 1) - 0.5) * 2 * e.spread;
    const v = (rnd(i * 2.3 + 2) - 0.5) * 2 * e.spread;
    const j = rnd(i * 3.1 + 3);
    const p = add(add(add(e.from, scale(dir, age * e.speed * (0.7 + 0.6 * j))), scale(side, u)), scale(up, v));
    pts.push([p[0], p[1], p[2], 1 - age / e.life]);
  }
  return { points: pts, segments: [] };
}

// Dashed segment along a beam with a moving phase.
export function beamSegments(from, to, dash, speed, t) {
  if (!dash) return { points: [], segments: [[from, to]] };
  const segs = [];
  const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const n = Math.max(2, Math.round(len * 6));
  const phase = ((t * speed) / 10) % 2;
  for (let i = 0; i < n; i++) {
    if (Math.floor(i / Math.max(1, dash / 2) + phase) % 2) continue;
    const a = i / n;
    const b = (i + 1) / n;
    segs.push([[lerp(from[0], to[0], a), lerp(from[1], to[1], a), lerp(from[2], to[2], a)], [lerp(from[0], to[0], b), lerp(from[1], to[1], b), lerp(from[2], to[2], b)]]);
  }
  return { points: [to], segments: segs };
}

export function translate(shape, at) {
  return { ...shape, points: shape.points.map((p) => [p[0] + at[0], p[1] + at[1], p[2] + at[2], p[3]]), segments: shape.segments.map(([a, b]) => [[a[0] + at[0], a[1] + at[1], a[2] + at[2]], [b[0] + at[0], b[1] + at[1], b[2] + at[2]]]) };
}

// Build the world-space shape for an element at scene time t (seconds).
export function elementShape(e, t, { mask = null } = {}) {
  const spin = (e.spin || 0) * t;
  let shape;
  switch (e.type) {
    case 'sphere':
    case 'star':
      shape = sphereWire(e.r, e.type === 'star' ? 4 : 6, e.type === 'star' ? 8 : 12, spin);
      if (e.type === 'star') shape.points = cloudPoints(e.r * 0.9, 80, 5).points;
      break;
    case 'earth':
      shape = earthPoints(mask, e.r, spin);
      break;
    case 'galaxy':
      shape = galaxyPoints(e.r, e.arms || 2, Math.min(1200, Math.round(e.r * 220)), spin);
      break;
    case 'cloud':
      shape = cloudPoints(e.r, e.n, 3);
      break;
    case 'particles':
      return particlePoints(e, t);
    case 'orbit': {
      shape = ringPath(e.r, e.tilt, 0, 48);
      for (let b = 0; b < e.bodies; b++) {
        const a = (e.speed * DEG * t) + (b / Math.max(1, e.bodies)) * Math.PI * 2;
        shape.points.push(rotX([e.r * Math.cos(a), 0, e.r * Math.sin(a)], e.tilt));
      }
      break;
    }
    case 'beam':
    case 'arrow':
      return beamSegments(e.from, e.to, e.type === 'beam' ? e.dash : 0, e.speed, t);
    case 'path': {
      const segs = [];
      for (let i = 0; i + 1 < e.points.length; i++) segs.push([e.points[i], e.points[i + 1]]);
      return { points: [], segments: segs };
    }
    case 'lattice':
      shape = latticePoints(e.nx, e.ny, e.nz, e.spacing);
      break;
    case 'helix':
      shape = helixPath(e.r, e.turns, e.h, spin);
      break;
    case 'torus':
      shape = torusWire(e.r, e.r2, spin);
      break;
    case 'dish':
      shape = dishWire(e.r, e.h, spin);
      break;
    case 'strings':
    case 'detector':
      shape = stringsPoints(e.n, e.h, e.spacing, e.doms);
      break;
    case 'box':
      shape = boxWire(e.w, e.h, e.d);
      break;
    case 'grid':
      shape = gridWire(e.r, e.step);
      break;
    case 'ring':
      shape = ringPath(e.r, e.tilt, spin);
      break;
    case 'pulse':
      shape = pulseRing(e.r, e.r1, e.period, e.tilt, t);
      break;
    case 'wave':
      shape = waveSurface(e.r * 2, e.r, e.amp, e.freq, t * e.speed);
      break;
    case 'cone':
      shape = coneWire(e.r, e.h, spin);
      break;
    case 'atom':
      shape = atomShape(e.r, e.shells, t);
      break;
    case 'text':
      shape = { points: [[0, 0, 0]], segments: [] };
      break;
    default:
      shape = sphereWire(e.r, 5, 10, spin);
  }
  return translate(shape, e.at);
}
