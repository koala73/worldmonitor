// Predictions: prediction markets by domain and scenario forecasts with detail.
import { wrap } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { splitH, splitV } from '../ui/layout.mjs';
import { bar, heading, kv, label, panel, segments } from '../ui/widgets.mjs';
import { ageOf, fmtNum } from '../data/select.mjs';
import { PaneView, selectedItem } from './base.mjs';

export class PredictionsView extends PaneView {
  constructor(app) {
    super(app, { id: 'predict', label: 'Predict', paneIds: ['markets', 'forecasts'], sources: ['fast', 'forecasts'] });
  }

  marketRows() {
    const p = this.data.predictions || {};
    const rows = [];
    for (const dom of ['geopolitical', 'finance', 'tech']) {
      const list = p[dom] || [];
      if (!list.length) continue;
      rows.push({ header: dom });
      rows.push(...list.map((m) => ({ ...m, domain: dom })));
    }
    return rows;
  }

  forecasts() {
    return [...(this.data.forecasts?.predictions || [])].sort((a, b) => (b.probability || 0) - (a.probability || 0));
  }

  selectedUrl() {
    if (this.focusedPane === 'markets') return selectedItem(this.lists.markets, this.marketRows())?.url || null;
    return null;
  }

  render(ctx, r) {
    const [left, right] = splitH(r, ['52%', 'fill']);
    this.renderMarkets(ctx, left);
    const [listR, detailR] = splitV(right, ['45%', 'fill']);
    this.renderForecasts(ctx, listR);
    this.renderDetail(ctx, detailR);
  }

  renderMarkets(ctx, r) {
    const { t } = ctx;
    const rows = this.marketRows();
    const inner = panel(ctx, r, { title: 'Prediction markets', focused: this.isFocused('markets'), right: 'Polymarket', onClick: () => this.focusPane('markets') });
    this.lists.markets.draw(
      ctx,
      inner,
      rows,
      (m, _i, { width, selected }) => {
        if (m.header) return [{ text: ` ${m.header.toUpperCase()}`, fg: t.accent, attr: ATTR.BOLD }];
        const yes = Number(m.yesPrice) || 0;
        const color = yes >= 66 ? t.good : yes <= 33 ? t.bad : t.warn;
        const barW = 10;
        const titleW = Math.max(10, width - barW - 6 - 12 - 3);
        return [
          { text: `${String(Math.round(yes)).padStart(3)}% `, fg: color, attr: ATTR.BOLD },
          { text: bar(yes, 100, barW), fg: color },
          { text: ` ${String(m.title || '').slice(0, titleW).padEnd(titleW)}`, fg: selected ? t.selText : t.text },
          { text: ` ${m.volume ? `$${fmtNum(m.volume, 0)}` : ''}`.padStart(10), fg: t.dim },
        ];
      },
      this.listOpts('markets', { empty: 'loading markets…' }),
    );
  }

  renderForecasts(ctx, r) {
    const { t } = ctx;
    const rows = this.forecasts();
    const inner = panel(ctx, r, { title: 'Scenario forecasts', focused: this.isFocused('forecasts'), right: 'WorldMonitor AI', onClick: () => this.focusPane('forecasts') });
    this.lists.forecasts.draw(
      ctx,
      inner,
      rows,
      (f, _i, { width }) => {
        const p = Math.round((Number(f.probability) || 0) * 100);
        return [
          { text: `${String(p).padStart(3)}% `, fg: p >= 60 ? t.bad : p >= 35 ? t.warn : t.good, attr: ATTR.BOLD },
          { text: `${String(f.domain || '').slice(0, 8).padEnd(8)} `, fg: t.accent3 },
          { text: String(f.title || '').slice(0, Math.max(8, width - 16)), fg: t.text },
        ];
      },
      this.listOpts('forecasts', { empty: 'loading forecasts…' }),
    );
  }

  renderDetail(ctx, r) {
    const { s, t, now } = ctx;
    const f = selectedItem(this.lists.forecasts, this.forecasts());
    const inner = panel(ctx, r, { title: 'Scenario', kind: 'round' });
    if (!f) {
      label(ctx, inner.x, inner.y, 'select a forecast', { fg: t.dim });
      return;
    }
    let y = inner.y;
    for (const line of wrap(f.title || '', inner.w).slice(0, 2)) s.text(inner.x, y++, line, { fg: t.text, bg: t.panel, attr: ATTR.BOLD }, inner.w);
    const pct = Math.round((Number(f.probability) || 0) * 100);
    const prior = f.priorProbability != null ? Math.round(Number(f.priorProbability) * 100) : null;
    segments(ctx, inner.x, y++, [
      { text: `${pct}% `, fg: pct >= 60 ? t.bad : pct >= 35 ? t.warn : t.good, attr: ATTR.BOLD },
      { text: bar(pct, 100, Math.min(30, inner.w - 20)), fg: pct >= 60 ? t.bad : pct >= 35 ? t.warn : t.good },
      { text: prior != null ? `  prior ${prior}%` : '', fg: t.dim },
      { text: f.confidence != null ? `  conf ${Math.round(Number(f.confidence) * 100)}%` : '', fg: t.dim },
    ], inner.w, { bg: t.panel });
    kv(ctx, inner.x, y++, 'region / horizon', `${f.region || '—'}${f.horizonDays ? ` · ${f.horizonDays}d` : ''}`, Math.min(inner.w, 44));
    kv(ctx, inner.x, y++, 'generated', `${f.generationOrigin || ''} ${ageOf(f.createdAt, now)} ago`, Math.min(inner.w, 44));
    y++;
    const text = f.scenario || f.feedSummary || f.feedSummaryShort || '';
    if (text && y < inner.y + inner.h) {
      heading(ctx, inner.x, y++, 'scenario', inner.w);
      for (const line of wrap(text, inner.w)) {
        if (y >= inner.y + inner.h) break;
        s.text(inner.x, y++, line, { fg: t.text, bg: t.panel }, inner.w);
      }
    }
    const casc = Array.isArray(f.cascades) ? f.cascades : [];
    if (casc.length && y < inner.y + inner.h - 1) {
      heading(ctx, inner.x, y++, 'cascades', inner.w);
      for (const c of casc.slice(0, inner.y + inner.h - y)) {
        const txt = typeof c === 'string' ? c : c.title || c.effect || c.description || JSON.stringify(c);
        s.text(inner.x, y++, `› ${txt}`, { fg: t.dim, bg: t.panel }, inner.w);
      }
    }
  }
}
