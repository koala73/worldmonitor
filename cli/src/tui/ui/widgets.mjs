// Drawing widgets. Every function takes a `ctx`:
//   { s: Screen, t: theme, hits: [], now: ms, anim: bool }
// `hits` collects clickable regions for this frame; the app dispatches mouse
// events to the last region that contains the point.
import { center, mix, padEnd, padStart, strWidth, truncate } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { inset, rect } from './layout.mjs';

export function hit(ctx, r, handlers) {
  ctx.hits.push({ ...r, ...handlers });
}

// Draw a framed panel. Returns the inner rect.
export function panel(ctx, r, opts = {}) {
  const { s, t } = ctx;
  const { title = '', focused = false, right = '', kind = 'single', badge = null, badgeColor = null } = opts;
  if (r.w < 4 || r.h < 3) return rect(r.x, r.y, 0, 0);
  s.fill(r, ' ', { bg: t.panel, fg: t.text, attr: 0 });
  const borderColor = focused ? t.borderFocus : t.border;
  s.box(r, { fg: borderColor, bg: t.panel }, kind);
  if (title) {
    const label = ` ${truncate(title.toUpperCase(), Math.max(0, r.w - 6))} `;
    s.text(r.x + 2, r.y, label, { fg: focused ? t.title : t.text, bg: t.panel, attr: focused ? ATTR.BOLD : 0 });
    // corner accents on the focused panel
    if (focused) {
      s.put(r.x + 1, r.y, '▸', { fg: t.accent2, bg: t.panel });
    }
  }
  let rightEnd = r.x + r.w - 2;
  if (badge) {
    const b = ` ${badge} `;
    rightEnd -= strWidth(b);
    s.text(rightEnd, r.y, b, { fg: t.tabActiveText, bg: badgeColor || t.accent, attr: ATTR.BOLD });
    rightEnd -= 1;
  }
  if (right) {
    const rr = truncate(right, Math.max(0, rightEnd - r.x - 4));
    s.text(rightEnd - strWidth(rr), r.y, rr, { fg: t.dim, bg: t.panel });
  }
  if (opts.onClick) hit(ctx, r, { onClick: opts.onClick, onWheel: opts.onWheel });
  return inset(r, 1, 1);
}

// Write a row of segments [{ text, fg, bg, attr }] or a plain string.
export function segments(ctx, x, y, segs, width, baseStyle = {}) {
  const { s } = ctx;
  let cx = x;
  let left = width;
  const list = typeof segs === 'string' ? [{ text: segs }] : segs;
  for (const seg of list) {
    if (left <= 0) break;
    const style = { ...baseStyle };
    if (seg.fg) style.fg = seg.fg;
    if (seg.bg) style.bg = seg.bg;
    if (seg.attr !== undefined) style.attr = seg.attr;
    const text = seg.text ?? '';
    const used = s.text(cx, y, text, style, left);
    cx += used;
    left -= used;
  }
  return width - left;
}

export function label(ctx, x, y, text, style = {}, maxWidth = Infinity) {
  return ctx.s.text(x, y, text, { fg: ctx.t.text, bg: ctx.t.panel, ...style }, maxWidth);
}

export function kv(ctx, x, y, key, value, width, opts = {}) {
  const { t } = ctx;
  const kw = Math.min(strWidth(key), Math.max(0, width - 2));
  ctx.s.text(x, y, key, { fg: t.dim, bg: t.panel }, kw);
  const vw = Math.max(0, width - kw - 1);
  const v = truncate(String(value ?? ''), vw);
  ctx.s.text(x + width - strWidth(v), y, v, { fg: opts.fg || t.text, bg: t.panel, attr: opts.attr || 0 });
}

// --- sparklines, gauges, bars ------------------------------------------------

const SPARK = '▁▂▃▄▅▆▇█';

export function sparkline(values, width) {
  const vals = (values || []).filter((v) => Number.isFinite(v));
  if (!vals.length || width <= 0) return ''.padEnd(width);
  const step = vals.length / width;
  const pts = [];
  for (let i = 0; i < width; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    let n = 0;
    for (let j = from; j < to && j < vals.length; j++) {
      sum += vals[j];
      n++;
    }
    pts.push(n ? sum / n : vals[vals.length - 1]);
  }
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  return pts.map((v) => SPARK[Math.min(7, Math.max(0, Math.round(((v - min) / range) * 7)))]).join('');
}

export function gauge(ctx, x, y, width, ratio, opts = {}) {
  const { s, t } = ctx;
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(r * width);
  const fg = opts.fg || t.accent;
  for (let i = 0; i < width; i++) {
    const on = i < filled;
    s.put(x + i, y, on ? '█' : '░', { fg: on ? fg : t.muted, bg: opts.bg || t.panel });
  }
}

export function bar(value, max, width, chars = '█▉▊▋▌▍▎▏') {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || width <= 0) return ''.padEnd(width);
  const r = Math.max(0, Math.min(1, value / max));
  const cells = r * width;
  const full = Math.floor(cells);
  const frac = cells - full;
  let out = chars[0].repeat(full);
  if (full < width) {
    const idx = Math.round((1 - frac) * (chars.length - 1));
    out += frac > 0.05 ? chars[Math.min(chars.length - 1, idx)] : ' ';
  }
  return padEnd(out, width);
}

// --- tabs and buttons ----------------------------------------------------------

export function tabs(ctx, r, items, active, onSelect) {
  const { s, t } = ctx;
  s.fill(r, ' ', { bg: t.tabBg });
  let x = r.x;
  items.forEach((item, i) => {
    const isActive = i === active;
    const text = ` ${item.hotkey ? `${item.hotkey}:` : ''}${item.label} `;
    const w = strWidth(text);
    if (x + w > r.x + r.w) return;
    s.text(x, r.y, text, {
      fg: isActive ? t.tabActiveText : t.dim,
      bg: isActive ? t.tabActiveBg : t.tabBg,
      attr: isActive ? ATTR.BOLD : 0,
    });
    if (onSelect) hit(ctx, rect(x, r.y, w, 1), { onClick: () => onSelect(i) });
    x += w + 1;
  });
  return x;
}

export function button(ctx, x, y, text, opts = {}) {
  const { s, t } = ctx;
  const label = ` ${text} `;
  const w = strWidth(label);
  s.text(x, y, label, {
    fg: opts.active ? t.tabActiveText : opts.fg || t.accent,
    bg: opts.active ? opts.activeBg || t.accent : opts.bg || t.muted,
    attr: ATTR.BOLD,
  });
  if (opts.onClick) hit(ctx, rect(x, y, w, 1), { onClick: opts.onClick });
  return w;
}

// --- list ------------------------------------------------------------------------

// Scrollable, selectable list state. Views keep one per pane.
export class ListView {
  constructor() {
    this.selected = 0;
    this.scroll = 0;
    this.count = 0;
    this.height = 1;
    this.lastClickAt = 0;
    this.lastClickIndex = -1;
    this.items = null; // the array drawn last, so views can expand the selected row
  }

  setCount(n) {
    this.count = n;
    if (this.selected >= n) this.selected = Math.max(0, n - 1);
    this.clampScroll();
  }

  move(delta) {
    if (!this.count) return;
    this.selected = Math.max(0, Math.min(this.count - 1, this.selected + delta));
    this.clampScroll();
  }

  page(dir) {
    this.move(dir * Math.max(1, this.height - 1));
  }

  first() {
    this.selected = 0;
    this.clampScroll();
  }

  last() {
    this.selected = Math.max(0, this.count - 1);
    this.clampScroll();
  }

  wheel(delta) {
    this.scroll = Math.max(0, Math.min(Math.max(0, this.count - this.height), this.scroll + delta));
    if (this.selected < this.scroll) this.selected = this.scroll;
    if (this.selected >= this.scroll + this.height) this.selected = this.scroll + this.height - 1;
  }

  clampScroll() {
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + this.height) this.scroll = this.selected - this.height + 1;
    const maxScroll = Math.max(0, this.count - this.height);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    if (this.scroll < 0) this.scroll = 0;
  }

  handleKey(ev) {
    switch (ev.name) {
      case 'up':
      case 'k':
        this.move(-1);
        return true;
      case 'down':
      case 'j':
        this.move(1);
        return true;
      case 'pageup':
        this.page(-1);
        return true;
      case 'pagedown':
        this.page(1);
        return true;
      case 'home':
      case 'g':
        this.first();
        return true;
      case 'end':
      case 'G':
        this.last();
        return true;
      default:
        return false;
    }
  }

  // Draw rows. rowFn(item, index, { selected, width }) returns segments or a
  // string. `rowHeight` rows per item (default 1). Returns the visible range.
  draw(ctx, r, items, rowFn, opts = {}) {
    const { s, t } = ctx;
    const rowHeight = opts.rowHeight || 1;
    const focused = opts.focused !== false;
    this.height = Math.max(1, Math.floor(r.h / rowHeight));
    this.items = items;
    this.setCount(items.length);
    const showBar = items.length > this.height && r.w > 4;
    const width = r.w - (showBar ? 1 : 0);
    if (!items.length) {
      s.text(r.x + 1, r.y, opts.empty || 'no data yet', { fg: t.dim, bg: t.panel }, width - 1);
      return;
    }
    const cx = r.x + 1; // column 0 holds the selection marker
    const cw = Math.max(1, width - 1);
    for (let row = 0; row < this.height; row++) {
      const index = this.scroll + row;
      if (index >= items.length) break;
      const y = r.y + row * rowHeight;
      const selected = index === this.selected;
      const bg = selected ? t.sel : t.panel;
      const fg = selected ? t.selText : t.text;
      for (let k = 0; k < rowHeight; k++) s.fill(rect(r.x, y + k, width, 1), ' ', { bg, fg, attr: 0 });
      const out = rowFn(items[index], index, { selected, width: cw, focused });
      const lines = Array.isArray(out) && Array.isArray(out[0]) ? out : [out];
      lines.slice(0, rowHeight).forEach((line, k) => segments(ctx, cx, y + k, line, cw, { bg, fg }));
      if (selected) s.put(r.x, y, focused ? '▌' : '▏', { fg: focused ? t.accent : t.muted, bg });
      hit(ctx, rect(r.x, y, width, rowHeight), {
        onClick: () => {
          const now = Date.now();
          const double = this.lastClickIndex === index && now - this.lastClickAt < 450;
          this.lastClickAt = now;
          this.lastClickIndex = index;
          const wasSelected = this.selected === index;
          this.selected = index;
          this.clampScroll();
          if (opts.onFocus) opts.onFocus();
          if ((double || wasSelected) && opts.onActivate) opts.onActivate(items[index], index);
          else if (opts.onSelect) opts.onSelect(items[index], index);
        },
      });
    }
    if (showBar) scrollbar(ctx, r.x + r.w - 1, r.y, r.h, this.scroll, this.height, items.length);
    hit(ctx, r, {
      onWheel: (dir) => {
        this.wheel(dir * 3);
        if (opts.onFocus) opts.onFocus();
      },
    });
  }
}

export function scrollbar(ctx, x, y, h, scroll, visible, total) {
  const { s, t } = ctx;
  if (h <= 0) return;
  const thumb = Math.max(1, Math.round((visible / total) * h));
  const maxStart = h - thumb;
  const start = total > visible ? Math.round((scroll / (total - visible)) * maxStart) : 0;
  for (let i = 0; i < h; i++) {
    const on = i >= start && i < start + thumb;
    s.put(x, y + i, on ? '┃' : '│', { fg: on ? t.accent : t.muted, bg: t.panel });
  }
}

// --- misc text blocks --------------------------------------------------------

export function paragraph(ctx, r, lines, style = {}) {
  const { s, t } = ctx;
  lines.slice(0, r.h).forEach((line, i) => s.text(r.x, r.y + i, line, { fg: t.text, bg: t.panel, ...style }, r.w));
}

export function heading(ctx, x, y, text, width) {
  const { s, t } = ctx;
  const txt = ` ${text.toUpperCase()} `;
  s.text(x, y, txt, { fg: t.accent, bg: t.panel, attr: ATTR.BOLD }, width);
  const w = strWidth(txt);
  if (width > w) s.hline(x + w, y, width - w, '─', { fg: t.muted, bg: t.panel });
}

// Marquee ticker: segments scroll right-to-left by `offset` cells.
export function ticker(ctx, r, segs, offset) {
  const { s, t } = ctx;
  s.fill(r, ' ', { bg: t.tickerBg, fg: t.tickerText });
  if (!segs.length || r.w <= 0) return;
  const cells = [];
  for (const seg of segs) {
    for (const ch of seg.text) cells.push({ ch, fg: seg.fg || t.tickerText, attr: seg.attr || 0 });
  }
  if (!cells.length) return;
  const total = cells.length;
  const start = ((offset % total) + total) % total;
  let x = r.x;
  let i = start;
  while (x < r.x + r.w) {
    const c = cells[i % total];
    const w = strWidth(c.ch);
    if (w === 2 && x + 1 >= r.x + r.w) break;
    if (w > 0) s.text(x, r.y, c.ch, { fg: c.fg, bg: t.tickerBg, attr: c.attr });
    x += w || 1;
    i++;
  }
}

// --- braille world map -------------------------------------------------------

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export function decodeBitmap(map) {
  const buf = Buffer.from(map.bits, 'base64');
  const bytesPerRow = Math.ceil(map.width / 8);
  return {
    width: map.width,
    height: map.height,
    get(x, y) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return 0;
      return (buf[y * bytesPerRow + (x >> 3)] >> (7 - (x & 7))) & 1;
    },
  };
}

// Project lon/lat to a cell inside `r` using the map's extent.
export function project(map, r, lon, lat) {
  const x = r.x + ((lon - map.lonMin) / (map.lonMax - map.lonMin)) * r.w;
  const y = r.y + ((map.latMax - lat) / (map.latMax - map.latMin)) * r.h;
  return { x: Math.floor(x), y: Math.floor(y), fx: x, fy: y };
}

// Render the land bitmap with braille, then overlay blips.
// blips: [{ lon, lat, ch, fg, pulse }]; opts.sweepX: column of the radar line.
export function worldMap(ctx, r, map, bitmap, blips = [], opts = {}) {
  const { s, t } = ctx;
  if (r.w <= 0 || r.h <= 0) return;
  const dotsW = r.w * 2;
  const dotsH = r.h * 4;
  const sx = bitmap.width / dotsW;
  const sy = bitmap.height / dotsH;
  for (let cy = 0; cy < r.h; cy++) {
    for (let cx = 0; cx < r.w; cx++) {
      let code = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = Math.floor((cx * 2 + dx) * sx);
          const py = Math.floor((cy * 4 + dy) * sy);
          if (bitmap.get(px, py)) code |= BRAILLE_BITS[dy][dx];
        }
      }
      let fg = t.map;
      if (opts.sweepX !== undefined) {
        const d = Math.abs(cx - opts.sweepX);
        if (d < 1) fg = t.scan;
        else if (d < 4) fg = mix(t.map, t.scan, 0.5 - d * 0.12);
        else if (d < 10) fg = mix(t.mapDim, t.map, 1 - (d - 4) / 12);
        else fg = t.mapDim;
      }
      s.put(r.x + cx, r.y + cy, code ? String.fromCharCode(0x2800 + code) : ' ', { fg, bg: t.panel });
    }
  }
  if (opts.grid) {
    for (const lon of [-90, 0, 90]) {
      const p = project(map, r, lon, 0);
      for (let y = r.y; y < r.y + r.h; y++) {
        const i = y * s.cols + p.x;
        if (s.ch[i] === ' ') s.put(p.x, y, '·', { fg: t.muted, bg: t.panel });
      }
    }
    const eq = project(map, r, 0, 0);
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = eq.y * s.cols + x;
      if (s.ch[i] === ' ') s.put(x, eq.y, '·', { fg: t.muted, bg: t.panel });
    }
  }
  for (const b of blips) {
    if (!Number.isFinite(b.lon) || !Number.isFinite(b.lat)) continue;
    if (b.lat < map.latMin || b.lat > map.latMax) continue;
    const p = project(map, r, b.lon, b.lat);
    if (p.x < r.x || p.x >= r.x + r.w || p.y < r.y || p.y >= r.y + r.h) continue;
    s.put(p.x, p.y, b.ch || '●', { fg: b.fg || t.accent2, bg: t.panel, attr: b.bold ? ATTR.BOLD : 0 });
  }
}

export { center, padEnd, padStart, truncate };
