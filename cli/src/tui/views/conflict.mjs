// Conflict: country instability ranking, UCDP events, unrest signals, theater
// posture, correlation cards and cross-source signals.
import { ATTR } from '../term/screen.mjs';
import { splitH, splitV } from '../ui/layout.mjs';
import { bar, heading, panel, segments } from '../ui/widgets.mjs';
import { severityColor } from '../ui/theme.mjs';
import { ageOf, ciiRanking, enumLabel, trendArrow } from '../data/select.mjs';
import { PaneView, selectedItem } from './base.mjs';

export class ConflictView extends PaneView {
  constructor(app) {
    super(app, { id: 'conflict', label: 'Conflict', paneIds: ['cii', 'ucdp', 'unrest', 'signals'], sources: ['fast', 'slow', 'correlationCards'] });
  }

  signalRows() {
    const cards = this.data.correlationCards || {};
    const rows = [];
    for (const dom of ['military', 'escalation', 'economic', 'disaster']) {
      for (const c of cards[dom] || []) rows.push({ kind: 'card', domain: dom, ...c });
    }
    for (const sg of this.data.crossSourceSignals?.signals || []) rows.push({ kind: 'signal', ...sg });
    return rows;
  }

  selectedUrl() {
    if (this.focusedPane === 'unrest') {
      const e = selectedItem(this.lists.unrest, this.data.unrestEvents?.events || []);
      const src = e?.sources?.[0];
      return src && typeof src === 'object' ? src.url || null : typeof src === 'string' ? src : null;
    }
    return null;
  }

  render(ctx, r) {
    const [left, mid, right] = r.w >= 140 ? splitH(r, ['26%', 'fill', '30%']) : splitH(r, ['32%', 'fill']);
    this.renderCii(ctx, left);
    const [ucdpR, unrestR] = splitV(mid, ['50%', 'fill']);
    this.renderUcdp(ctx, ucdpR);
    this.renderUnrest(ctx, unrestR);
    if (right) {
      const [postureR, signalsR] = splitV(right, [Math.min(9, 3 + (this.data.theaterPosture?.theaters || []).length), 'fill']);
      this.renderPosture(ctx, postureR);
      this.renderSignals(ctx, signalsR);
    }
  }

  renderCii(ctx, r) {
    const { t } = ctx;
    const rows = ciiRanking(this.data, 60);
    const inner = panel(ctx, r, { title: 'Country instability', focused: this.isFocused('cii'), right: 'CII', onClick: () => this.focusPane('cii') });
    this.lists.cii.draw(
      ctx,
      inner,
      rows,
      (c, i, { width }) => {
        const score = Number(c.combinedScore) || 0;
        const color = score >= 70 ? t.bad : score >= 45 ? t.warn : t.good;
        const barW = Math.max(4, width - 14);
        return [
          { text: `${String(i + 1).padStart(2)} `, fg: t.dim },
          { text: `${String(c.region || '').padEnd(3)}`, fg: t.text, attr: ATTR.BOLD },
          { text: ` ${String(Math.round(score)).padStart(3)} `, fg: color },
          { text: bar(score, 100, barW), fg: color },
          { text: ` ${trendArrow(c.trend)}`, fg: t.dim },
        ];
      },
      this.listOpts('cii', { empty: 'loading risk scores…' }),
    );
  }

  renderUcdp(ctx, r) {
    const { t, now } = ctx;
    const events = [...(this.data.ucdpEvents?.events || [])].sort((a, b) => (b.dateStart || 0) - (a.dateStart || 0));
    const inner = panel(ctx, r, { title: 'Armed conflict events', focused: this.isFocused('ucdp'), right: 'UCDP', onClick: () => this.focusPane('ucdp') });
    this.lists.ucdp.draw(
      ctx,
      inner,
      events,
      (e, _i, { width }) => {
        const deaths = Number(e.deathsBest) || 0;
        const type = enumLabel(e.violenceType);
        const sides = `${e.sideA || '?'} vs ${e.sideB || '?'}`;
        const country = String(e.country || '').slice(0, 14).padEnd(14);
        return [
          { text: `${ageOf(e.dateStart, now).padStart(4)} `, fg: t.dim },
          { text: `${country} `, fg: t.text, attr: ATTR.BOLD },
          { text: `${String(deaths).padStart(3)}† `, fg: deaths >= 10 ? t.bad : deaths > 0 ? t.warn : t.dim },
          { text: sides.slice(0, Math.max(8, width - 40)), fg: t.text },
          { text: `  ${type}`, fg: t.accent3 },
        ];
      },
      this.listOpts('ucdp', { empty: 'loading conflict events…' }),
    );
  }

  renderUnrest(ctx, r) {
    const { t, now } = ctx;
    const events = this.data.unrestEvents?.events || [];
    const inner = panel(ctx, r, { title: 'Unrest signals', focused: this.isFocused('unrest'), right: 'GDELT · ACLED', onClick: () => this.focusPane('unrest') });
    this.lists.unrest.draw(
      ctx,
      inner,
      events,
      (e, _i, { width }) => {
        const sev = String(e.severity || '');
        const place = `${e.city ? `${e.city}, ` : ''}${e.country || ''}`.slice(0, 22).padEnd(22);
        return [
          { text: `${ageOf(e.occurredAt, now).padStart(4)} `, fg: t.dim },
          { text: `${sev ? enumLabel(sev).slice(0, 6).padEnd(6) : '      '} `, fg: severityColor(t, sev) },
          { text: `${place} `, fg: t.text, attr: ATTR.BOLD },
          { text: String(e.title || e.summary || '').slice(0, Math.max(8, width - 36)), fg: t.text },
          { text: e.fatalities ? ` ${e.fatalities}†` : '', fg: t.bad },
        ];
      },
      this.listOpts('unrest', { empty: 'loading unrest events…' }),
    );
  }

  renderPosture(ctx, r) {
    const { t } = ctx;
    const theaters = this.data.theaterPosture?.theaters || [];
    const inner = panel(ctx, r, { title: 'Theater posture' });
    theaters.slice(0, inner.h).forEach((p, i) => {
      const level = String(p.postureLevel || 'normal');
      const color = /elevated|high|critical/i.test(level) ? t.bad : /watch|raised/i.test(level) ? t.warn : t.good;
      segments(
        ctx,
        inner.x,
        inner.y + i,
        [
          { text: String(p.theater || '').replace(/-theater$/, '').replace(/-/g, ' ').slice(0, 13).padEnd(14), fg: t.text },
          { text: level.toUpperCase().padEnd(9), fg: color, attr: ATTR.BOLD },
          { text: `✈${String(p.activeFlights ?? 0).padStart(3)} ⚓${String(p.trackedVessels ?? 0).padStart(3)}`, fg: t.dim },
          { text: p.activeOperations?.length ? ` ${p.activeOperations[0]}` : '', fg: t.warn },
        ],
        inner.w,
        { bg: t.panel },
      );
    });
  }

  renderSignals(ctx, r) {
    const { t, now } = ctx;
    const rows = this.signalRows();
    const inner = panel(ctx, r, { title: 'Correlations & signals', focused: this.isFocused('signals'), onClick: () => this.focusPane('signals') });
    this.lists.signals.draw(
      ctx,
      inner,
      rows,
      (x, _i, { width }) => {
        if (x.kind === 'card') {
          const score = Number(x.score) || 0;
          return [
            { text: `${String(x.domain).slice(0, 4).padEnd(4)} `, fg: t.accent3 },
            { text: `${String(Math.round(score)).padStart(3)} `, fg: score >= 70 ? t.bad : score >= 40 ? t.warn : t.good, attr: ATTR.BOLD },
            { text: String(x.title || '').slice(0, Math.max(8, width - 14)), fg: t.text },
            { text: ` ${trendArrow(x.trend)}`, fg: t.dim },
          ];
        }
        return [
          { text: 'xsrc ', fg: t.accent2 },
          { text: `${String(Math.round(Number(x.severityScore) || 0)).padStart(3)} `, fg: severityColor(t, x.severity), attr: ATTR.BOLD },
          { text: `${String(x.theater || '').replace(/-/g, ' ')} `, fg: t.dim },
          { text: String(x.summary || '').slice(0, Math.max(8, width - 26)), fg: t.text },
          { text: ` ${ageOf(x.detectedAt, now)}`, fg: t.dim },
        ];
      },
      this.listOpts('signals', { empty: 'no correlation cards' }),
    );
    void heading;
  }
}
