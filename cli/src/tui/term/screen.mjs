// A cell buffer with clipping and a diff renderer. Views draw into a Screen
// every frame; `diff()` emits only the escape sequences needed to update the
// terminal from the previously flushed frame.
import { CSI, charWidth, sanitize, sgrColor } from './ansi.mjs';

export const ATTR = { BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, BLINK: 16, REVERSE: 32 };

const WIDE_TAIL = '\u0000';

export class Screen {
  constructor(cols, rows, { depth = 24 } = {}) {
    this.depth = depth;
    this.resize(cols, rows);
    this.clipStack = [];
  }

  resize(cols, rows) {
    this.cols = Math.max(1, cols | 0);
    this.rows = Math.max(1, rows | 0);
    const n = this.cols * this.rows;
    this.ch = new Array(n).fill(' ');
    this.fg = new Array(n).fill('');
    this.bg = new Array(n).fill('');
    this.attr = new Uint8Array(n);
    this.clip = { x: 0, y: 0, w: this.cols, h: this.rows };
    this.clipStack = [];
  }

  clear(bg = '') {
    this.ch.fill(' ');
    this.fg.fill('');
    this.bg.fill(bg);
    this.attr.fill(0);
  }

  pushClip(rect) {
    this.clipStack.push(this.clip);
    const c = this.clip;
    const x = Math.max(c.x, rect.x);
    const y = Math.max(c.y, rect.y);
    const r = Math.min(c.x + c.w, rect.x + rect.w);
    const b = Math.min(c.y + c.h, rect.y + rect.h);
    this.clip = { x, y, w: Math.max(0, r - x), h: Math.max(0, b - y) };
  }

  popClip() {
    this.clip = this.clipStack.pop() || { x: 0, y: 0, w: this.cols, h: this.rows };
  }

  inClip(x, y) {
    const c = this.clip;
    return x >= c.x && y >= c.y && x < c.x + c.w && y < c.y + c.h;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    const i = y * this.cols + x;
    return { ch: this.ch[i], fg: this.fg[i], bg: this.bg[i], attr: this.attr[i] };
  }

  put(x, y, ch, style = {}) {
    if (!this.inClip(x, y)) return;
    // A wide char (CJK, emoji) covers this cell and the next: the terminal
    // advances two columns, so the model must too or the rest of the row drifts.
    let wide = charWidth(ch) === 2;
    if (wide && !this.inClip(x + 1, y)) {
      ch = ' ';
      wide = false;
    }
    const i = y * this.cols + x;
    // Overwriting half of a wide char: blank the other half.
    if (this.ch[i] === WIDE_TAIL && x > 0) this.ch[i - 1] = ' ';
    if (x + 1 < this.cols && this.ch[i + 1] === WIDE_TAIL && !wide) this.ch[i + 1] = ' ';
    this.ch[i] = ch;
    this.setStyle(i, style);
    if (wide) {
      const j = i + 1;
      if (x + 2 < this.cols && this.ch[j + 1] === WIDE_TAIL) this.ch[j + 1] = ' ';
      this.ch[j] = WIDE_TAIL;
      this.setStyle(j, style);
    }
  }

  setStyle(i, style) {
    if (style.fg !== undefined) this.fg[i] = style.fg;
    if (style.bg !== undefined) this.bg[i] = style.bg;
    if (style.attr !== undefined) this.attr[i] = style.attr;
  }

  // Draw text at (x, y). Returns the number of columns consumed.
  text(x, y, str, style = {}, maxWidth = Infinity) {
    let cx = x;
    let used = 0;
    for (const ch of sanitize(str)) {
      const w = charWidth(ch);
      if (w === 0) continue;
      if (used + w > maxWidth) break;
      if (w === 2 && !this.inClip(cx + 1, y)) break;
      this.put(cx, y, ch, style);
      cx += w;
      used += w;
    }
    return used;
  }

  fill(rect, ch = ' ', style = {}) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) this.put(x, y, ch, style);
    }
  }

  // Set only the style of a region, keeping glyphs.
  paint(rect, style) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (!this.inClip(x, y)) continue;
        const i = y * this.cols + x;
        if (style.fg !== undefined) this.fg[i] = style.fg;
        if (style.bg !== undefined) this.bg[i] = style.bg;
        if (style.attr !== undefined) this.attr[i] = style.attr;
      }
    }
  }

  hline(x, y, w, ch = '─', style = {}) {
    for (let i = 0; i < w; i++) this.put(x + i, y, ch, style);
  }

  vline(x, y, h, ch = '│', style = {}) {
    for (let i = 0; i < h; i++) this.put(x, y + i, ch, style);
  }

  box(rect, style = {}, kind = 'single') {
    const b = BORDERS[kind] || BORDERS.single;
    const { x, y, w, h } = rect;
    if (w < 2 || h < 2) return;
    this.hline(x + 1, y, w - 2, b.h, style);
    this.hline(x + 1, y + h - 1, w - 2, b.h, style);
    this.vline(x, y + 1, h - 2, b.v, style);
    this.vline(x + w - 1, y + 1, h - 2, b.v, style);
    this.put(x, y, b.tl, style);
    this.put(x + w - 1, y, b.tr, style);
    this.put(x, y + h - 1, b.bl, style);
    this.put(x + w - 1, y + h - 1, b.br, style);
  }

  // Escape sequences turning `prev` (another Screen or null) into this frame.
  diff(prev) {
    const out = [];
    const full = !prev || prev.cols !== this.cols || prev.rows !== this.rows;
    let lastFg = null;
    let lastBg = null;
    let lastAttr = -1;
    let cursorX = -1;
    let cursorY = -1;
    if (full) out.push(`${CSI}0m${CSI}2J`);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x;
        const ch = this.ch[i];
        if (ch === WIDE_TAIL) continue;
        const fg = this.fg[i];
        const bg = this.bg[i];
        const attr = this.attr[i];
        if (!full && prev.ch[i] === ch && prev.fg[i] === fg && prev.bg[i] === bg && prev.attr[i] === attr) continue;
        if (cursorX !== x || cursorY !== y) {
          out.push(`${CSI}${y + 1};${x + 1}H`);
        }
        if (fg !== lastFg || bg !== lastBg || attr !== lastAttr) {
          const parts = ['0'];
          if (attr & ATTR.BOLD) parts.push('1');
          if (attr & ATTR.DIM) parts.push('2');
          if (attr & ATTR.ITALIC) parts.push('3');
          if (attr & ATTR.UNDERLINE) parts.push('4');
          if (attr & ATTR.BLINK) parts.push('5');
          if (attr & ATTR.REVERSE) parts.push('7');
          if (fg) parts.push(sgrColor(fg, false, this.depth));
          if (bg) parts.push(sgrColor(bg, true, this.depth));
          out.push(`${CSI}${parts.join(';')}m`);
          lastFg = fg;
          lastBg = bg;
          lastAttr = attr;
        }
        out.push(ch);
        const w = charWidth(ch) || 1;
        cursorX = x + w;
        cursorY = y;
        if (cursorX >= this.cols) {
          cursorX = -1;
          cursorY = -1;
        }
      }
    }
    if (out.length) out.push(`${CSI}0m`);
    return out.join('');
  }

  // Plain-text dump (tests and snapshots).
  toLines() {
    const lines = [];
    for (let y = 0; y < this.rows; y++) {
      let line = '';
      for (let x = 0; x < this.cols; x++) {
        const ch = this.ch[y * this.cols + x];
        if (ch !== WIDE_TAIL) line += ch;
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines;
  }

  clone() {
    const s = new Screen(this.cols, this.rows, { depth: this.depth });
    s.ch = this.ch.slice();
    s.fg = this.fg.slice();
    s.bg = this.bg.slice();
    s.attr = this.attr.slice();
    return s;
  }
}

export const BORDERS = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  tech: { tl: '◤', tr: '◥', bl: '◣', br: '◢', h: '─', v: '│' },
};
