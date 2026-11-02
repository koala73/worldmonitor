// Overview: braille world map with live blips and a radar sweep, the AI world
// brief, top stories, market strip and theater posture.
import { wrap } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { rect, splitH, splitV } from '../ui/layout.mjs';
import { pulse, typewriterCount } from '../ui/fx.mjs';
import { decodeBitmap, heading, kv, label, panel, segments, sparkline, worldMap } from '../ui/widgets.mjs';
import { ageOf, fmtPct, fmtPrice, mapBlips } from '../data/select.mjs';
import { PaneView, selectedItem } from './base.mjs';

// Border plus three story rows.
const MIN_STORIES_H = 5;

export class OverviewView extends PaneView {
  constructor(app) {
    super(app, { id: 'overview', label: 'Overview', paneIds: ['stories', 'markets'], sources: ['fast', 'digest', 'slow'] });
    this.bitmap = decodeBitmap(app.catalog.map);
    this.briefStartedAt = 0;
    this.briefText = '';
  }

  topStories() {
    const ins = this.data.insights || {};
    return Array.isArray(ins.topStories) ? ins.topStories.slice(0, 40) : [];
  }

  marketRows() {
    const q = this.data.marketQuotes?.quotes || [];
    const c = this.data.cryptoQuotes?.quotes || [];
    return [...q.slice(0, 8), ...c.slice(0, 3)];
  }

  selectedUrl() {
    if (this.focusedPane !== 'stories') return null;
    const story = selectedItem(this.lists.stories, this.topStories());
    return story ? story.primaryLink || story.link || null : null;
  }

  hints() {
    return 'Enter expand  o open story';
  }

  render(ctx, r) {
    const { s, t, now } = ctx;
    const wide = r.w >= 110;
    const [left, right] = wide ? splitH(r, ['62%', 'fill']) : splitV(r, ['55%', 'fill']);
    this.renderMap(ctx, left);
    // Stories come first: on short terminals the market strip goes, then the brief.
    const briefH = Math.max(6, Math.min(12, Math.floor(right.h * 0.3)));
    const marketsH = Math.max(5, Math.min(13, this.marketRows().length + 2));
    let room = right.h - MIN_STORIES_H;
    const showMarkets = room >= marketsH;
    if (showMarkets) room -= marketsH;
    const showBrief = room >= briefH;
    const specs = [...(showBrief ? [briefH] : []), 'fill', ...(showMarkets ? [marketsH] : [])];
    const parts = splitV(right, specs);
    if (showBrief) this.renderBrief(ctx, parts.shift());
    this.renderStories(ctx, parts.shift());
    if (showMarkets) this.renderMarkets(ctx, parts.shift());
    void s;
    void now;
  }

  renderMap(ctx, r) {
    const { s, t, now } = ctx;
    const eq = this.data.earthquakes?.earthquakes || [];
    const posture = this.data.theaterPosture?.theaters || [];
    const inner = panel(ctx, r, {
      title: 'Global situation',
      badge: this.app.anim && Math.floor(now / 600) % 2 === 0 ? 'LIVE' : 'LIVE',
      badgeColor: this.app.anim ? (pulse(now, 1200) > 0.5 ? t.accent2 : t.accent) : t.accent,
      right: `${eq.length} quakes · ${(this.data.ucdpEvents?.events || []).length} conflict · ${(this.data.unrestEvents?.events || []).length} unrest`,
      focused: false,
    });
    if (inner.w < 20 || inner.h < 8) return;
    const legendH = 1;
    const postureH = posture.length ? Math.min(posture.length, 3) + 1 : 0;
    const mapR = rect(inner.x, inner.y, inner.w, Math.max(4, inner.h - legendH - postureH));
    const blips = mapBlips(this.data, t);
    const sweepX = this.app.anim ? ((now / 45) % (mapR.w + 20)) - 10 : undefined;
    // pulse the heaviest blips
    const pulsed = blips.map((b, i) => (i >= blips.length - 12 && this.app.anim && pulse(now, 900, i * 0.3) > 0.6 ? { ...b, ch: '◎', bold: true } : b));
    worldMap(ctx, mapR, this.app.catalog.map, this.bitmap, pulsed, { sweepX, grid: true });
    // legend
    const ly = mapR.y + mapR.h;
    const legend = [
      { text: '● ', fg: t.warn },
      { text: 'quake ', fg: t.dim },
      { text: '✕ ', fg: t.bad },
      { text: 'conflict ', fg: t.dim },
      { text: '▲ ', fg: t.accent2 },
      { text: 'unrest ', fg: t.dim },
      { text: '◍ ', fg: t.info },
      { text: 'hazard ', fg: t.dim },
      { text: '* ', fg: t.warn },
      { text: 'fire ', fg: t.dim },
      { text: '¤ ', fg: t.accent3 },
      { text: 'cyber ', fg: t.dim },
      { text: '◌ ', fg: t.dim },
      { text: 'outage', fg: t.dim },
    ];
    segments(ctx, inner.x, ly, legend, inner.w, { bg: t.panel });
    if (postureH) {
      heading(ctx, inner.x, ly + 1, 'theater posture', inner.w);
      posture.slice(0, 3).forEach((p, i) => {
        const level = String(p.postureLevel || 'normal');
        const color = /elevated|high|critical/i.test(level) ? t.bad : /watch|raised/i.test(level) ? t.warn : t.good;
        const name = String(p.theater || '').replace(/-theater$/, '').replace(/-/g, ' ');
        segments(
          ctx,
          inner.x,
          ly + 2 + i,
          [
            { text: `${name.slice(0, 13).padEnd(14)} `, fg: t.text },
            { text: level.toUpperCase().padEnd(10), fg: color, attr: ATTR.BOLD },
            { text: ` ✈ ${p.activeFlights ?? 0}  ⚓ ${p.trackedVessels ?? 0}`, fg: t.dim },
            { text: p.activeOperations?.length ? `  ops: ${p.activeOperations.slice(0, 2).join(', ')}` : '', fg: t.warn },
          ],
          inner.w,
          { bg: t.panel },
        );
      });
    }
    void s;
  }

  renderBrief(ctx, r) {
    const { s, t, now } = ctx;
    const ins = this.data.insights || {};
    const text = String(ins.worldBrief || '');
    if (text && text !== this.briefText) {
      this.briefText = text;
      this.briefStartedAt = now;
    }
    const inner = panel(ctx, r, {
      title: 'AI world brief',
      right: ins.generatedAt ? `${ins.briefModel || ins.briefProvider || 'ai'} · ${ageOf(ins.generatedAt, now)} ago` : '',
      focused: false,
    });
    if (inner.w < 10 || inner.h < 1) return;
    if (!text) {
      label(ctx, inner.x, inner.y, 'waiting for the brief…', { fg: t.dim });
      return;
    }
    const storyLines = Array.isArray(ins.briefStoryLines) ? ins.briefStoryLines : [];
    const full = [text, ...storyLines.map((l) => `${l.n ? `${l.n}. ` : ''}${l.text || ''}`)].join('\n');
    const shown = this.app.anim ? typewriterCount(this.briefStartedAt, now, 6) : Infinity;
    const visible = full.slice(0, shown);
    const paragraphs = visible.split('\n');
    let y = inner.y;
    paragraphs.forEach((para, pi) => {
      const lines = wrap(para, inner.w);
      lines.forEach((line) => {
        if (y >= inner.y + inner.h - 1) return;
        s.text(inner.x, y++, line, { fg: pi === 0 ? t.text : t.dim, bg: t.panel, attr: pi === 0 ? ATTR.BOLD : 0 }, inner.w);
      });
    });
    if (shown < full.length && y <= inner.y + inner.h - 1) s.put(inner.x, Math.min(y, inner.y + inner.h - 1), '▌', { fg: t.accent, bg: t.panel });
    const stats = `${ins.clusterCount || 0} clusters · ${ins.multiSourceCount || 0} multi-source · ${ins.fastMovingCount || 0} fast-moving`;
    s.text(inner.x, inner.y + inner.h - 1, stats, { fg: t.muted, bg: t.panel }, inner.w);
  }

  renderStories(ctx, r) {
    const { t, now } = ctx;
    const stories = this.topStories();
    const inner = panel(ctx, r, { title: 'Top stories', focused: this.isFocused('stories'), right: `${stories.length} ranked`, onClick: () => this.focusPane('stories') });
    this.lists.stories.draw(
      ctx,
      inner,
      stories,
      (st, i, { selected, width }) => {
        const alert = st.isAlert;
        const score = Math.round(st.importanceScore || 0);
        const age = ageOf(st.pubDate || st.publishedAt, now);
        const left = `${String(i + 1).padStart(2)} `;
        const meta = ` ${String(st.sourceCount || 1).padStart(2)}src ${age.padStart(4)}`;
        const titleW = Math.max(8, width - left.length - meta.length - 4);
        const flag = alert ? '⚠ ' : score >= 70 ? '◆ ' : '  ';
        return [
          { text: left, fg: t.dim },
          { text: flag, fg: alert ? t.bad : t.accent },
          { text: (st.primaryTitle || st.title || '').slice(0, titleW).padEnd(titleW), fg: selected ? t.selText : alert ? t.text : t.text, attr: alert ? ATTR.BOLD : 0 },
          { text: meta, fg: t.dim },
        ];
      },
      this.listOpts('stories', { empty: 'ranking stories…' }),
    );
  }

  renderMarkets(ctx, r) {
    const { t } = ctx;
    const rows = this.marketRows();
    const inner = panel(ctx, r, { title: 'Markets', focused: this.isFocused('markets'), onClick: () => this.focusPane('markets') });
    this.lists.markets.draw(
      ctx,
      inner,
      rows,
      (q, _i, { width }) => {
        const ch = Number(q.change) || 0;
        const color = ch > 0 ? t.good : ch < 0 ? t.bad : t.dim;
        const name = (q.display || q.symbol || '').padEnd(7).slice(0, 7);
        const price = fmtPrice(q.price).padStart(10);
        const pct = fmtPct(ch).padStart(8);
        const sparkW = Math.max(0, width - 7 - 10 - 8 - 4);
        return [
          { text: `${name} `, fg: t.text, attr: ATTR.BOLD },
          { text: price, fg: t.text },
          { text: pct, fg: color },
          { text: `  ${sparkline(q.sparkline, sparkW)}`, fg: color },
        ];
      },
      this.listOpts('markets', { empty: 'loading quotes…' }),
    );
  }
}

export function fmtKv(ctx, inner, y, k, v) {
  kv(ctx, inner.x, y, k, v, inner.w);
}
