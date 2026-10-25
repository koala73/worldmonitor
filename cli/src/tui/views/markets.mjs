// Markets: indices and commodities with sparklines, crypto, sector heatmap,
// and a macro strip (signals verdict, fear & greed, ETF flows, stablecoins).
import { mix } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { rect, splitH, splitV } from '../ui/layout.mjs';
import { gauge, heading, kv, label, panel, segments, sparkline } from '../ui/widgets.mjs';
import { fmtNum, fmtPct, fmtPrice, quoteGroups } from '../data/select.mjs';
import { PaneView } from './base.mjs';

export class MarketsView extends PaneView {
  constructor(app) {
    super(app, { id: 'markets', label: 'Markets', paneIds: ['quotes', 'crypto'], sources: ['fast', 'slow'] });
  }

  quoteRows() {
    const g = quoteGroups(this.data);
    const rows = [];
    if (g.indices.length) rows.push({ header: 'Equities & indices' }, ...g.indices);
    if (g.commodities.length) rows.push({ header: 'Commodities, FX & rates' }, ...g.commodities);
    return rows;
  }

  cryptoRows() {
    const g = quoteGroups(this.data);
    const rows = [...g.crypto];
    if (g.defi.length) rows.push({ header: 'DeFi' }, ...g.defi);
    if (g.ai.length) rows.push({ header: 'AI tokens' }, ...g.ai);
    if (g.other.length) rows.push({ header: 'Other' }, ...g.other);
    return rows;
  }

  render(ctx, r) {
    const wide = r.w >= 130;
    const [left, right] = splitH(r, [wide ? '46%' : '55%', 'fill']);
    const [quotesR] = [left];
    const [cryptoR, bottom] = splitV(right, ['52%', 'fill']);
    const [sectorsR, macroR] = wide ? splitH(bottom, ['50%', 'fill']) : splitV(bottom, ['50%', 'fill']);
    this.renderQuotes(ctx, quotesR, 'quotes', 'Markets', this.quoteRows());
    this.renderQuotes(ctx, cryptoR, 'crypto', 'Crypto', this.cryptoRows(), { changeKey: 'change24h' });
    this.renderSectors(ctx, sectorsR);
    this.renderMacro(ctx, macroR);
  }

  renderQuotes(ctx, r, pane, title, rows, opts = {}) {
    const { t } = ctx;
    const inner = panel(ctx, r, { title, focused: this.isFocused(pane), right: `${rows.filter((x) => !x.header).length} quotes`, onClick: () => this.focusPane(pane) });
    this.lists[pane].draw(
      ctx,
      inner,
      rows,
      (q, _i, { width, selected }) => {
        if (q.header) return [{ text: ` ${q.header.toUpperCase()}`, fg: t.accent, attr: ATTR.BOLD }];
        const ch = Number(q.change ?? q[opts.changeKey || 'change']) || 0;
        const color = ch > 0 ? t.good : ch < 0 ? t.bad : t.dim;
        const nameW = Math.min(16, Math.max(8, Math.floor(width * 0.22)));
        const name = String(q.display || q.symbol || q.name || '').slice(0, nameW).padEnd(nameW);
        const sub = q.name && q.name !== q.display && width > 70 ? String(q.name).slice(0, 14).padEnd(14) : '';
        const price = fmtPrice(q.price).padStart(11);
        const pct = fmtPct(ch).padStart(8);
        const used = nameW + 1 + sub.length + 11 + 8 + 2;
        const sparkW = Math.max(0, width - used - 1);
        const spark = q.sparkline ? sparkline(q.sparkline, sparkW) : q.change7d != null ? ` 7d ${fmtPct(q.change7d)}` : '';
        return [
          { text: `${name} `, fg: selected ? t.selText : t.text, attr: ATTR.BOLD },
          { text: sub, fg: t.dim },
          { text: price, fg: t.text },
          { text: pct, fg: color },
          { text: `  ${spark}`, fg: q.sparkline ? color : t.dim },
        ];
      },
      this.listOpts(pane, { empty: 'loading quotes…' }),
    );
  }

  renderSectors(ctx, r) {
    const { s, t } = ctx;
    const sectors = this.data.sectors?.sectors || [];
    const inner = panel(ctx, r, { title: 'Sector heatmap' });
    if (!sectors.length) {
      label(ctx, inner.x, inner.y, 'loading sectors…', { fg: t.dim });
      return;
    }
    const cols = Math.max(1, Math.min(4, Math.floor(inner.w / 13)));
    const tileW = Math.floor(inner.w / cols);
    const tileH = Math.max(1, Math.min(3, Math.floor(inner.h / Math.ceil(sectors.length / cols))));
    const maxAbs = Math.max(0.5, ...sectors.map((x) => Math.abs(Number(x.change) || 0)));
    sectors.forEach((sec, i) => {
      const ch = Number(sec.change) || 0;
      const k = Math.min(1, Math.abs(ch) / maxAbs);
      const bg = mix(t.panel, ch >= 0 ? t.good : t.bad, 0.15 + k * 0.55);
      const x = inner.x + (i % cols) * tileW;
      const y = inner.y + Math.floor(i / cols) * tileH;
      if (y + tileH > inner.y + inner.h) return;
      s.fill(rect(x, y, tileW - 1, tileH), ' ', { bg });
      s.text(x + 1, y, String(sec.symbol || sec.name).slice(0, tileW - 2), { fg: '#ffffff', bg, attr: ATTR.BOLD });
      const pct = fmtPct(ch, 1);
      if (tileH > 1) s.text(x + tileW - 2 - pct.length, y + 1, pct, { fg: '#ffffff', bg });
      else s.text(x + tileW - 2 - pct.length, y, pct, { fg: '#ffffff', bg });
    });
  }

  renderMacro(ctx, r) {
    const { s, t } = ctx;
    const inner = panel(ctx, r, { title: 'Macro & flows' });
    const m = this.data.macroSignals;
    const fg = this.data.fearGreedIndex;
    const etf = this.data.etfFlows;
    const st = this.data.stablecoinMarkets;
    const es = this.data.economicStress;
    let y = inner.y;
    const line = (segs) => {
      if (y < inner.y + inner.h) segments(ctx, inner.x, y++, segs, inner.w, { bg: t.panel });
    };
    if (m) {
      const verdictColor = /BUY/i.test(m.verdict) ? t.good : /SELL/i.test(m.verdict) ? t.bad : t.warn;
      line([
        { text: 'macro verdict ', fg: t.dim },
        { text: String(m.verdict || '—'), fg: verdictColor, attr: ATTR.BOLD },
        { text: `  ${m.bullishCount ?? 0}/${m.totalCount ?? 0} bullish`, fg: t.dim },
      ]);
      const sig = Object.entries(m.signals || {}).slice(0, 8);
      let segs = [];
      let used = 0;
      for (const [k, v] of sig) {
        const status = String((v && (v.status || v.signal || v.label)) || '—');
        const bull = /normal|bull|positive|risk.?on|expan|uptrend|green/i.test(status);
        const bear = /bear|negative|risk.?off|stress|contract|downtrend|red|gap/i.test(status);
        const label = k.replace(/([A-Z])/g, ' $1').toLowerCase();
        const piece = `${label} ${status.toLowerCase()}`;
        if (used + piece.length + 3 > inner.w) {
          line(segs);
          segs = [];
          used = 0;
        }
        segs.push({ text: `${bull ? '▲' : bear ? '▼' : '■'} `, fg: bull ? t.good : bear ? t.bad : t.warn });
        segs.push({ text: `${label} `, fg: t.dim });
        segs.push({ text: `${status.toLowerCase()}  `, fg: t.text });
        used += piece.length + 4;
      }
      if (segs.length) line(segs);
    }
    if (fg?.composite) {
      const score = Number(fg.composite.score) || 0;
      line([{ text: 'fear & greed  ', fg: t.dim }, { text: `${Math.round(score)} ${fg.composite.label || ''}`, fg: score < 40 ? t.bad : score > 60 ? t.good : t.warn, attr: ATTR.BOLD }]);
      if (y < inner.y + inner.h) gauge(ctx, inner.x, y++, Math.min(inner.w, 40), score / 100, { fg: score < 40 ? t.bad : score > 60 ? t.good : t.warn });
    }
    if (etf?.summary) {
      const sum = etf.summary;
      line([
        { text: 'ETF flows     ', fg: t.dim },
        { text: `${String(sum.netDirection || '').toUpperCase()} `, fg: /in/i.test(sum.netDirection) ? t.good : t.bad, attr: ATTR.BOLD },
        { text: `est ${fmtNum(sum.totalEstFlow)} · ${sum.inflowCount ?? 0} in / ${sum.outflowCount ?? 0} out`, fg: t.text },
      ]);
    }
    if (st?.summary) {
      line([
        { text: 'stablecoins   ', fg: t.dim },
        { text: `${fmtNum(st.summary.totalMarketCap)} cap · ${st.summary.depeggedCount || 0} depegged · ${st.summary.healthStatus || ''}`, fg: st.summary.depeggedCount ? t.warn : t.text },
      ]);
    }
    if (es) {
      line([{ text: 'econ stress   ', fg: t.dim }, { text: `${es.compositeScore} ${es.label || ''}`, fg: /low/i.test(es.label) ? t.good : /high/i.test(es.label) ? t.bad : t.warn, attr: ATTR.BOLD }]);
    }
    const gulf = this.data.gulfQuotes?.quotes || [];
    if (gulf.length && y < inner.y + inner.h - 1) {
      heading(ctx, inner.x, y++, 'gulf markets', inner.w);
      const perRow = Math.max(1, Math.floor(inner.w / 24));
      gulf.slice(0, perRow * Math.max(0, inner.y + inner.h - y)).forEach((q, i) => {
        const ch = Number(q.change) || 0;
        const x = inner.x + (i % perRow) * 24;
        const yy = y + Math.floor(i / perRow);
        if (yy >= inner.y + inner.h) return;
        segments(ctx, x, yy, [{ text: `${String(q.name || q.symbol).slice(0, 12).padEnd(12)} `, fg: t.text }, { text: fmtPct(ch).padStart(7), fg: ch > 0 ? t.good : ch < 0 ? t.bad : t.dim }], 23, { bg: t.panel });
      });
    }
    void s;
    void kv;
  }
}
