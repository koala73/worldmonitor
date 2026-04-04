import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GetFaoFoodPriceIndexResponse, FaoFoodPricePoint } from '@/generated/client/worldmonitor/economic/v1/service_client';

const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

const SVG_W = 480;
const SVG_H = 140;
const ML = 36;
const MR = 12;
const MT = 8;
const MB = 20;
const CW = SVG_W - ML - MR;
const CH = SVG_H - MT - MB;

const SERIES: { key: keyof FaoFoodPricePoint; color: string; label: string }[] = [
  { key: 'ffpi',    color: '#f5a623', label: 'Food' },
  { key: 'cereals', color: '#7ed321', label: 'Cereals' },
  { key: 'meat',    color: '#e86c6c', label: 'Meat' },
  { key: 'dairy',   color: '#74c8e8', label: 'Dairy' },
  { key: 'oils',    color: '#b57ce8', label: 'Oils' },
  { key: 'sugar',   color: '#f0c36a', label: 'Sugar' },
];

function xPos(i: number, total: number): number {
  if (total <= 1) return ML + CW / 2;
  return ML + (i / (total - 1)) * CW;
}

function yPos(v: number, yMin: number, yMax: number): number {
  const range = yMax - yMin || 1;
  return MT + CH - ((v - yMin) / range) * CH;
}

function buildLine(points: FaoFoodPricePoint[], key: keyof FaoFoodPricePoint, yMin: number, yMax: number): string {
  const coords = points
    .map((p, i) => {
      const v = p[key] as number;
      if (!Number.isFinite(v) || v <= 0) return null;
      return `${xPos(i, points.length).toFixed(1)},${yPos(v, yMin, yMax).toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');
  return coords;
}

function buildChart(points: FaoFoodPricePoint[]): string {
  if (!points.length) return '';

  // Collect all values to compute y range
  const vals: number[] = [];
  for (const p of points) {
    for (const s of SERIES) {
      const v = p[s.key] as number;
      if (Number.isFinite(v) && v > 0) vals.push(v);
    }
  }
  const yMin = Math.floor(Math.min(...vals) * 0.96);
  const yMax = Math.ceil(Math.max(...vals) * 1.02);

  // Y-axis labels (4 ticks: bottom, 1/3, 2/3, top)
  const yAxis = [0, 1, 2, 3].map(i => {
    const v = yMin + ((yMax - yMin) / 3) * i;
    const y = yPos(v, yMin, yMax);
    return `
      <line x1="${ML}" y1="${y.toFixed(1)}" x2="${SVG_W - MR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
      <text x="${(ML - 3).toFixed(0)}" y="${y.toFixed(1)}" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="8" dominant-baseline="middle">${v.toFixed(0)}</text>`;
  }).join('');

  // X-axis labels (show every 3rd month to avoid crowding)
  const xAxis = points.map((p, i) => {
    if (i % 3 !== 0 && i !== points.length - 1) return '';
    const x = xPos(i, points.length);
    const label = p.date;
    return `<text x="${x.toFixed(1)}" y="${SVG_H - MB + 12}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="7">${escapeHtml(label)}</text>`;
  }).join('');

  // Series lines
  const lines = SERIES.map(s => {
    const coords = buildLine(points, s.key, yMin, yMax);
    if (!coords) return '';
    return `<polyline points="${coords}" fill="none" stroke="${s.color}" stroke-width="${s.key === 'ffpi' ? 2 : 1.2}" opacity="${s.key === 'ffpi' ? 1 : 0.7}"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">${yAxis}${xAxis}${lines}</svg>`;
}

function buildLegend(): string {
  return SERIES.map(s =>
    `<span class="fao-legend-item"><span class="fao-legend-dot" style="background:${s.color}"></span>${escapeHtml(t(`components.faoFoodPriceIndex.${s.key}`))}</span>`
  ).join('');
}

export class FaoFoodPriceIndexPanel extends Panel {
  constructor() {
    super({ id: 'fao-food-price-index', title: t('panels.faoFoodPriceIndex'), infoTooltip: t('components.faoFoodPriceIndex.infoTooltip') });
  }

  public async fetchData(): Promise<void> {
    try {
      const hydrated = getHydratedData('faoFoodPriceIndex') as GetFaoFoodPriceIndexResponse | undefined;
      if (hydrated?.points?.length) {
        if (!this.element?.isConnected) return;
        this.renderChart(hydrated);
        void client.getFaoFoodPriceIndex({}).then(data => {
          if (!this.element?.isConnected || !data.points?.length) return;
          this.renderChart(data);
        }).catch(() => {});
        return;
      }
      const data = await client.getFaoFoodPriceIndex({});
      if (!this.element?.isConnected) return;
      this.renderChart(data);
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
    }
  }

  private renderChart(data: GetFaoFoodPriceIndexResponse): void {
    if (!data.points?.length) {
      this.showError(t('common.failedMarketData'), () => void this.fetchData());
      return;
    }

    const momSign = data.momPct >= 0 ? '+' : '';
    const yoySign = data.yoyPct >= 0 ? '+' : '';
    const momCls = data.momPct >= 0 ? 'fao-up' : 'fao-down';
    const yoyCls = data.yoyPct >= 0 ? 'fao-up' : 'fao-down';
    const latest = data.points[data.points.length - 1];

    const headline = `
      <div class="fao-headline">
        <div class="fao-headline-primary">
          <span class="fao-index-value">${data.currentFfpi.toFixed(1)}</span>
          <span class="fao-index-label">${escapeHtml(t('components.faoFoodPriceIndex.indexLabel'))}</span>
        </div>
        <div class="fao-headline-changes">
          <span class="fao-change ${momCls}">${momSign}${data.momPct.toFixed(1)}% ${escapeHtml(t('components.faoFoodPriceIndex.mom'))}</span>
          <span class="fao-change ${yoyCls}">${yoySign}${data.yoyPct.toFixed(1)}% ${escapeHtml(t('components.faoFoodPriceIndex.yoy'))}</span>
        </div>
        <div class="fao-as-of">${escapeHtml(t('components.faoFoodPriceIndex.asOf'))} ${escapeHtml(latest?.date ?? '')}</div>
      </div>`;

    const chart = buildChart(data.points);
    const legend = `<div class="fao-legend">${buildLegend()}</div>`;
    const base = `<div class="fao-base-note">${escapeHtml(t('components.faoFoodPriceIndex.baseNote'))}</div>`;

    this.setContent(`<div class="fao-food-price-index-panel">${headline}${chart}${legend}${base}</div>`);
  }
}
