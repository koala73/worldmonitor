// Draws one storyboard scene onto a DotCanvas: starfield, the 3D elements
// through the scene camera, element labels, the active callout box with its
// leader line, and the chart / equation / card panels. Returns what it drew so
// the view can place the narration and footer around it.
import { mix, strWidth, wrap } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { cue, ease, elementShape, lerpCamera, makeCamera, rnd } from './engine.mjs';

export const CALLOUT_MS_PER_CHAR = 18;

export function themeColor(t, name) {
  if (typeof name === 'string' && name[0] === '#') return name;
  const map = { accent: t.accent, accent2: t.accent2, accent3: t.accent3, good: t.good, warn: t.warn, bad: t.bad, info: t.info, text: t.text, dim: t.dim };
  return map[name] || t.accent;
}

const cell = (p) => [Math.floor(p[0] / 2), Math.floor(p[1] / 4)];

// Camera for a scene at time t (seconds).
export function sceneCamera(scene, t, w, h) {
  const k = ease(Math.min(1, t / Math.max(0.1, scene.duration)), scene.camera.ease);
  const c = lerpCamera(scene.camera.from, scene.camera.to, k);
  c.yaw += scene.camera.spin * t;
  return makeCamera(c, w, h);
}

function starfield(canvas, bg, text, t) {
  const n = Math.floor(canvas.cols * canvas.rows * 0.012);
  for (let i = 0; i < n; i++) {
    const x = Math.floor(rnd(i * 3 + 1) * canvas.w);
    const y = Math.floor(rnd(i * 3 + 2) * canvas.h);
    const tw = 0.5 + 0.5 * Math.sin(t * (1 + rnd(i * 3 + 3) * 2) + i);
    canvas.dot(x, y, mix(bg, text, 0.12 + 0.18 * tw), -100);
  }
}

function drawShape(canvas, cam, shape, color, bg, pri, dimmed) {
  const base = dimmed ? mix(bg, color, 0.38) : color;
  for (const [a, b] of shape.segments) {
    const pa = cam.project(a);
    const pb = cam.project(b);
    if (!pa || !pb) continue;
    const d = (pa[2] + pb[2]) / 2;
    canvas.line(pa[0], pa[1], pb[0], pb[1], cue(base, bg, d), pri + Math.round((1 - d) * 20));
  }
  for (const p of shape.points) {
    const q = cam.project(p);
    if (!q) continue;
    let c = cue(base, bg, q[2]);
    if (p[3] !== undefined) c = mix(bg, c, 0.25 + 0.75 * p[3]);
    canvas.dot(q[0], q[1], c, pri + Math.round((1 - q[2]) * 20) + 1);
  }
}

// Draw a framed text box on the glyph layer. Returns the rect used.
export function textBox(canvas, x, y, w, lines, { fg, bg, border, title = '', titleFg = null, attr = 0, pri = 200, cursor = false, fill = true } = {}) {
  const h = lines.length + 2;
  const x0 = Math.max(0, Math.min(canvas.cols - w, x));
  const y0 = Math.max(0, Math.min(canvas.rows - h, y));
  if (!fill) canvas.clearRect(x0, y0, w, h); // border only: the dots inside are the content
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const edge = j === 0 || j === h - 1 || i === 0 || i === w - 1;
      if (!fill && !edge) continue;
      let ch = ' ';
      if (j === 0 && i === 0) ch = '┌';
      else if (j === 0 && i === w - 1) ch = '┐';
      else if (j === h - 1 && i === 0) ch = '└';
      else if (j === h - 1 && i === w - 1) ch = '┘';
      else if (j === 0 || j === h - 1) ch = '─';
      else if (i === 0 || i === w - 1) ch = '│';
      canvas.glyph(x0 + i, y0 + j, ch, edge ? border : fg, { bg, pri });
    }
  }
  if (title) {
    const tt = ` ${title.slice(0, Math.max(0, w - 4))} `;
    canvas.writeText(x0 + 1, y0, tt, titleFg || border, bg, ATTR.BOLD, pri + 1);
  }
  lines.forEach((line, j) => {
    const text = typeof line === 'string' ? line : line.text;
    const lf = typeof line === 'string' ? fg : line.fg || fg;
    const la = typeof line === 'string' ? attr : line.attr ?? attr;
    canvas.writeText(x0 + 1, y0 + 1 + j, text.slice(0, w - 2), lf, bg, la, pri + 1);
    if (cursor && j === lines.length - 1 && strWidth(text) < w - 2) canvas.glyph(x0 + 1 + strWidth(text), y0 + 1 + j, '▌', fg, { bg, pri: pri + 1 });
  });
  return { x: x0, y: y0, w, h };
}

// The active callout: typed text in a box beside its target, with a leader line.
function drawCallout(canvas, cam, scene, callout, t, theme, { calloutW }) {
  const el = callout.target ? scene.elements.find((e) => e.id === callout.target) : null;
  const anchor = el ? (el.type === 'beam' || el.type === 'arrow' ? [(el.from[0] + el.to[0]) / 2, (el.from[1] + el.to[1]) / 2, (el.from[2] + el.to[2]) / 2] : el.type === 'particles' ? [el.from[0] + el.dir[0] * 0.4, el.from[1] + el.dir[1] * 0.4, el.from[2] + el.dir[2] * 0.4] : el.at) : null;
  const pt = anchor ? cam.project(anchor) : null;
  const since = Math.max(0, t - callout.t);
  const shown = Math.floor((since * 1000) / CALLOUT_MS_PER_CHAR);
  const text = callout.text.slice(0, shown);
  const w = Math.min(calloutW, Math.max(16, strWidth(callout.text) + 4));
  const lines = wrap(text || ' ', w - 2);
  const h = lines.length + 2;
  const slide = 1 - ease(Math.min(1, since / 0.35), 'out');
  let x;
  let y;
  const tc = pt ? cell(pt) : [Math.floor(canvas.cols / 2), Math.floor(canvas.rows / 2)];
  if (!pt) {
    x = Math.floor((canvas.cols - w) / 2);
    y = 1;
  } else if (callout.side === 'left') {
    x = tc[0] - w - 4 - Math.round(slide * 6);
    y = tc[1] - Math.floor(h / 2);
  } else if (callout.side === 'top') {
    x = tc[0] - Math.floor(w / 2);
    y = tc[1] - h - 2 - Math.round(slide * 3);
  } else if (callout.side === 'bottom') {
    x = tc[0] - Math.floor(w / 2);
    y = tc[1] + 3 + Math.round(slide * 3);
  } else {
    x = tc[0] + 4 + Math.round(slide * 6);
    y = tc[1] - Math.floor(h / 2);
  }
  const box = textBox(canvas, x, y, w, lines, { fg: theme.text, bg: theme.sel, border: theme.borderFocus, pri: 300, cursor: shown < callout.text.length, attr: 0 });
  if (pt) {
    // Leader line from the nearest box edge to the target, animated dashes.
    const bx = pt[0] < box.x * 2 ? box.x * 2 : pt[0] > (box.x + box.w) * 2 ? (box.x + box.w) * 2 - 1 : Math.max(box.x * 2, Math.min((box.x + box.w) * 2 - 1, pt[0]));
    const by = pt[1] < box.y * 4 ? box.y * 4 : pt[1] > (box.y + box.h) * 4 ? (box.y + box.h) * 4 - 1 : Math.max(box.y * 4, Math.min((box.y + box.h) * 4 - 1, pt[1]));
    canvas.line(bx, by, pt[0], pt[1], theme.accent, 250, 3, Math.floor(t * 12));
    const tcc = cell(pt);
    canvas.glyph(tcc[0], tcc[1], '◆', theme.accent, { pri: 260 });
  }
  return box;
}

function drawChart(canvas, chart, t, theme, region) {
  const { x, y, w, h } = region;
  if (w < 18 || h < 6) return;
  const reveal = Math.max(0, Math.min(1, (t - 1.5) / 5));
  if (reveal <= 0) return;
  const lines = [];
  textBox(canvas, x, y, w, new Array(h - 2).fill(''), { fg: theme.text, bg: theme.panel, border: theme.border, title: chart.title, titleFg: theme.accent3, pri: 150, fill: false });
  const px0 = (x + 2) * 2;
  const py0 = (y + 1) * 4 + 2;
  const pw = (w - 4) * 2;
  const ph = (h - 3) * 4 - 4;
  const colorOf = (s, i) => themeColor(theme, s.color || ['accent', 'accent2', 'info', 'good', 'warn'][i % 5]);
  if (chart.type === 'table') {
    const cols = chart.columns.length ? chart.columns : [];
    const rows = [cols, ...chart.rows].filter((r) => r.length);
    const cw = Math.max(6, Math.floor((w - 2) / Math.max(1, rows[0]?.length || 1)));
    rows.slice(0, h - 2).forEach((r, j) => r.forEach((c, i) => canvas.writeText(x + 1 + i * cw, y + 1 + j, c.slice(0, cw - 1), j === 0 ? theme.accent : theme.text, theme.panel, j === 0 ? ATTR.BOLD : 0, 151)));
    return;
  }
  if (chart.type === 'timeline') {
    const evs = chart.events;
    if (!evs.length) return;
    const xs = evs.map((e) => e.x);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs) || lo + 1;
    const yy = py0 + Math.floor(ph / 2);
    canvas.line(px0, yy, px0 + pw * reveal, yy, theme.border, 151);
    evs.forEach((e, i) => {
      const k = hi === lo ? 0 : (e.x - lo) / (hi - lo);
      if (k > reveal) return;
      const ex = px0 + k * pw;
      canvas.line(ex, yy - 4, ex, yy + 4, theme.accent, 152);
      const c = cell([ex, yy]);
      const label = `${e.x}${e.label ? ` ${e.label}` : ''}`;
      canvas.label(c[0], c[1] + (i % 2 ? 2 : -2), label, i % 2 ? theme.text : theme.accent2, { bg: theme.panel, pri: 153, force: true });
    });
    return;
  }
  // numeric charts: line, bar, spectrum, skymap
  const all = chart.series.flatMap((s) => s.values);
  if (!all.length) return;
  let xmin = Math.min(...all.map((p) => p[0]).filter(Number.isFinite));
  let xmax = Math.max(...all.map((p) => p[0]).filter(Number.isFinite));
  let ymin = Math.min(...all.map((p) => p[1]));
  let ymax = Math.max(...all.map((p) => p[1]));
  if (chart.type === 'skymap') {
    const mx = Math.max(0.5, (xmax - xmin) * 0.3);
    const my = Math.max(0.5, (ymax - ymin) * 0.3);
    xmin -= mx;
    xmax += mx;
    ymin -= my;
    ymax += my;
  } else {
    if (chart.type !== 'line') ymin = Math.min(0, ymin);
    if (ymax === ymin) ymax = ymin + 1;
    if (!Number.isFinite(xmin) || xmax === xmin) {
      xmin = 0;
      xmax = Math.max(1, all.length - 1);
    }
  }
  const sx = (v) => px0 + ((v - xmin) / (xmax - xmin)) * pw;
  const sy = (v) => py0 + ph - ((v - ymin) / (ymax - ymin)) * ph;
  // axes
  canvas.line(px0, py0, px0, py0 + ph, theme.border, 151);
  canvas.line(px0, py0 + ph, px0 + pw, py0 + ph, theme.border, 151);
  if (chart.type === 'skymap') {
    for (let g = 1; g < 4; g++) {
      canvas.line(px0 + (pw * g) / 4, py0, px0 + (pw * g) / 4, py0 + ph, mix(theme.panel, theme.border, 0.6), 150, 2);
      canvas.line(px0, py0 + (ph * g) / 4, px0 + pw, py0 + (ph * g) / 4, mix(theme.panel, theme.border, 0.6), 150, 2);
    }
  }
  chart.series.forEach((s, i) => {
    const color = colorOf(s, i);
    const vals = s.values;
    if (chart.type === 'line') {
      const n = Math.max(1, Math.floor(vals.length * reveal));
      const pts = vals.slice(0, n + 1).map((p, j) => [Number.isFinite(p[0]) ? sx(p[0]) : sx(j), sy(p[1])]);
      canvas.polyline(pts, color, 155 + i);
    } else if (chart.type === 'bar' || chart.type === 'spectrum') {
      const bw = Math.max(2, (pw / Math.max(1, all.length)) * 0.6);
      vals.forEach((p, j) => {
        const cx = Number.isFinite(p[0]) ? sx(p[0]) : sx(j);
        const top = sy(p[1] * reveal);
        canvas.fillRings([[[cx - bw / 2, top], [cx + bw / 2, top], [cx + bw / 2, py0 + ph], [cx - bw / 2, py0 + ph]]], color, 155 + i, chart.type === 'spectrum' ? 1 : 0);
      });
    } else if (chart.type === 'skymap') {
      vals.forEach((p) => {
        const c = cell([sx(p[0]), sy(p[1])]);
        canvas.glyph(c[0], c[1], i === 0 ? '✦' : i === 1 ? '◉' : '·', color, { pri: 160 + i });
      });
    }
    // legend
    const lg = `${['●', '■', '▲', '◆', '○'][i % 5]} ${s.label}`;
    canvas.writeText(x + w - 2 - strWidth(lg), y + 2 + i, lg, color, theme.panel, 0, 158); // below the y-axis label row
  });
  for (const e of chart.events) {
    const ex = sx(e.x);
    if (ex < px0 || ex > px0 + pw) continue;
    canvas.line(ex, py0, ex, py0 + ph, theme.warn, 157, 2, Math.floor(t * 6));
    const c = cell([ex, py0]);
    canvas.label(c[0], c[1], e.label, theme.warn, { bg: theme.panel, pri: 159 });
  }
  if (chart.xLabel) canvas.writeText(x + w - 2 - strWidth(chart.xLabel), y + h - 2, chart.xLabel, theme.dim, theme.panel, 0, 158);
  if (chart.yLabel) canvas.writeText(x + 1, y + 1, chart.yLabel, theme.dim, theme.panel, 0, 158);
  void lines;
}

function drawEquation(canvas, eq, t, theme, region) {
  if (t < 2.5) return;
  const shown = Math.floor(((t - 2.5) * 1000) / 22);
  const w = Math.min(region.w, Math.max(24, strWidth(eq.expr) + 4));
  const lines = [{ text: eq.expr.slice(0, shown), fg: theme.accent3, attr: ATTR.BOLD }, ...wrap(eq.meaning.slice(0, Math.max(0, shown - eq.expr.length)), w - 2).slice(0, 3).map((l) => ({ text: l, fg: theme.dim }))];
  textBox(canvas, region.x, region.y + region.h - lines.length - 2, w, lines, { fg: theme.text, bg: theme.panel, border: theme.accent3, title: 'MATH', pri: 180 });
}

function drawCard(canvas, card, t, theme, region) {
  if (t < 1) return;
  const w = Math.min(region.w, 34);
  const lines = [];
  if (card.kind === 'person') {
    lines.push({ text: card.who || card.title, fg: theme.accent2, attr: ATTR.BOLD });
    if (card.years) lines.push({ text: card.years, fg: theme.dim });
    if (card.who && card.title) lines.push({ text: card.title, fg: theme.accent });
  } else if (card.kind === 'number') {
    lines.push({ text: `${card.value} ${card.unit}`.trim(), fg: theme.accent, attr: ATTR.BOLD });
  } else if (card.kind === 'quote') {
    if (card.title) lines.push({ text: `— ${card.title}`, fg: theme.dim });
  }
  for (const l of card.lines) for (const ll of wrap(l, w - 2)) lines.push({ text: ll, fg: card.kind === 'quote' ? theme.text : theme.text, attr: card.kind === 'quote' ? ATTR.ITALIC : 0 });
  const shownLines = Math.min(lines.length, Math.floor((t - 1) / 0.35) + 1);
  textBox(canvas, region.x, region.y, w, lines.slice(0, shownLines), { fg: theme.text, bg: theme.panel, border: theme.accent2, title: card.kind === 'person' ? 'WHO' : card.kind === 'number' ? card.title || 'NUMBER' : card.kind === 'quote' ? 'QUOTE' : card.title || 'FACT', pri: 180 });
}

// Render a scene at time t. Returns { callout, camera }.
export function renderScene(canvas, scene, t, { theme, mask = null, callout = null, anim = true } = {}) {
  canvas.clear();
  const bg = theme.panel;
  starfield(canvas, bg, theme.text, anim ? t : 0);
  const cam = sceneCamera(scene, t, canvas.w, canvas.h);
  const target = callout && callout.target ? callout.target : null;
  const elements = scene.elements.filter((e) => t >= e.appear && t < e.vanish);
  for (const e of elements) {
    const color = themeColor(theme, e.color);
    const shape = elementShape(e, t, { mask });
    drawShape(canvas, cam, shape, color, bg, 20, Boolean(target) && e.id !== target);
  }
  // Labels after shapes so they sit on top; the targeted one is highlighted.
  for (const e of elements) {
    const label = e.type === 'text' ? e.text : e.label;
    if (!label) continue;
    const anchor = e.type === 'beam' || e.type === 'arrow' ? e.to : e.type === 'particles' ? e.from : e.at;
    const p = cam.project(anchor);
    if (!p) continue;
    const c = cell(p);
    const hot = e.id === target || e.type === 'text';
    canvas.label(c[0], c[1], label, hot ? theme.accent : mix(bg, themeColor(theme, e.color), target ? 0.5 : 0.8), { pri: hot ? 120 : 100, attr: hot ? ATTR.BOLD : 0 });
  }
  const cols = canvas.cols;
  const rows = canvas.rows;
  const panelW = Math.max(18, Math.floor(cols * 0.4));
  if (scene.chart) drawChart(canvas, scene.chart, t, theme, { x: cols - panelW - 1, y: 0, w: panelW, h: Math.max(6, Math.floor(rows * 0.45)) });
  if (scene.card) drawCard(canvas, scene.card, t, theme, { x: 1, y: 0, w: Math.min(34, Math.floor(cols * 0.35)) });
  if (scene.equation) drawEquation(canvas, scene.equation, t, theme, { x: 1, y: 0, w: Math.min(cols - 2, Math.floor(cols * 0.55)), h: rows });
  let box = null;
  if (callout) box = drawCallout(canvas, cam, scene, callout, t, theme, { calloutW: Math.max(18, Math.min(40, Math.floor(cols * 0.36))) });
  return { callout: box, camera: cam };
}
