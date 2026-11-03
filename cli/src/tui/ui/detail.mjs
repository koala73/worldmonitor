// Generic "expand this item" support: turn any record the dashboard shows
// into a titled detail spec, and draw that spec as a scrollable overlay.
import { strWidth, truncate, wrap } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { rect } from './layout.mjs';
import { hit, button } from './widgets.mjs';
import { ageOf, enumLabel, fmtNum } from '../data/select.mjs';

const TITLE_KEYS = ['title', 'name', 'primaryTitle', 'headline', 'event', 'question', 'display', 'symbol', 'place', 'disease', 'theater', 'callsign', 'label', 'scenario', 'region', 'country', 'zone', 'sector', 'asnName', 'indicator', 'id'];
const URL_KEYS = ['url', 'link', 'primaryLink', 'sourceUrl', 'href', 'source_url'];
const BODY_KEYS = ['description', 'summary', 'snippet', 'text', 'worldBrief', 'reason', 'note', 'significance', 'whyItMatters', 'riskSummary', 'shortDescription'];
const SKIP_KEYS = new Set(['id', 'uuid', 'hexCode', 'sparkline', 'history', 'coordinates', 'coords', 'points', 'rings', 'geometry', 'path', 'bits', 'memberTitles', 'sources', 'polys', 'line1', 'line2']);
const FIRST_KEYS = ['source', 'sourceName', 'primarySource', 'category', 'categoryTitle', 'type', 'severity', 'status', 'level', 'country', 'countryName', 'region', 'city', 'operator', 'magnitude', 'price', 'change', 'changePercent'];

// Links come from feeds; only http(s) ones are shown or opened.
export const isHttpUrl = (v) => typeof v === 'string' && /^https?:/i.test(v);

const isTs = (k, _v) => /(At|Date|Time|Seen|Updated|Started|Ended|Expires|Onset|Published|pubDate)$/i.test(k) || /^(onset|expires|pubDate|date|timestamp|observedAt)$/i.test(k);

function fmtValue(k, v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') {
    // Dates past ±8.64e15 ms are invalid and toISOString() would throw.
    if (isTs(k, v) && v > 1e11 && v <= 8.64e15) return `${ageOf(v)} ago · ${new Date(v).toISOString().replace('T', ' ').slice(0, 16)}Z`;
    if (Number.isInteger(v) && Math.abs(v) < 1e5) return String(v);
    return fmtNum(v);
  }
  if (typeof v === 'string') {
    if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(v)) return enumLabel(v) || v.toLowerCase();
    if (isTs(k, v) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      const t = Date.parse(v);
      return Number.isFinite(t) ? `${ageOf(t)} ago · ${v.replace('T', ' ').slice(0, 16)}` : v;
    }
    return v;
  }
  if (Array.isArray(v)) {
    if (!v.length) return '';
    if (v.every((x) => typeof x !== 'object')) return v.slice(0, 12).map(String).join(', ') + (v.length > 12 ? ` … (+${v.length - 12})` : '');
    const names = v.map((x) => x && (x.name || x.title || x.label || x.source || x.id)).filter(Boolean);
    return names.length ? `${names.slice(0, 8).join(', ')}${names.length > 8 ? ` … (+${names.length - 8})` : ''}` : `${v.length} items`;
  }
  if (typeof v === 'object') {
    if (Number.isFinite(v.latitude) && Number.isFinite(v.longitude)) return `${v.latitude.toFixed(2)}, ${v.longitude.toFixed(2)}`;
    if (Number.isFinite(v.lat) && Number.isFinite(v.lon)) return `${v.lat.toFixed(2)}, ${v.lon.toFixed(2)}`;
    const parts = Object.entries(v)
      .filter(([, x]) => x !== null && x !== undefined && typeof x !== 'object' && x !== '')
      .slice(0, 6)
      .map(([kk, x]) => `${labelOf(kk)} ${fmtValue(kk, x)}`);
    return parts.join(' · ');
  }
  return String(v);
}

export function labelOf(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(pct|percent)\b/i, '%')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

// Build a detail spec from any plain record.
export function describeItem(item, opts = {}) {
  if (!item || typeof item !== 'object') return { title: String(item ?? ''), rows: [], body: '' };
  const title = opts.title || TITLE_KEYS.map((k) => item[k]).find((v) => typeof v === 'string' && v.trim()) || Object.values(item).find((v) => typeof v === 'string' && v.trim() && v.length < 80) || 'Details';
  const url = [opts.url, ...URL_KEYS.map((k) => item[k])].find(isHttpUrl) || null;
  const bodyParts = [];
  for (const k of BODY_KEYS) if (typeof item[k] === 'string' && item[k].trim() && item[k] !== title) bodyParts.push(item[k].trim());
  const rows = [];
  const used = new Set([...BODY_KEYS, ...URL_KEYS, ...TITLE_KEYS.filter((k) => item[k] === title)]);
  const keys = Object.keys(item).filter((k) => !SKIP_KEYS.has(k) && !used.has(k) && !k.startsWith('_'));
  keys.sort((a, b) => {
    const ia = FIRST_KEYS.indexOf(a);
    const ib = FIRST_KEYS.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const k of keys) {
    const v = fmtValue(k, item[k]);
    if (v === '') continue;
    rows.push([labelOf(k), v.length > 400 ? `${v.slice(0, 400)}…` : v]);
    if (rows.length >= 40) break;
  }
  if (Array.isArray(item.sources) && item.sources.length) {
    const names = item.sources.map((s) => (typeof s === 'string' ? s : s && (s.source || s.name || s.title || s.url))).filter(Boolean);
    if (names.length) rows.push(['Sources', names.slice(0, 10).join(', ')]);
  }
  return { title, subtitle: opts.subtitle || '', color: opts.color || null, rows, body: bodyParts.join('\n\n'), url, ...opts.extra };
}

// Draw the detail overlay. state: { scroll }. Returns the box rect.
export function drawDetail(ctx, full, spec, state) {
  const { s, t } = ctx;
  const w = Math.min(full.w - 4, 92);
  const innerW = w - 4;
  const lines = [];
  for (const [k, v] of spec.rows || []) {
    const wrapped = wrap(`${k}: ${v}`, innerW);
    wrapped.forEach((l, i) => lines.push({ text: l, key: i === 0 ? k : null }));
  }
  if (spec.body) {
    if (lines.length) lines.push({ text: '' });
    for (const para of String(spec.body).split(/\n+/)) {
      for (const l of wrap(para, innerW)) lines.push({ text: l, body: true });
      lines.push({ text: '' });
    }
  }
  if (spec.url) {
    lines.push({ text: '' });
    lines.push({ text: spec.url, link: true });
  }
  const contentH = lines.length;
  const h = Math.min(full.h - 2, contentH + 5);
  const x = full.x + Math.floor((full.w - w) / 2);
  const y = full.y + Math.floor((full.h - h) / 2);
  const box = rect(x, y, w, h);
  const visibleH = h - 5;
  const maxScroll = Math.max(0, contentH - visibleH);
  state.scroll = Math.max(0, Math.min(maxScroll, state.scroll || 0));
  state.maxScroll = maxScroll;
  s.fill(box, ' ', { bg: t.sel, fg: t.text, attr: 0 });
  s.box(box, { fg: spec.color || t.borderFocus, bg: t.sel }, 'double');
  const title = ` ${truncate(spec.title || 'Details', w - 6)} `;
  s.text(x + 2, y, title, { fg: spec.color || t.title, bg: t.sel, attr: ATTR.BOLD });
  if (spec.subtitle) s.text(x + 2, y + 1, truncate(spec.subtitle.toUpperCase(), innerW), { fg: t.dim, bg: t.sel });
  const top = y + 2;
  for (let i = 0; i < visibleH; i++) {
    const line = lines[state.scroll + i];
    if (!line) break;
    const yy = top + i;
    if (line.key) {
      const idx = line.text.indexOf(':');
      s.text(x + 2, yy, line.text.slice(0, idx + 1), { fg: t.accent, bg: t.sel });
      s.text(x + 2 + idx + 1, yy, line.text.slice(idx + 1), { fg: t.text, bg: t.sel }, innerW - idx - 1);
    } else if (line.link) s.text(x + 2, yy, truncate(line.text, innerW), { fg: t.info, bg: t.sel, attr: ATTR.UNDERLINE || 0 });
    else s.text(x + 2, yy, line.text, { fg: line.body ? t.text : t.dim, bg: t.sel }, innerW);
  }
  if (maxScroll > 0) {
    const barH = Math.max(1, Math.round((visibleH / contentH) * visibleH));
    const barY = top + Math.round((state.scroll / maxScroll) * (visibleH - barH));
    for (let i = 0; i < visibleH; i++) s.put(x + w - 2, top + i, i >= barY - top && i < barY - top + barH ? '█' : '│', { fg: i >= barY - top && i < barY - top + barH ? t.accent : t.muted, bg: t.sel });
  }
  const fy = y + h - 2;
  let bx = x + 2;
  const hints = [];
  if (spec.url) {
    bx += button(ctx, bx, fy, 'o OPEN LINK', { onClick: () => state.onOpen && state.onOpen() }) + 1;
  }
  if (spec.onCenter) bx += button(ctx, bx, fy, 'm SHOW ON MAP', { onClick: () => state.onCenter && state.onCenter() }) + 1;
  bx += button(ctx, bx, fy, 'Esc CLOSE', { onClick: () => state.onClose && state.onClose() }) + 1;
  hints.push(maxScroll > 0 ? '↑↓ scroll' : '');
  const hint = hints.filter(Boolean).join(' · ');
  if (hint) s.text(Math.max(bx, x + w - 2 - strWidth(hint)), fy, hint, { fg: t.muted, bg: t.sel });
  hit(ctx, box, { onWheel: (dir) => { state.scroll = Math.max(0, Math.min(maxScroll, (state.scroll || 0) + dir * 3)); } });
  return box;
}
