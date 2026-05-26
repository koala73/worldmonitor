import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { toApiUrl } from '@/services/runtime';

// SVG chart constants
const SVG_W = 400;
const CHART_H = 150;
const BAR_H_MAX = 280;
const ML = 42;
const MR = 10;
const MT = 10;
const MB = 22;
const CW = SVG_W - ML - MR;
const CH = CHART_H - MT - MB;

interface CrudeWeek { period: string; stocksMb: number; weeklyChangeMb?: number }
interface SprWeek { period: string; stocksMb: number }
interface SprData { latestStocksMb: number; changeWow: number; weeks: SprWeek[] }
interface NatGasWeek { period: string; storBcf: number; weeklyChangeBcf?: number }
interface EuGasDay { date: string; fillPct: number }
interface EuGasData { fillPct: number; fillPctChange1d: number; trend: string; history: EuGasDay[] }
interface IeaMember { iso2: string; daysOfCover?: number; netExporter: boolean; belowObligation: boolean }
interface RegionStats { avgDays?: number; minDays?: number; countBelowObligation?: number }
interface IeaData { dataMonth: string; members: IeaMember[]; europe?: RegionStats; asiaPacific?: RegionStats; northAmerica?: RegionStats }
interface RefineryData { inputsMbpd: number; period: string }
interface OilInventoriesData {
  crudeWeeks: CrudeWeek[];
  spr?: SprData;
  natGasWeeks: NatGasWeek[];
  euGas?: EuGasData;
  ieaStocks?: IeaData;
  refinery?: RefineryData;
}

interface MergedWeek { period: string; crudeMb: number | null; sprMb: number | null }

function mergeByPeriod(crude: CrudeWeek[], spr: SprWeek[]): MergedWeek[] {
  const crudeMap = new Map(crude.map(w => [w.period, w.stocksMb]));
  const sprMap = new Map(spr.map(w => [w.period, w.stocksMb]));
  const allPeriods = [...new Set([...crudeMap.keys(), ...sprMap.keys()])].sort();
  return allPeriods.map(p => ({ period: p, crudeMb: crudeMap.get(p) ?? null, sprMb: sprMap.get(p) ?? null }));
}

function fmtDate(period: string): string { return period.slice(5); }
function fmtNum(n: number, d = 1): string { return n.toFixed(d); }

function buildYAxis(minVal: number, maxVal: number, unit: string, steps = 4): string {
  const range = maxVal - minVal || 1;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const v = minVal + (i / steps) * range;
    const y = MT + CH - (i / steps) * CH;
    return `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${SVG_W - MR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
      <text x="${ML - 4}" y="${y.toFixed(1)}" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="7" dominant-baseline="middle">${escapeHtml(fmtNum(v, 0))}${escapeHtml(unit)}</text>`;
  }).join('');
}

function buildXAxis(labels: string[], total: number): string {
  const step = Math.max(1, Math.floor(total / 5));
  return labels.map((lbl, i) => {
    if (i % step !== 0 && i !== total - 1) return '';
    const x = ML + (i / Math.max(1, total - 1)) * CW;
    return `<text x="${x.toFixed(1)}" y="${CHART_H - 2}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="7">${escapeHtml(lbl)}</text>`;
  }).join('');
}

function areaPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 2) return '';
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const linePts = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L');
  return `M${first.x.toFixed(1)},${first.y.toFixed(1)} L${linePts} L${last.x.toFixed(1)},${MT + CH} L${first.x.toFixed(1)},${MT + CH} Z`;
}

function buildStackedCrudeSprChart(merged: MergedWeek[]): string {
  // Only chart weeks where BOTH series have data (stacking null as 0 produces
  // fake collapses). Weeks with partial data are skipped, preserving gap semantics.
  const complete = merged.filter(w => w.crudeMb != null && w.sprMb != null);
  if (complete.length < 2) {
    // Fall back to crude-only if SPR is entirely absent
    const crudeOnly = merged.filter(w => w.crudeMb != null);
    if (crudeOnly.length < 2) return '<div style="text-align:center;color:var(--text-dim);padding:16px;font-size:11px">Insufficient data for chart</div>';
    return buildCrudeOnlyChart(crudeOnly);
  }

  const vals = complete.map(w => w.crudeMb! + w.sprMb!);
  const maxV = Math.max(...vals) * 1.05;
  const minV = Math.min(...complete.map(w => w.sprMb!)) * 0.95;
  const range = maxV - minV || 1;
  const toY = (v: number) => MT + CH - ((v - minV) / range) * CH;
  const toX = (i: number) => ML + (i / Math.max(1, complete.length - 1)) * CW;

  // SPR area (bottom layer)
  const sprPts = complete.map((w, i) => ({ x: toX(i), y: toY(w.sprMb!) }));
  const sprArea = `<path d="${areaPath(sprPts)}" fill="#f59e0b" opacity="0.25"/>`;
  const sprLine = `<polyline points="${sprPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#f59e0b" stroke-width="1.5" opacity="0.8"/>`;

  // Crude area (top layer, from sprMb to sprMb+crudeMb)
  const totalPts = complete.map((w, i) => ({ x: toX(i), y: toY(w.crudeMb! + w.sprMb!) }));
  const crudeArea = `<path d="M${totalPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')} L${sprPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).reverse().join(' L')} Z" fill="#3b82f6" opacity="0.2"/>`;
  const totalLine = `<polyline points="${totalPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#3b82f6" stroke-width="1.5" opacity="0.9"/>`;

  const yAxis = buildYAxis(minV, maxV, '');
  const xAxis = buildXAxis(complete.map(w => fmtDate(w.period)), complete.length);

  return `<svg viewBox="0 0 ${SVG_W} ${CHART_H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">${yAxis}${xAxis}${sprArea}${sprLine}${crudeArea}${totalLine}</svg>`;
}

function buildCrudeOnlyChart(weeks: MergedWeek[]): string {
  const data = weeks.map(w => ({ x: w.period, y: w.crudeMb! }));
  return buildLineChart(data, '#3b82f6', '');
}

function buildLineChart(data: Array<{ x: string; y: number }>, color: string, unit: string, h = CHART_H): string {
  if (data.length < 2) return '<div style="text-align:center;color:var(--text-dim);padding:12px;font-size:11px">Insufficient data</div>';
  const ch = h - MT - MB;
  const vals = data.map(d => d.y);
  const maxV = Math.max(...vals) * 1.02;
  const minV = Math.min(...vals) * 0.98;
  const range = maxV - minV || 1;
  const pts = data.map((d, i) => ({
    x: ML + (i / Math.max(1, data.length - 1)) * CW,
    y: MT + ch - ((d.y - minV) / range) * ch,
  }));
  const line = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = areaPath(pts);
  const yAxis = Array.from({ length: 4 }, (_, i) => {
    const v = minV + (i / 3) * range;
    const y = MT + ch - (i / 3) * ch;
    return `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${SVG_W - MR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
      <text x="${ML - 4}" y="${y.toFixed(1)}" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="7" dominant-baseline="middle">${escapeHtml(fmtNum(v, 0))}${escapeHtml(unit)}</text>`;
  }).join('');
  const xAxis = buildXAxis(data.map(d => d.x.slice(5)), data.length);
  return `<svg viewBox="0 0 ${SVG_W} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">${yAxis}${xAxis}<path d="${area}" fill="${color}" opacity="0.12"/><polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.9"/></svg>`;
}

function buildIeaBarChart(members: IeaMember[]): string {
  const sorted = [...members]
    .filter(m => m.daysOfCover != null || m.netExporter)
    .sort((a, b) => {
      if (a.netExporter && !b.netExporter) return 1;
      if (!a.netExporter && b.netExporter) return -1;
      return (a.daysOfCover ?? 999) - (b.daysOfCover ?? 999);
    })
    .slice(0, 20);
  if (!sorted.length) return '<div style="text-align:center;color:var(--text-dim);padding:12px;font-size:11px">No IEA data</div>';
  const maxDays = Math.max(200, ...sorted.filter(m => m.daysOfCover != null).map(m => m.daysOfCover!));
  const barH = Math.min(14, (BAR_H_MAX - 20) / sorted.length);
  const plotW = SVG_W - ML - 10;
  const svgH = 15 + sorted.length * barH + 5;
  const bars = sorted.map((m, i) => {
    const d = m.daysOfCover ?? 0;
    const barW = Math.max(0, (d / maxDays) * plotW);
    const y = 15 + i * barH;
    const color = m.netExporter ? '#6b7280' : m.belowObligation ? '#ef4444' : '#22c55e';
    const label = m.netExporter ? 'Exp' : d > 0 ? `${d.toFixed(0)}d` : 'N/A';
    return `<rect x="${ML}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(barH - 2).toFixed(1)}" fill="${color}" opacity="0.6" rx="1"/>
      <text x="${ML - 3}" y="${(y + barH / 2).toFixed(1)}" text-anchor="end" fill="rgba(255,255,255,0.5)" font-size="7" dominant-baseline="middle">${escapeHtml(m.iso2)}</text>
      <text x="${(ML + barW + 3).toFixed(1)}" y="${(y + barH / 2).toFixed(1)}" fill="rgba(255,255,255,0.6)" font-size="7" dominant-baseline="middle">${escapeHtml(label)}</text>`;
  }).join('');
  const obligX = ML + (90 / maxDays) * plotW;
  const obligLine = `<line x1="${obligX.toFixed(1)}" y1="10" x2="${obligX.toFixed(1)}" y2="${svgH - 5}" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-dasharray="4 3"/>
    <text x="${obligX.toFixed(1)}" y="9" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="7">90d</text>`;
  return `<svg viewBox="0 0 ${SVG_W} ${svgH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">${bars}${obligLine}</svg>`;
}

function section(title: string, content: string, meta = ''): string {
  return `<div class="energy-tape-section" style="margin-top:8px">
    <div class="energy-section-title">${escapeHtml(title)}</div>
    <div style="border-radius:6px;background:rgba(255,255,255,0.02);padding:4px 0">${content}</div>
    ${meta ? `<div style="margin-top:3px;font-size:10px;color:var(--text-dim)">${meta}</div>` : ''}
  </div>`;
}

function changeBadge(val: number | undefined, unit: string): string {
  if (val == null) return '';
  const sign = val >= 0 ? '+' : '';
  const cls = val >= 0 ? 'change-positive' : 'change-negative';
  return `<span class="commodity-change ${cls}">${escapeHtml(sign + fmtNum(val))} ${escapeHtml(unit)}</span>`;
}

export class OilInventoriesPanel extends Panel {
  constructor() {
    super({
      id: 'oil-inventories',
      title: t('panels.oilInventories'),
      showCount: false,
      infoTooltip: t('components.oilInventories.infoTooltip'),
      defaultRowSpan: 2,
    });
  }

  public async fetchData(): Promise<void> {
    try {
      const resp = await fetch(toApiUrl('/api/economic/v1/get-oil-inventories'));
      if (!resp.ok) { this.showError('Oil inventory data unavailable', () => void this.fetchData(), 300); return; }
      const data = (await resp.json()) as OilInventoriesData;
      if (!this.element?.isConnected) return;
      this.render(data);
    } catch {
      if (!this.element?.isConnected) return;
      this.showError('Oil inventory data unavailable', () => void this.fetchData(), 300);
    }
  }

  private render(d: OilInventoriesData): void {
    const parts: string[] = [];

    // Section 1: Crude + SPR stacked
    if (d.crudeWeeks?.length || d.spr?.weeks?.length) {
      const merged = mergeByPeriod(
        [...(d.crudeWeeks ?? [])].reverse(),
        [...(d.spr?.weeks ?? [])].reverse(),
      );
      const chart = buildStackedCrudeSprChart(merged);
      // Total from latest week where BOTH series have data (same-date snapshot)
      const latestComplete = [...merged].reverse().find(w => w.crudeMb != null && w.sprMb != null);
      const latestCrude = d.crudeWeeks?.[0];
      const latestSpr = d.spr;
      const meta: string[] = [];
      if (latestComplete) {
        meta.push(`Total: ${escapeHtml(fmtNum(latestComplete.crudeMb! + latestComplete.sprMb!))} Mb (${escapeHtml(latestComplete.period)})`);
      }
      if (latestCrude) meta.push(`Commercial: ${escapeHtml(fmtNum(latestCrude.stocksMb))} ${changeBadge(latestCrude.weeklyChangeMb, 'WoW')}`);
      if (latestSpr) meta.push(`SPR: ${escapeHtml(fmtNum(latestSpr.latestStocksMb))} ${changeBadge(latestSpr.changeWow, 'WoW')}`);
      parts.push(section('US Total Oil Stocks', chart, meta.join(' | ')));
    }

    // Section 2: Nat Gas
    if (d.natGasWeeks?.length) {
      const reversed = [...d.natGasWeeks].reverse();
      const chartData = reversed.map(w => ({ x: w.period, y: w.storBcf }));
      const chart = buildLineChart(chartData, '#22c55e', '', 120);
      const latest = d.natGasWeeks[0];
      const meta = latest
        ? `Storage: ${escapeHtml(fmtNum(latest.storBcf, 0))} Bcf ${changeBadge(latest.weeklyChangeBcf, 'WoW')}`
        : '';
      parts.push(section('US Nat Gas Working Storage', chart, meta));
    }

    // Section 3: EU Gas
    if (d.euGas && d.euGas.history?.length) {
      const reversed = [...d.euGas.history].reverse();
      const chartData = reversed.map(h => ({ x: h.date, y: h.fillPct }));
      const chart = buildLineChart(chartData, '#14b8a6', '%', 100);
      const sign = d.euGas.fillPctChange1d >= 0 ? '+' : '';
      const meta = `Fill: ${escapeHtml(fmtNum(d.euGas.fillPct))}% | Trend: ${escapeHtml(d.euGas.trend)} | ${escapeHtml(sign + fmtNum(d.euGas.fillPctChange1d, 2))}%/d`;
      parts.push(section('EU Gas Storage Fill', chart, meta));
    }

    // Section 4: IEA OECD
    if (d.ieaStocks?.members?.length) {
      const chart = buildIeaBarChart(d.ieaStocks.members);
      const reg = [
        d.ieaStocks.europe?.avgDays != null ? `Europe avg ${d.ieaStocks.europe.avgDays.toFixed(0)}d` : '',
        d.ieaStocks.asiaPacific?.avgDays != null ? `AsiaPac avg ${d.ieaStocks.asiaPacific.avgDays.toFixed(0)}d` : '',
      ].filter(Boolean).join(' | ');
      const below = d.ieaStocks.members.filter(m => m.belowObligation).length;
      const meta = `${reg}${below > 0 ? ` | <span style="color:#ef4444">${below} below 90d</span>` : ''} | Data: ${escapeHtml(d.ieaStocks.dataMonth)}`;
      parts.push(section('IEA OECD Oil Stocks (Days of Cover)', chart, meta));
    }

    // Section 5: Refinery
    if (d.refinery) {
      const meta = `US Refinery Crude Inputs: <span class="commodity-price">${escapeHtml(fmtNum(d.refinery.inputsMbpd))} Mb/d</span> (${escapeHtml(d.refinery.period)})`;
      parts.push(section('Refinery Throughput', `<div style="padding:4px 8px;font-size:12px">${meta}</div>`, ''));
    }

    if (parts.length === 0) {
      this.showError('Oil inventory data unavailable', () => void this.fetchData(), 300);
      return;
    }

    const legend = `<div style="display:flex;gap:12px;font-size:9px;color:var(--text-dim);margin-top:2px">
      <span><svg width="14" height="4" style="vertical-align:middle"><line x1="0" y1="2" x2="14" y2="2" stroke="#3b82f6" stroke-width="2"/></svg> Commercial</span>
      <span><svg width="14" height="4" style="vertical-align:middle"><line x1="0" y1="2" x2="14" y2="2" stroke="#f59e0b" stroke-width="2"/></svg> SPR</span>
    </div>`;

    this.setContent(`<div class="energy-complex-content">${parts[0]}${legend}${parts.slice(1).join('')}
      <div class="indicator-date" style="margin-top:6px">Source: EIA, IEA, GIE AGSI+</div>
    </div>`);
  }
}
