// Cyber: threat indicators, DDoS mix, traffic anomalies, outages and service status.
import { ATTR } from '../term/screen.mjs';
import { splitH, splitV } from '../ui/layout.mjs';
import { bar, heading, panel, segments } from '../ui/widgets.mjs';
import { severityColor } from '../ui/theme.mjs';
import { ageOf, enumLabel, threatRank } from '../data/select.mjs';
import { PaneView, selectedItem } from './base.mjs';

export class CyberView extends PaneView {
  constructor(app) {
    super(app, { id: 'cyber', label: 'Cyber', paneIds: ['threats', 'services', 'outages'], sources: ['cyberThreats', 'fast'] });
  }

  threats() {
    const list = this.data.cyberThreats?.threats || [];
    return [...list].sort((a, b) => threatRank(b.severity) - threatRank(a.severity) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  }

  outageRows() {
    const rows = [];
    for (const o of this.data.outages?.outages || []) rows.push({ kind: 'outage', ...o });
    for (const a of this.data.trafficAnomalies?.anomalies || []) rows.push({ kind: 'anomaly', ...a });
    return rows;
  }

  selectedUrl() {
    if (this.focusedPane === 'outages') return selectedItem(this.lists.outages, this.outageRows())?.link || null;
    if (this.focusedPane === 'services') return selectedItem(this.lists.services, this.data.serviceStatuses || [])?.url || null;
    return null;
  }

  render(ctx, r) {
    const [left, right] = splitH(r, ['52%', 'fill']);
    this.renderThreats(ctx, left);
    const [ddosR, servicesR, outagesR] = splitV(right, [8, '40%', 'fill']);
    this.renderDdos(ctx, ddosR);
    this.renderServices(ctx, servicesR);
    this.renderOutages(ctx, outagesR);
  }

  renderThreats(ctx, r) {
    const { t, now } = ctx;
    const threats = this.threats();
    const byType = {};
    for (const th of threats) byType[enumLabel(th.type)] = (byType[enumLabel(th.type)] || 0) + 1;
    const summary = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${v} ${k}`)
      .join(' · ');
    const inner = panel(ctx, r, { title: 'Threat indicators', focused: this.isFocused('threats'), right: summary, onClick: () => this.focusPane('threats') });
    this.lists.threats.draw(
      ctx,
      inner,
      threats,
      (th, _i, { width }) => [
        { text: `${enumLabel(th.severity).slice(0, 4).padEnd(4).toUpperCase()} `, fg: severityColor(t, th.severity), attr: ATTR.BOLD },
        { text: `${enumLabel(th.type).slice(0, 11).padEnd(11)} `, fg: t.accent3 },
        { text: `${String(th.indicator || '').slice(0, 24).padEnd(24)} `, fg: t.text },
        { text: `${String(th.country || '').slice(0, 2).padEnd(2)} `, fg: t.dim },
        { text: `${String(th.malwareFamily || (th.tags || [])[0] || '').slice(0, Math.max(0, width - 52))}`, fg: t.warn },
        { text: ` ${ageOf(th.lastSeenAt, now)}`, fg: t.dim },
      ],
      this.listOpts('threats', { empty: 'loading threat feed…' }),
    );
  }

  renderDdos(ctx, r) {
    const { t } = ctx;
    const d = this.data.ddosAttacks;
    const inner = panel(ctx, r, { title: 'DDoS mix (7d)', right: 'Cloudflare Radar' });
    if (!d) return;
    const half = Math.floor(inner.w / 2);
    const draw = (x, items, label) => {
      heading(ctx, x, inner.y, label, half - 1);
      (items || []).slice(0, inner.h - 1).forEach((it, i) => {
        const pct = Number(it.percentage) || 0;
        segments(ctx, x, inner.y + 1 + i, [
          { text: `${String(it.label).slice(0, 9).padEnd(9)} `, fg: t.text },
          { text: bar(pct, 100, Math.max(2, half - 18)), fg: t.accent },
          { text: ` ${pct.toFixed(1)}%`, fg: t.dim },
        ], half - 1, { bg: t.panel });
      });
    };
    draw(inner.x, d.protocol, 'protocol');
    draw(inner.x + half, d.vector, 'vector');
  }

  renderServices(ctx, r) {
    const { t, now } = ctx;
    const services = this.data.serviceStatuses || [];
    const down = services.filter((s) => !/OPERATIONAL$/.test(String(s.status || ''))).length;
    const inner = panel(ctx, r, { title: 'Service status', focused: this.isFocused('services'), right: down ? `${down} degraded` : 'all operational', onClick: () => this.focusPane('services') });
    this.lists.services.draw(
      ctx,
      inner,
      services,
      (s, _i, { width }) => {
        const st = enumLabel(s.status);
        const ok = /^operational$/.test(st);
        return [
          { text: `${ok ? '●' : '▲'} `, fg: ok ? t.good : severityColor(t, st) },
          { text: `${String(s.name || '').slice(0, 16).padEnd(16)} `, fg: t.text, attr: ok ? 0 : ATTR.BOLD },
          { text: `${st.padEnd(16)} `, fg: ok ? t.dim : severityColor(t, st) },
          { text: `${s.latencyMs != null ? `${s.latencyMs}ms` : ''}`.padStart(6), fg: t.dim },
          { text: ` ${ageOf(s.checkedAt, now)}`, fg: t.muted },
        ].slice(0, width > 50 ? 5 : 3);
      },
      this.listOpts('services', { empty: 'loading statuses…' }),
    );
  }

  renderOutages(ctx, r) {
    const { t, now } = ctx;
    const rows = this.outageRows();
    const inner = panel(ctx, r, { title: 'Internet outages & anomalies', focused: this.isFocused('outages'), onClick: () => this.focusPane('outages') });
    this.lists.outages.draw(
      ctx,
      inner,
      rows,
      (o, _i, { width }) => {
        if (o.kind === 'anomaly') {
          return [
            { text: 'anom ', fg: t.accent2 },
            { text: `${String(o.locationName || o.locationCode || '').slice(0, 14).padEnd(14)} `, fg: t.text },
            { text: `${String(o.asnName || o.asn || '').slice(0, Math.max(6, width - 30))}`, fg: t.dim },
            { text: ` ${ageOf(o.startDate, now)}`, fg: t.dim },
          ];
        }
        return [
          { text: `${enumLabel(o.severity).slice(0, 4).padEnd(4)} `, fg: severityColor(t, o.severity) },
          { text: `${String(o.country || o.region || '').slice(0, 14).padEnd(14)} `, fg: t.text, attr: ATTR.BOLD },
          { text: String(o.title || '').slice(0, Math.max(6, width - 30)), fg: t.text },
          { text: ` ${ageOf(o.detectedAt, now)}`, fg: t.dim },
        ];
      },
      this.listOpts('outages', { empty: 'no outages reported' }),
    );
  }
}
