// Climate & disasters: earthquakes, hazards, weather alerts, anomalies and planet vitals.
import { ATTR } from '../term/screen.mjs';
import { splitH, splitV } from '../ui/layout.mjs';
import { heading, kv, panel, segments, sparkline } from '../ui/widgets.mjs';
import { severityColor } from '../ui/theme.mjs';
import { ageOf, fmtNum } from '../data/select.mjs';
import { PaneView, selectedItem } from './base.mjs';

export class ClimateView extends PaneView {
  constructor(app) {
    super(app, { id: 'climate', label: 'Climate', paneIds: ['quakes', 'hazards', 'weather', 'anomalies'], sources: ['fast', 'slow'] });
  }

  quakes() {
    return [...(this.data.earthquakes?.earthquakes || [])].sort((a, b) => (b.occurredAt || 0) - (a.occurredAt || 0));
  }

  hazards() {
    const rows = [];
    for (const e of this.data.naturalEvents?.events || []) rows.push({ kind: 'event', title: e.title, sub: e.categoryTitle || e.category, at: e.date, mag: e.magnitude ? `${e.magnitude}${e.magnitudeUnit || ''}` : '', url: e.sourceUrl, severity: e.closed ? 'closed' : 'active' });
    for (const d of this.data.climateDisasters?.disasters || []) rows.push({ kind: 'disaster', title: d.name, sub: `${d.type}${d.country ? ` · ${d.country}` : ''}`, at: d.startedAt, mag: d.affectedPopulation ? `${fmtNum(d.affectedPopulation, 0)} ppl` : '', url: d.sourceUrl, severity: d.severity });
    for (const o of (this.data.diseaseOutbreaks?.outbreaks || []).slice(0, 40)) rows.push({ kind: 'disease', title: `${o.disease} — ${o.location}`, sub: o.sourceName, at: o.publishedAt, mag: o.cases ? `${fmtNum(o.cases, 0)} cases` : '', url: o.sourceUrl, severity: o.alertLevel });
    return rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  selectedUrl() {
    if (this.focusedPane === 'quakes') return selectedItem(this.lists.quakes, this.quakes())?.sourceUrl || null;
    if (this.focusedPane === 'hazards') return selectedItem(this.lists.hazards, this.hazards())?.url || null;
    return null;
  }

  render(ctx, r) {
    const [left, mid, right] = r.w >= 140 ? splitH(r, ['30%', 'fill', '30%']) : splitH(r, ['40%', 'fill']);
    const [quakesR, vitalsR] = splitV(left, ['fill', 11]);
    this.renderQuakes(ctx, quakesR);
    this.renderVitals(ctx, vitalsR);
    if (right) {
      this.renderHazards(ctx, mid);
      const [weatherR, anomR] = splitV(right, ['55%', 'fill']);
      this.renderWeather(ctx, weatherR);
      this.renderAnomalies(ctx, anomR);
    } else {
      const [hazR, weatherR] = splitV(mid, ['50%', 'fill']);
      this.renderHazards(ctx, hazR);
      this.renderWeather(ctx, weatherR);
    }
  }

  renderQuakes(ctx, r) {
    const { t, now } = ctx;
    const quakes = this.quakes();
    const big = quakes.filter((q) => (q.magnitude || 0) >= 5).length;
    const inner = panel(ctx, r, { title: 'Earthquakes', focused: this.isFocused('quakes'), right: `${big} ≥ M5`, onClick: () => this.focusPane('quakes') });
    this.lists.quakes.draw(
      ctx,
      inner,
      quakes,
      (q, _i, { width }) => {
        const m = Number(q.magnitude) || 0;
        const color = m >= 6 ? t.bad : m >= 5 ? t.warn : m >= 4 ? t.text : t.dim;
        return [
          { text: `M${m.toFixed(1)} `, fg: color, attr: m >= 5 ? ATTR.BOLD : 0 },
          { text: `${String(q.place || '').slice(0, Math.max(8, width - 18))}`, fg: t.text },
          { text: ` ${String(Math.round(q.depthKm || 0)).padStart(3)}km`, fg: t.dim },
          { text: ` ${ageOf(q.occurredAt, now).padStart(4)}`, fg: t.dim },
        ];
      },
      this.listOpts('quakes', { empty: 'loading USGS feed…' }),
    );
  }

  renderVitals(ctx, r) {
    const { t } = ctx;
    const co2 = this.data.co2Monitoring?.monitoring;
    const ice = this.data.oceanIce;
    const fires = this.data.wildfires?.fireDetections || [];
    const inner = panel(ctx, r, { title: 'Planet vitals' });
    let y = inner.y;
    const w = inner.w;
    if (co2) {
      kv(ctx, inner.x, y++, 'CO₂', `${co2.currentPpm} ppm  (+${co2.annualGrowthRate}/yr)`, w, { fg: t.warn });
      kv(ctx, inner.x, y++, 'CH₄ / N₂O', `${co2.methanePpb} ppb / ${co2.nitrousOxidePpb} ppb`, w);
      if (Array.isArray(co2.trend12m) && co2.trend12m.length) segments(ctx, inner.x, y++, [{ text: '12m trend ', fg: t.dim }, { text: sparkline(co2.trend12m.map((p) => (typeof p === 'number' ? p : p.ppm ?? p.value)), Math.max(4, w - 10)), fg: t.warn }], w, { bg: t.panel });
    }
    if (ice) {
      kv(ctx, inner.x, y++, 'Arctic ice', `${ice.arctic_extent_mkm2} Mkm² (${ice.arctic_extent_anomaly_mkm2 > 0 ? '+' : ''}${ice.arctic_extent_anomaly_mkm2})`, w, { fg: ice.arctic_extent_anomaly_mkm2 < 0 ? t.bad : t.good });
      kv(ctx, inner.x, y++, 'Sea level', `+${ice.sea_level_mm_above_1993} mm vs 1993 (${ice.sea_level_annual_rise_mm}/yr)`, w);
      kv(ctx, inner.x, y++, 'SST anomaly', `${ice.sst_anomaly_c > 0 ? '+' : ''}${ice.sst_anomaly_c} °C`, w, { fg: t.warn });
    }
    if (fires.length) {
      const frp = fires.reduce((a, f) => a + (Number(f.frp) || 0), 0);
      kv(ctx, inner.x, y++, 'Fire detections', `${fires.length}${this.data.wildfires?.pagination?.totalCount ? ` of ${fmtNum(this.data.wildfires.pagination.totalCount, 0)}` : ''} · FRP ${fmtNum(frp, 0)} MW`, w, { fg: t.warn });
    }
    const rad = this.data.radiationWatch;
    if (rad && y < inner.y + inner.h) kv(ctx, inner.x, y++, 'Radiation', `${rad.anomalyCount || 0} anomalies · ${rad.elevatedCount || 0} elevated`, w, { fg: rad.anomalyCount ? t.warn : t.good });
  }

  renderHazards(ctx, r) {
    const { t, now } = ctx;
    const rows = this.hazards();
    const inner = panel(ctx, r, { title: 'Hazards & outbreaks', focused: this.isFocused('hazards'), right: 'GDACS · NHC · WHO', onClick: () => this.focusPane('hazards') });
    this.lists.hazards.draw(
      ctx,
      inner,
      rows,
      (h, _i, { width }) => [
        { text: `${h.kind === 'disease' ? '☣' : h.kind === 'disaster' ? '◍' : '◈'} `, fg: h.kind === 'disease' ? t.accent3 : severityColor(t, h.severity) },
        { text: `${String(h.title || '').slice(0, Math.max(10, width - 30))}`, fg: t.text, attr: ATTR.BOLD },
        { text: ` ${String(h.mag || '')}`, fg: t.warn },
        { text: ` ${String(h.sub || '').slice(0, 14)}`, fg: t.dim },
        { text: ` ${ageOf(h.at, now)}`, fg: t.dim },
      ],
      this.listOpts('hazards', { empty: 'no hazards' }),
    );
  }

  renderWeather(ctx, r) {
    const { t } = ctx;
    const alerts = [...(this.data.weatherAlerts?.alerts || []), ...(this.data.canadaAlerts?.alerts || []).map((a) => ({ ...a, headline: a.headline || a.event, countryCode: 'CA' }))];
    const inner = panel(ctx, r, { title: 'Weather alerts', focused: this.isFocused('weather'), right: `${alerts.length}`, onClick: () => this.focusPane('weather') });
    this.lists.weather.draw(
      ctx,
      inner,
      alerts,
      (a, _i, { width }) => [
        { text: `${String(a.severity || '').slice(0, 8).padEnd(8)} `, fg: severityColor(t, a.severity), attr: ATTR.BOLD },
        { text: `${String(a.countryCode || '').padEnd(2)} `, fg: t.dim },
        { text: `${String(a.event || '').slice(0, 22).padEnd(22)} `, fg: t.text },
        { text: String(a.areaDesc || a.headline || '').slice(0, Math.max(0, width - 36)), fg: t.dim },
      ],
      this.listOpts('weather', { empty: 'no active alerts' }),
    );
  }

  renderAnomalies(ctx, r) {
    const { t } = ctx;
    const rows = this.data.climateAnomalies?.anomalies || [];
    const inner = panel(ctx, r, { title: 'Climate anomalies', focused: this.isFocused('anomalies'), onClick: () => this.focusPane('anomalies') });
    this.lists.anomalies.draw(
      ctx,
      inner,
      rows,
      (a, _i, { width }) => {
        const dt = Number(a.tempDelta) || 0;
        return [
          { text: `${String(a.zone || '').slice(0, 18).padEnd(18)} `, fg: t.text },
          { text: `${dt > 0 ? '+' : ''}${dt.toFixed(1)}°C `, fg: Math.abs(dt) >= 3 ? t.bad : Math.abs(dt) >= 1.5 ? t.warn : t.text },
          { text: `${a.precipDelta != null ? `${a.precipDelta > 0 ? '+' : ''}${Number(a.precipDelta).toFixed(0)}% rain ` : ''}`, fg: t.info },
          { text: `${String(a.severity || '')} ${String(a.type || '')}`.slice(0, Math.max(0, width - 36)), fg: severityColor(t, a.severity) },
        ];
      },
      this.listOpts('anomalies', { empty: 'no anomalies' }),
    );
    void heading;
  }
}
