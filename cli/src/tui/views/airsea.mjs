// Air & Sea: live military flights on the map, airport delays, chokepoints,
// vessel density and shipping stress.
import { ATTR } from '../term/screen.mjs';
import { rect, splitH, splitV } from '../ui/layout.mjs';
import { decodeBitmap, heading, panel, segments, sparkline, worldMap } from '../ui/widgets.mjs';
import { severityColor } from '../ui/theme.mjs';
import { ageOf, enumLabel, flightBlips, fmtInt, fmtPct } from '../data/select.mjs';
import { PaneView } from './base.mjs';

export class AirSeaView extends PaneView {
  constructor(app) {
    super(app, { id: 'airsea', label: 'Air & Sea', paneIds: ['flights', 'delays', 'choke'], sources: ['flights', 'vessels', 'flightDelays', 'fast', 'slow'] });
    this.bitmap = decodeBitmap(app.catalog.map);
  }

  // Highest first: the list and the map marker must index the same order.
  flights() {
    return [...(this.store.raw.flights?.flights || [])].sort((a, b) => (b.altitude || 0) - (a.altitude || 0));
  }

  render(ctx, r) {
    const [top, bottom] = splitV(r, [Math.max(10, Math.floor(r.h * 0.42)), 'fill']);
    this.renderMap(ctx, top);
    const [flightsR, delaysR, chokeR] = r.w >= 130 ? splitH(bottom, ['40%', '32%', 'fill']) : splitH(bottom, ['50%', 'fill']);
    this.renderFlights(ctx, flightsR);
    this.renderDelays(ctx, delaysR);
    if (chokeR) this.renderChoke(ctx, chokeR);
    else this.renderChoke(ctx, rect(0, 0, 0, 0));
  }

  renderMap(ctx, r) {
    const { t, now } = ctx;
    const flights = this.flights();
    const vessels = this.store.raw.vessels?.snapshot;
    const meta = this.store.meta.flights;
    const inner = panel(ctx, r, {
      title: 'Air & sea picture',
      right: meta.error ? `flights: ${meta.error}` : `${flights.length} military aircraft · ${vessels?.densityZones?.length || 0} density zones · ${(this.data.chokepoints?.chokepoints || []).length} chokepoints`,
      badge: meta.loading ? 'SYNC' : null,
    });
    if (inner.w < 20 || inner.h < 5) return;
    const blips = [];
    for (const z of vessels?.densityZones || []) {
      const k = Number(z.intensity) || 0;
      blips.push({ lat: z.location?.latitude, lon: z.location?.longitude, ch: k > 0.8 ? '▓' : k > 0.5 ? '▒' : '░', fg: t.info, weight: k });
    }
    for (const c of this.data.chokepoints?.chokepoints || []) {
      const score = Number(c.disruptionScore) || 0;
      blips.push({ lat: c.lat, lon: c.lon, ch: '⚓', fg: score >= 50 ? t.bad : score >= 20 ? t.warn : t.good, weight: 2, bold: true });
    }
    blips.push(...flightBlips(this.store.raw.flights, t));
    const sel = flights[this.lists.flights.selected];
    if (sel && this.isFocused('flights')) blips.push({ lat: sel.location?.latitude, lon: sel.location?.longitude, ch: '◎', fg: t.accent2, weight: 9, bold: true });
    const sweepX = this.app.anim ? ((now / 60) % (inner.w + 20)) - 10 : undefined;
    worldMap(ctx, inner, this.app.catalog.map, this.bitmap, blips, { sweepX, grid: true });
  }

  renderFlights(ctx, r) {
    const { t, now } = ctx;
    const flights = this.flights();
    const inner = panel(ctx, r, { title: 'Military flights', focused: this.isFocused('flights'), right: 'ADS-B', onClick: () => this.focusPane('flights') });
    const meta = this.store.meta.flights;
    this.lists.flights.draw(
      ctx,
      inner,
      flights,
      (f, _i, { width }) => {
        const op = enumLabel(f.operator).replace(/^other$/, '') || f.operatorCountry || '';
        const type = enumLabel(f.aircraftType).replace(/^unknown$/, '') || f.aircraftModel || '';
        return [
          { text: `${String(f.callsign || f.hexCode || '').padEnd(8)} `, fg: t.accent, attr: ATTR.BOLD },
          { text: `${String(op).slice(0, 10).padEnd(10)} `, fg: t.text },
          { text: `${fmtInt(f.altitude).padStart(6)}ft `, fg: t.dim },
          { text: `${String(Math.round(f.speed || 0)).padStart(3)}kt `, fg: t.dim },
          { text: `${String(Math.round(f.heading || 0)).padStart(3)}° `, fg: t.dim },
          { text: `${type}`.slice(0, Math.max(0, width - 44)), fg: t.accent3 },
        ];
      },
      this.listOpts('flights', { empty: meta.loading ? 'tracking aircraft…' : meta.error ? `unavailable: ${meta.error}` : 'no aircraft in view' }),
    );
    void now;
  }

  renderDelays(ctx, r) {
    const { t } = ctx;
    const alerts = [...(this.data.flightDelays?.alerts || [])].sort((a, b) => (b.avgDelayMinutes || 0) - (a.avgDelayMinutes || 0));
    const inner = panel(ctx, r, { title: 'Airport delays', focused: this.isFocused('delays'), right: 'FAA · Eurocontrol', onClick: () => this.focusPane('delays') });
    this.lists.delays.draw(
      ctx,
      inner,
      alerts,
      (a, _i, { width }) => [
        { text: `${String(a.iata || '').padEnd(4)}`, fg: t.accent, attr: ATTR.BOLD },
        { text: `${String(a.city || a.name || '').slice(0, 14).padEnd(14)} `, fg: t.text },
        { text: `${String(a.avgDelayMinutes ?? 0).padStart(3)}m `, fg: severityColor(t, a.severity) },
        { text: `${a.delayedFlightsPct != null ? `${a.delayedFlightsPct}% ` : ''}`, fg: t.dim },
        { text: `${a.cancelledFlights ? `${a.cancelledFlights} cxl ` : ''}`, fg: t.bad },
        { text: enumLabel(a.delayType).slice(0, Math.max(0, width - 34)), fg: t.dim },
      ],
      this.listOpts('delays', { empty: 'no delay alerts' }),
    );
  }

  renderChoke(ctx, r) {
    const { t } = ctx;
    if (r.w === 0) return;
    const chokes = this.data.chokepoints?.chokepoints || [];
    const stress = this.data.shippingStress;
    const rates = this.data.shippingRates?.indices || [];
    const [chokeR, shipR] = splitV(r, ['55%', 'fill']);
    const inner = panel(ctx, chokeR, { title: 'Chokepoints', focused: this.isFocused('choke'), onClick: () => this.focusPane('choke') });
    this.lists.choke.draw(
      ctx,
      inner,
      chokes,
      (c, _i, { width }) => {
        const score = Number(c.disruptionScore) || 0;
        return [
          { text: `${String(c.name || '').slice(0, 16).padEnd(16)} `, fg: t.text, attr: ATTR.BOLD },
          { text: `${String(score).padStart(3)} `, fg: score >= 50 ? t.bad : score >= 20 ? t.warn : t.good },
          { text: `${String(c.status || '').slice(0, 10).padEnd(10)} `, fg: severityColor(t, c.status) },
          { text: `${c.activeWarnings ? `${c.activeWarnings} warn ` : ''}${c.congestionLevel ? `${c.congestionLevel}` : ''}`.slice(0, Math.max(0, width - 32)), fg: t.dim },
        ];
      },
      this.listOpts('choke', { empty: 'loading chokepoints…' }),
    );
    const inner2 = panel(ctx, shipR, { title: 'Shipping', right: stress ? `stress ${stress.stressScore} ${stress.stressLevel}` : '' });
    let y = inner2.y;
    for (const c of stress?.carriers || []) {
      if (y >= inner2.y + inner2.h) break;
      const ch = Number(c.changePct) || 0;
      segments(ctx, inner2.x, y++, [
        { text: `${String(c.symbol || '').padEnd(6)}`, fg: t.accent },
        { text: `${String(c.name || '').slice(0, 14).padEnd(14)} `, fg: t.text },
        { text: fmtPct(ch).padStart(7), fg: ch > 0 ? t.good : ch < 0 ? t.bad : t.dim },
        { text: ` ${sparkline(c.sparkline, Math.max(0, inner2.w - 30))}`, fg: ch >= 0 ? t.good : t.bad },
      ], inner2.w, { bg: t.panel });
    }
    if (rates.length && y < inner2.y + inner2.h) heading(ctx, inner2.x, y++, 'freight indices', inner2.w);
    for (const idx of rates) {
      if (y >= inner2.y + inner2.h) break;
      const ch = Number(idx.changePct) || 0;
      segments(ctx, inner2.x, y++, [
        { text: `${String(idx.name || '').slice(0, 26).padEnd(26)} `, fg: t.text },
        { text: `${fmtInt(idx.currentValue).padStart(8)} `, fg: t.text },
        { text: fmtPct(ch).padStart(7), fg: ch > 0 ? t.bad : ch < 0 ? t.good : t.dim },
        { text: idx.spikeAlert ? ' SPIKE' : '', fg: t.bad, attr: ATTR.BOLD },
      ], inner2.w, { bg: t.panel });
    }
    void ageOf;
  }
}
