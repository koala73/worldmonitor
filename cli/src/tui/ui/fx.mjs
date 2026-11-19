// Animations and effects: boot sequence, pulse, wipe, typewriter, starfield.
import { center, mix, strWidth } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { rect } from './layout.mjs';

// 0..1 sine pulse with the given period.
export function pulse(now, periodMs = 1200, phase = 0) {
  return 0.5 + 0.5 * Math.sin(((now / periodMs) * 2 + phase) * Math.PI);
}

export function typewriterCount(startedAt, now, msPerChar = 10) {
  if (!startedAt) return Infinity;
  return Math.max(0, Math.floor((now - startedAt) / msPerChar));
}

// Deterministic pseudo random for stars.
function rand(seed) {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

export function starfield(ctx, r, now, density = 0.03, speed = 0.015) {
  const { s, t } = ctx;
  const n = Math.floor(r.w * r.h * density);
  for (let i = 0; i < n; i++) {
    const depth = 0.3 + rand(i * 3 + 1) * 0.7;
    const x = Math.floor(((rand(i * 3) * r.w + now * speed * depth) % r.w + r.w) % r.w);
    const y = Math.floor(rand(i * 3 + 2) * r.h);
    const ch = depth > 0.85 ? '✦' : depth > 0.6 ? '·' : '˙';
    s.put(r.x + x, r.y + y, ch, { fg: mix(t.bg, t.text, depth * 0.7), bg: t.bg });
  }
}

// 5-row block font for the boot logo.
const FONT = {
  W: ['█   █', '█   █', '█ █ █', '██ ██', '█   █'],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};

export function logoLines(text) {
  const rows = ['', '', '', '', ''];
  for (const ch of text) {
    const glyph = FONT[ch] || FONT[' '];
    for (let i = 0; i < 5; i++) rows[i] += `${glyph[i]} `;
  }
  return rows.map((r) => r.replace(/\s+$/, ''));
}

// Draw the logo centred in r, with a horizontal gradient between glow colours.
export function logo(ctx, r, now, opts = {}) {
  const { s, t } = ctx;
  const lines = logoLines(opts.text || 'WORLD MONITOR');
  const w = Math.max(...lines.map(strWidth));
  if (w > r.w || r.h < 5) {
    const txt = opts.text || 'WORLD MONITOR';
    s.text(r.x + Math.max(0, Math.floor((r.w - strWidth(txt)) / 2)), r.y + Math.floor(r.h / 2), txt, {
      fg: t.accent,
      bg: opts.bg || t.bg,
      attr: ATTR.BOLD,
    });
    return 1;
  }
  const x0 = r.x + Math.floor((r.w - w) / 2);
  const y0 = r.y + Math.floor((r.h - 5) / 2);
  const shimmer = ((now / 40) % (w + 20)) - 10;
  lines.forEach((line, i) => {
    let x = 0;
    for (const ch of line) {
      if (ch !== ' ') {
        const k = x / w;
        let fg = mix(t.glow[0], t.glow[1], k);
        const d = Math.abs(x - shimmer);
        if (opts.shimmer !== false && d < 3) fg = mix(fg, '#ffffff', 0.8 - d * 0.25);
        s.put(x0 + x, y0 + i, ch, { fg, bg: opts.bg || t.bg });
      }
      x += 1;
    }
  });
  return 5;
}

const BOOT_LINES = [
  'establishing uplink to api.worldmonitor.app',
  'minting anonymous session',
  'loading fast tier: quotes · seismic · insights · posture',
  'loading slow tier: conflict · climate · crypto · macro',
  'loading news digest: 18 categories',
  'resolving live video channels',
  'calibrating braille projection',
  'uplink nominal — press any key',
];

// Boot screen. Returns true once the sequence has finished (or input skipped it).
export function bootScreen(ctx, r, startedAt, now, progress) {
  const { s, t } = ctx;
  s.fill(r, ' ', { bg: t.bg });
  if (ctx.anim) starfield(ctx, r, now);
  const elapsed = now - startedAt;
  const logoH = logo(ctx, rect(r.x, r.y + Math.floor(r.h * 0.18), r.w, 5), now);
  const subtitle = 'G L O B A L   I N T E L L I G E N C E   T E R M I N A L';
  const sy = r.y + Math.floor(r.h * 0.18) + logoH + 1;
  s.text(r.x, sy, center(subtitle, r.w), { fg: t.dim, bg: t.bg });
  // progress bar
  const bw = Math.min(60, r.w - 8);
  const bx = r.x + Math.floor((r.w - bw) / 2);
  const by = sy + 3;
  const pct = Math.max(0, Math.min(1, progress));
  for (let i = 0; i < bw; i++) {
    const on = i / bw < pct;
    const head = Math.abs(i / bw - pct) < 0.03;
    s.put(bx + i, by, on ? '━' : '─', { fg: head ? '#ffffff' : on ? mix(t.glow[0], t.glow[1], i / bw) : t.muted, bg: t.bg });
  }
  s.text(bx, by + 1, `${Math.round(pct * 100)}%`.padStart(4), { fg: t.accent, bg: t.bg });
  // log lines (typewriter)
  const shown = Math.floor(elapsed / 260);
  const lineCount = Math.ceil(pct * (BOOT_LINES.length - 1));
  const visible = Math.min(BOOT_LINES.length, Math.max(shown, lineCount));
  for (let i = 0; i < visible && by + 3 + i < r.y + r.h - 1; i++) {
    const line = BOOT_LINES[i];
    const isLast = i === visible - 1;
    const chars = isLast ? Math.min(line.length, Math.floor((elapsed - i * 260) / 12)) : line.length;
    const prefix = isLast && chars < line.length ? '▸' : '✓';
    s.text(bx, by + 3 + i, `${prefix} ${line.slice(0, Math.max(0, chars))}`, { fg: isLast ? t.text : t.dim, bg: t.bg });
    if (isLast && chars < line.length && Math.floor(now / 300) % 2 === 0) s.put(bx + 2 + chars, by + 3 + i, '█', { fg: t.accent, bg: t.bg });
  }
  return pct >= 1 && elapsed > 1500;
}

// Transition wipe: progress 0..1 reveals the new frame left-to-right with a glowing bar.
export function wipe(ctx, r, progress) {
  const { s, t } = ctx;
  const p = Math.max(0, Math.min(1, progress));
  const edge = r.x + Math.floor(r.w * p);
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = edge + 1; x < r.x + r.w; x++) s.put(x, y, ' ', { bg: t.bg, fg: t.bg, attr: 0 });
    if (edge < r.x + r.w) s.put(edge, y, '▌', { fg: t.scan, bg: t.bg });
    if (edge - 1 >= r.x) s.paint(rect(edge - 1, y, 1, 1), { fg: mix(t.scan, t.text, 0.5) });
  }
}

// Help overlay box.
export function overlay(ctx, r, title, lines) {
  const { s, t } = ctx;
  const w = Math.min(r.w - 4, Math.max(40, ...lines.map((l) => strWidth(l) + 4)));
  const h = Math.min(r.h - 2, lines.length + 4);
  const x = r.x + Math.floor((r.w - w) / 2);
  const y = r.y + Math.floor((r.h - h) / 2);
  const box = rect(x, y, w, h);
  s.fill(box, ' ', { bg: t.sel, fg: t.text, attr: 0 });
  s.box(box, { fg: t.borderFocus, bg: t.sel }, 'double');
  s.text(x + 2, y, ` ${title} `, { fg: t.title, bg: t.sel, attr: ATTR.BOLD });
  lines.slice(0, h - 4).forEach((line, i) => s.text(x + 2, y + 2 + i, line, { fg: t.text, bg: t.sel }, w - 4));
  return box;
}
