// Rectangle helpers. A rect is { x, y, w, h } in cells.

export function rect(x, y, w, h) {
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

export function inset(r, dx, dy = dx) {
  return rect(r.x + dx, r.y + dy, r.w - dx * 2, r.h - dy * 2);
}

export function contains(r, x, y) {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

// Split along an axis. Each spec is a fixed size (number >= 1), a percentage
// string ('40%'), or 'fill' (shares the remainder; `{ fill: 2 }` doubles the share).
export function split(r, axis, specs, gap = 0) {
  const total = axis === 'h' ? r.w : r.h;
  const gaps = gap * Math.max(0, specs.length - 1);
  let fixed = 0;
  let fillWeight = 0;
  const sizes = specs.map((spec) => {
    if (typeof spec === 'number') {
      fixed += spec;
      return spec;
    }
    if (typeof spec === 'string' && spec.endsWith('%')) {
      const n = Math.round(((total - gaps) * parseFloat(spec)) / 100);
      fixed += n;
      return n;
    }
    const weight = spec && typeof spec === 'object' ? spec.fill || 1 : 1;
    fillWeight += weight;
    return { fill: weight };
  });
  let remaining = Math.max(0, total - gaps - fixed);
  let weightLeft = fillWeight;
  const final = sizes.map((s) => {
    if (typeof s === 'number') return s;
    const n = weightLeft > 0 ? Math.round((remaining * s.fill) / weightLeft) : 0;
    remaining -= n;
    weightLeft -= s.fill;
    return n;
  });
  const out = [];
  let pos = axis === 'h' ? r.x : r.y;
  for (const n of final) {
    out.push(axis === 'h' ? rect(pos, r.y, n, r.h) : rect(r.x, pos, r.w, n));
    pos += n + gap;
  }
  return out;
}

export function splitH(r, specs, gap = 0) {
  return split(r, 'h', specs, gap);
}

export function splitV(r, specs, gap = 0) {
  return split(r, 'v', specs, gap);
}
