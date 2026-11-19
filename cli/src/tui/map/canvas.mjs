// Dot canvas for the map: a braille dot buffer (2×4 dots per cell) with one
// colour per cell, a glyph layer drawn on top of the dots (markers, labels)
// and a compositor that writes everything into the Screen, optionally over
// half-block satellite imagery.
import { charWidth, mix, sanitize, strWidth } from '../term/ansi.mjs';

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export class DotCanvas {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.w = cols * 2;
    this.h = rows * 4;
    this.code = new Uint8Array(cols * rows); // braille bits per cell
    this.color = new Array(cols * rows).fill(null);
    this.pri = new Int16Array(cols * rows).fill(-32768);
    this.glyphs = new Map(); // cell index -> { ch, fg, bg, attr, pri }
    this.occupied = new Uint8Array(cols * rows); // glyph / label occupancy
  }

  // Copy another canvas of the same size (used to reuse the cached world base).
  copyFrom(other) {
    this.code.set(other.code);
    for (let i = 0; i < this.color.length; i++) this.color[i] = other.color[i];
    this.pri.set(other.pri);
    this.glyphs.clear();
    for (const [k, v] of other.glyphs) this.glyphs.set(k, v);
    this.occupied.set(other.occupied);
  }

  clear() {
    this.code.fill(0);
    this.color.fill(null);
    this.pri.fill(-32768);
    this.glyphs.clear();
    this.occupied.fill(0);
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  dot(x, y, color, pri = 0) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const cx = xi >> 1;
    const cy = yi >> 2;
    const ci = cy * this.cols + cx;
    this.code[ci] |= BRAILLE_BITS[yi & 3][xi & 1];
    if (pri >= this.pri[ci]) {
      this.pri[ci] = pri;
      this.color[ci] = color;
    }
  }

  line(x0, y0, x1, y1, color, pri = 0, dash = 0, phase = 0) {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    // Skip lines entirely outside the canvas.
    if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax >= this.w && bx >= this.w) || (ay >= this.h && by >= this.h)) return;
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;
    let n = 0;
    for (let guard = 0; guard < 100000; guard++) {
      if (!dash || Math.floor((n + phase) / dash) % 2 === 0) this.dot(ax, ay, color, pri);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
      n++;
    }
  }

  polyline(pts, color, pri = 0, dash = 0, phase = 0) {
    for (let i = 0; i + 1 < pts.length; i++) this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], color, pri, dash, phase);
  }

  // Even-odd scanline fill of one or more rings (array of [x, y] arrays).
  // pattern: 0 solid, 1 horizontal scanlines (every other dot row), 2 checker.
  fillRings(rings, color, pri = 0, pattern = 0) {
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    const edges = [];
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        if (a[1] === b[1]) continue;
        const [x0, y0, x1, y1] = a[1] < b[1] ? [a[0], a[1], b[0], b[1]] : [b[0], b[1], a[0], a[1]];
        edges.push([x0, y0, x1, y1, (x1 - x0) / (y1 - y0)]);
        if (y0 < minY) minY = y0;
        if (y1 > maxY) maxY = y1;
        if (x0 < minX) minX = x0;
        if (x1 < minX) minX = x1;
        if (x0 > maxX) maxX = x0;
        if (x1 > maxX) maxX = x1;
      }
    }
    if (!edges.length || maxY < 0 || minY >= this.h || maxX < 0 || minX >= this.w) return;
    edges.sort((p, q) => p[1] - q[1]);
    const yStart = Math.max(0, Math.ceil(minY - 0.5));
    const yEnd = Math.min(this.h - 1, Math.floor(maxY - 0.5));
    let next = 0;
    const active = [];
    const xs = [];
    for (let py = yStart; py <= yEnd; py++) {
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
        if (e[1] <= y) xs.push(e[0] + (y - e[1]) * e[4]);
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      if (pattern === 1 && py % 2 === 1) continue;
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil(xs[i] - 0.5));
        const to = Math.min(this.w - 1, Math.floor(xs[i + 1] - 0.5));
        for (let x = from; x <= to; x++) {
          if (pattern === 2 && (x + py) % 2) continue;
          this.dot(x, py, color, pri);
        }
      }
    }
  }

  circle(cx, cy, r, color, pri = 0, dash = 0, phase = 0) {
    const steps = Math.max(8, Math.round(r * 4));
    let n = 0;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      if (!dash || Math.floor((n + phase) / dash) % 2 === 0) this.dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, color, pri);
      n++;
    }
  }

  // Glyph at a cell position (not dots).
  glyph(cx, cy, ch, fg, { bg = null, attr = 0, pri = 0 } = {}) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    const ci = cy * this.cols + cx;
    const cur = this.glyphs.get(ci);
    if (cur && cur.pri > pri) return false;
    this.glyphs.set(ci, { ch, fg, bg, attr, pri });
    this.occupied[ci] = 1;
    return true;
  }

  isFree(cx, cy, len) {
    if (cy < 0 || cy >= this.rows || cx < 0 || cx + len > this.cols) return false;
    for (let i = 0; i < len; i++) if (this.occupied[cy * this.cols + cx + i]) return false;
    return true;
  }

  // Place a text label near a cell; tries right, left, above, below. Returns true when placed.
  label(cx, cy, raw, fg, { bg = null, attr = 0, pri = 0, force = false } = {}) {
    // Labels are feed text and reach the terminal through screen.put(), which
    // does not sanitize; strip control characters here as Screen.text does.
    const text = sanitize(raw);
    const len = strWidth(text);
    if (!len) return false;
    const candidates = [
      [cx + 2, cy],
      [cx - len - 1, cy],
      [cx - (len >> 1), cy - 1],
      [cx - (len >> 1), cy + 1],
      [cx + 2, cy - 1],
      [cx + 2, cy + 1],
    ];
    for (const [x, y] of candidates) {
      if (!this.isFree(x, y, len)) continue;
      this.writeText(x, y, text, fg, bg, attr, pri);
      return true;
    }
    if (force) {
      const x = Math.max(0, Math.min(this.cols - len, cx + 2));
      const y = Math.max(0, Math.min(this.rows - 1, cy));
      this.writeText(x, y, text, fg, bg, attr, pri + 1);
      return true;
    }
    return false;
  }

  writeText(x, y, text, fg, bg, attr, pri) {
    let i = 0;
    for (const ch of text) {
      this.glyph(x + i, y, ch, fg, { bg, attr, pri });
      i += strWidth(ch);
    }
  }

  // Write the canvas into the screen. opts.background(cx, cy) may return null,
  // a colour string, or { top, bottom } for half-block imagery. opts.shade(cx, cy)
  // returns 0..1 (1 = unshaded) for the day/night terminator.
  blit(ctx, r, { background = null, shade = null, nightColor = '#000000', dotBg = null } = {}) {
    const { s, t } = ctx;
    const panel = dotBg || t.panel;
    for (let cy = 0; cy < this.rows; cy++) {
      const sy = r.y + cy;
      if (sy >= r.y + r.h) break;
      for (let cx = 0; cx < this.cols; cx++) {
        const sx = r.x + cx;
        if (sx >= r.x + r.w) break;
        const ci = cy * this.cols + cx;
        const img = background ? background(cx, cy) : null;
        const f = shade ? shade(cx, cy) : 1;
        const g = this.glyphs.get(ci);
        const code = this.code[ci];
        let top = null;
        let bottom = null;
        let solid = null;
        if (img && typeof img === 'object') {
          top = img.top;
          bottom = img.bottom;
        } else if (typeof img === 'string') solid = img;
        const shadeColor = (c) => (f >= 1 ? c : mix(nightColor, c, 0.18 + 0.82 * f));
        if (g) {
          let bg = g.bg || solid || (top ? mix(top, bottom, 0.5) : panel);
          if (!g.bg && f < 1) bg = shadeColor(bg);
          s.put(sx, sy, g.ch, { fg: f < 1 && !g.bg ? shadeColor(g.fg) : g.fg, bg, attr: g.attr });
          if (charWidth(g.ch) === 2) cx += 1; // the glyph's right half covers the next cell
        } else if (code) {
          let bg = solid || (top ? mix(top, bottom, 0.5) : panel);
          let fg = this.color[ci] || t.map;
          if (f < 1) {
            bg = shadeColor(bg);
            fg = shadeColor(fg);
          }
          s.put(sx, sy, String.fromCharCode(0x2800 + code), { fg, bg, attr: 0 });
        } else if (top) {
          s.put(sx, sy, '▀', { fg: shadeColor(top), bg: shadeColor(bottom), attr: 0 });
        } else {
          const bg = solid || panel;
          s.put(sx, sy, ' ', { fg: t.map, bg: f < 1 && solid ? shadeColor(bg) : bg, attr: 0 });
        }
      }
    }
  }
}
