// Map view chrome: toolbar, footer, layer sidebar, search box and the info card.
// Each takes the MapView it draws for (views/map.mjs) as its first argument.
import { strWidth, truncate, wrap } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { rect } from '../ui/layout.mjs';
import { button, hit, panel, segments } from '../ui/widgets.mjs';
import { imageryById } from '../map/imagery.mjs';
import { defaultView, fmtCoord, zoomAt } from '../map/geo.mjs';
import { LAYERS, LAYER_GROUPS } from '../map/layers.mjs';

export function drawToolbar(view, ctx, r) {
  const { s, t } = ctx;
  s.fill(r, ' ', { bg: t.bg });
  let x = r.x + 1;
  const b = (text, opts) => {
    x += button(ctx, x, r.y, text, opts) + 1;
  };
  b(view.view.mode === 'globe' ? '◍ GLOBE' : '▭ FLAT', { active: true, activeBg: t.accent, onClick: () => view.toggleMode() });
  b(`SAT ${view.sat ? 'ON' : 'OFF'}`, { active: view.sat, activeBg: t.good, onClick: () => view.toggleSat() });
  b(imageryById(view.imagery).short, { active: false, fg: view.sat ? t.text : t.dim, onClick: () => view.cycleImagery() });
  b(`☾ ${view.layers.dayNight ? 'DAY/NIGHT' : 'NO SHADE'}`, { active: Boolean(view.layers.dayNight), activeBg: t.accent3, onClick: () => view.toggleLayer('dayNight') });
  b('−', { onClick: () => view.setView(zoomAt(view.view, view.canvas.w, view.canvas.h, 1 / 1.5)) });
  b('+', { onClick: () => view.setView(zoomAt(view.view, view.canvas.w, view.canvas.h, 1.5)) });
  b('⌂ RESET', { onClick: () => view.setView({ ...defaultView(), mode: view.view.mode }) });
  b('⌕ SEARCH', { active: Boolean(view.search), onClick: () => view.onKey({ name: '/' }) });
  const onCount = LAYERS.filter((l) => view.layers[l.id] && l.kind !== 'overlay').length;
  b(`≡ LAYERS ${onCount}`, { active: view.sidebar, activeBg: t.accent2, onClick: () => view.onKey({ name: 'L' }) });
  if (view.pinned) b(`✕ ${truncate(view.pinned.name, 18)}`, { active: true, activeBg: t.warn, onClick: () => { view.pinned = null; view.touch(); } });
  const right = [];
  if (view.sat) right.push({ text: view.imageryStatus, fg: t.dim });
  const c = view.view;
  right.push({ text: `  ${fmtCoord(c.lat, c.lon)} `, fg: t.text });
  const rx = r.x + r.w - 1 - right.reduce((a, seg) => a + strWidth(seg.text), 0);
  if (rx > x) segments(ctx, rx, r.y, right, r.x + r.w - rx, { bg: t.bg });
}

export function drawFooter(view, ctx, r) {
  const { s, t } = ctx;
  s.fill(r, ' ', { bg: t.bg });
  const segs = [];
  if (view.hover && view.proj) {
    const g = view.proj.fromDot(view.hover.x * 2 + 1, view.hover.y * 4 + 2);
    if (g) segs.push({ text: ` ◎ ${fmtCoord(g.lat, g.lon)} `, fg: t.accent });
  }
  const f = view.hovered || view.pinned;
  if (f) {
    segs.push({ text: `${f.glyph || '▸'} `, fg: f.color || t.text });
    segs.push({ text: `${f.name} `, fg: t.text, attr: ATTR.BOLD });
    segs.push({ text: `· ${f.layerLabel || f.layer} `, fg: t.dim });
    if (f.from && f.to) segs.push({ text: `· ${f.fromName || fmtCoord(f.from[1], f.from[0])} → ${f.toName || fmtCoord(f.to[1], f.to[0])} `, fg: t.dim });
  } else {
    segs.push({ text: ' hover anything to highlight its layer · click to pin · Enter for details · drag to pan · wheel to zoom', fg: t.dim });
  }
  if (view.sat) segs.push({ text: `  imagery ${imageryById(view.imagery).credit}`, fg: t.muted });
  segments(ctx, r.x, r.y, segs, r.w, { bg: t.bg });
}

export function drawSidebar(view, ctx, r) {
  const { t } = ctx;
  const focused = view.focus === 'sidebar';
  const inner = panel(ctx, r, { title: 'Layers', focused, onClick: () => { view.focus = 'sidebar'; view.touch(); } });
  if (inner.w < 10) return;
  let x = inner.x;
  x += button(ctx, x, inner.y, 'ALL', { onClick: () => view.setAllLayers(true) }) + 1;
  x += button(ctx, x, inner.y, 'NONE', { onClick: () => view.setAllLayers(false) }) + 1;
  x += button(ctx, x, inner.y, 'DEFAULT', { onClick: () => view.resetLayers() }) + 1;
  x += button(ctx, x, inner.y, 'HIDE', { onClick: () => view.onKey({ name: 'L' }) });
  const listR = rect(inner.x, inner.y + 1, inner.w, inner.h - 1);
  const rows = sidebarRows();
  view.sidebarList.draw(
    ctx,
    listR,
    rows,
    (row, _i, { width }) => {
      if (row.group) {
        const members = LAYERS.filter((l) => l.group === row.group.id);
        const on = members.filter((l) => view.layers[l.id]).length;
        return [
          { text: `${row.group.label.toUpperCase()} `, fg: t.title, attr: ATTR.BOLD },
          { text: `${on}/${members.length}`, fg: t.dim },
        ];
      }
      const l = row.layer;
      const on = Boolean(view.layers[l.id]);
      const count = view.counts[l.id];
      const countText = l.build ? (on ? String(count ?? 0) : '') : '';
      const color = t[l.color] || t.text;
      const focusLayer = (view.hovered || view.pinned)?.layer;
      const nameW = Math.max(4, width - 4 - 2 - countText.length - 1);
      return [
        { text: on ? '◼ ' : '◻ ', fg: on ? color : t.muted },
        { text: `${l.glyph || ' '} `, fg: on ? color : t.muted },
        { text: truncate(l.label, nameW).padEnd(nameW), fg: focusLayer === l.id ? t.selText : on ? t.text : t.dim, attr: focusLayer === l.id ? ATTR.BOLD : 0 },
        { text: ` ${countText}`, fg: t.dim },
      ];
    },
    {
      focused,
      onFocus: () => {
        view.focus = 'sidebar';
      },
      onSelect: (row) => {
        if (row.layer) view.toggleLayer(row.layer.id);
        else if (row.group) view.toggleGroup(row.group.id);
      },
      onActivate: (row) => {
        if (row.layer) view.toggleLayer(row.layer.id);
        else if (row.group) view.toggleGroup(row.group.id);
      },
    },
  );
}

export function sidebarRows() {
  const rows = [];
  for (const g of LAYER_GROUPS) {
    rows.push({ group: g });
    for (const l of LAYERS) if (l.group === g.id) rows.push({ layer: l });
  }
  return rows;
}

export function drawSearch(view, ctx, inner) {
  const { s, t } = ctx;
  const sch = view.search;
  const w = Math.min(inner.w - 4, 60);
  const items = sch.results.slice(0, 10);
  const h = 3 + items.length;
  const box = rect(inner.x + 2, inner.y + 1, w, h);
  view.overlayBoxes.push(box);
  s.fill(box, ' ', { bg: t.sel });
  s.box(box, { fg: t.borderFocus, bg: t.sel }, 'round');
  s.text(box.x + 2, box.y, ' SEARCH ', { fg: t.title, bg: t.sel, attr: ATTR.BOLD });
  s.text(box.x + 2, box.y + 1, `⌕ ${sch.query}▏`, { fg: t.text, bg: t.sel, attr: ATTR.BOLD }, w - 4);
  items.forEach((it, i) => {
    const y = box.y + 2 + i;
    const active = i === sch.index;
    s.fill(rect(box.x + 1, y, w - 2, 1), ' ', { bg: active ? t.borderFocus : t.sel });
    s.text(box.x + 2, y, truncate(it.label, w - 20), { fg: active ? t.selText : t.text, bg: active ? t.borderFocus : t.sel });
    s.text(box.x + w - 2 - Math.min(14, strWidth(it.sub)), y, truncate(it.sub, 14), { fg: active ? t.selText : t.dim, bg: active ? t.borderFocus : t.sel });
    hit(ctx, rect(box.x, y, w, 1), { onClick: () => { view.search = null; view.jumpTo(it); } });
  });
  if (!items.length && sch.query) s.text(box.x + 2, box.y + 2, 'no matches', { fg: t.dim, bg: t.sel });
}

export function drawCard(view, ctx, inner, f, pinned) {
  const { s, t } = ctx;
  const w = Math.min(46, inner.w - 2);
  if (w < 24 || inner.h < 8) return;
  const rows = [];
  rows.push(['Position', fmtCoord(f.lat, f.lon)]);
  if (f.from && f.to) rows.push(['Route', `${f.fromName || fmtCoord(f.from[1], f.from[0])} → ${f.toName || fmtCoord(f.to[1], f.to[0])}`]);
  for (const r of (f.info || []).slice(0, 7)) rows.push(r);
  const lines = [];
  for (const [k, v] of rows) {
    const text = `${k}: ${v}`;
    for (const l of wrap(text, w - 4).slice(0, 2)) lines.push({ k, text: l });
  }
  const h = Math.min(inner.h - 2, lines.length + 4);
  // Place the card away from the cursor: bottom-left unless the cursor is there.
  const cursorLeft = view.hover ? view.hover.x < inner.w / 2 : false;
  const cursorBottom = view.hover ? view.hover.y > inner.h / 2 : false;
  const x = cursorLeft && cursorBottom ? inner.x + inner.w - w - 1 : inner.x + 1;
  const y = cursorBottom && !cursorLeft ? inner.y + 1 : inner.y + inner.h - h - 1;
  const box = rect(x, y, w, h);
  view.overlayBoxes.push(box);
  s.fill(box, ' ', { bg: t.sel });
  s.box(box, { fg: pinned ? t.warn : f.color || t.borderFocus, bg: t.sel }, 'round');
  const title = ` ${f.glyph ? `${f.glyph} ` : ''}${truncate(f.name, w - 8)} `;
  s.text(box.x + 1, box.y, title, { fg: f.color || t.title, bg: t.sel, attr: ATTR.BOLD });
  const sub = `${(f.layerLabel || f.layer || '').toUpperCase()}${pinned ? ' · PINNED' : ''}`;
  s.text(box.x + 2, box.y + 1, truncate(sub, w - 4), { fg: t.dim, bg: t.sel });
  lines.slice(0, h - 4).forEach((l, i) => {
    const y2 = box.y + 2 + i;
    const idx = l.text.indexOf(':');
    if (l.text.startsWith(`${l.k}:`) && idx > 0) {
      s.text(box.x + 2, y2, l.text.slice(0, idx + 1), { fg: t.accent, bg: t.sel });
      s.text(box.x + 2 + idx + 1, y2, l.text.slice(idx + 1), { fg: t.text, bg: t.sel }, w - 4 - idx - 1);
    } else s.text(box.x + 2, y2, l.text, { fg: t.text, bg: t.sel }, w - 4);
  });
  const hint = pinned ? 'Enter details · o link · c unpin' : 'click to pin · Enter details';
  s.text(box.x + 2, box.y + h - 1, truncate(hint, w - 4), { fg: t.muted, bg: t.sel });
  hit(ctx, box, { onClick: () => view.openDetail(f) });
}
