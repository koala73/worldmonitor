import type { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';

let _client: EconomicServiceClient | null = null;
async function getEconomicClient(): Promise<EconomicServiceClient> {
  if (!_client) {
    const { EconomicServiceClient } = await import('@/generated/client/worldmonitor/economic/v1/service_client');
    const { getRpcBaseUrl } = await import('@/services/rpc-client');
    _client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  }
  return _client;
}

type Tab = 'curve' | 'rates';

const SERIES_IDS = ['DGS1MO', 'DGS3MO', 'DGS6MO', 'DGS1', 'DGS2', 'DGS5', 'DGS10', 'DGS30'] as const;
const TENOR_LABELS = ['1M', '3M', '6M', '1Y', '2Y', '5Y', '10Y', '30Y'];

// ECB tenors that align with the US curve for overlay purposes
const ECB_TENOR_ORDER = ['1Y', '2Y', '5Y', '10Y', '20Y', '30Y'];

const SVG_W = 480;
const SVG_H = 180;
const MARGIN_L = 40;
const MARGIN_R = 20;
const MARGIN_T = 16;
const MARGIN_B = 24;

const CHART_W = SVG_W - MARGIN_L - MARGIN_R;
const CHART_H = SVG_H - MARGIN_T - MARGIN_B;

interface YieldPoint {
  tenor: string;
  value: number | null;
}

interface RateObs {
  date: string;
  value: number;
}

function xPos(index: number, count: number): number {
  if (count <= 1) return MARGIN_L + CHART_W / 2;
  return MARGIN_L + (index / (count - 1)) * CHART_W;
}

function yPos(value: number, yMin: number, yMax: number): number {
  const range = yMax - yMin || 1;
  const scale = (value - yMin) / range;
  return MARGIN_T + CHART_H - scale * CHART_H;
}

function buildPolylinePoints(points: YieldPoint[], yMin: number, yMax: number): string {
  return points
    .map((p, i) => {
      if (p.value === null) return null;
      const x = xPos(i, points.length);
      const y = yPos(p.value, yMin, yMax);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter(Boolean)
    .join(' ');
}

function buildYAxisLabels(yMin: number, yMax: number): string {
  const step = (yMax - yMin) / 3;
  const labels: string[] = [];
  for (let i = 0; i <= 3; i++) {
    const val = yMin + step * i;
    const y = yPos(val, yMin, yMax);
    labels.push(
      `<text x="${(MARGIN_L - 4).toFixed(0)}" y="${y.toFixed(2)}" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="8" alignment-baseline="middle">${val.toFixed(1)}%</text>`
    );
    labels.push(
      `<line x1="${MARGIN_L}" y1="${y.toFixed(2)}" x2="${SVG_W - MARGIN_R}" y2="${y.toFixed(2)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`
    );
  }
  return labels.join('');
}

function buildXAxisLabels(count: number): string {
  return TENOR_LABELS.slice(0, count).map((label, i) => {
    const x = xPos(i, count);
    const y = SVG_H - MARGIN_B + 12;
    return `<text x="${x.toFixed(2)}" y="${y}" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="8">${escapeHtml(label)}</text>`;
  }).join('');
}

function buildCircles(points: YieldPoint[], yMin: number, yMax: number, color: string): string {
  return points.map((p, i) => {
    if (p.value === null) return '';
    const x = xPos(i, points.length);
    const y = yPos(p.value, yMin, yMax);
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="${color}" stroke="rgba(0,0,0,0.4)" stroke-width="1"/>`;
  }).join('');
}

// Map ECB tenor labels to X positions on the US curve axis (8 tenors: 1M 3M 6M 1Y 2Y 5Y 10Y 30Y)
// ECB tenors 1Y 2Y 5Y 10Y map to US indices 3 4 5 6; 20Y is between 10Y and 30Y (idx ~6.5); 30Y = idx 7
function ecbXPos(tenor: string): number | null {
  const mapping: Record<string, number> = {
    '1Y': 3, '2Y': 4, '5Y': 5, '10Y': 6, '20Y': 6.5, '30Y': 7,
  };
  const idx = mapping[tenor];
  if (idx == null) return null;
  return MARGIN_L + (idx / 7) * CHART_W;
}

function buildEcbPolyline(ecbRates: Record<string, number>, yMin: number, yMax: number): string {
  const points = ECB_TENOR_ORDER
    .map((tenor) => {
      const rate = ecbRates[tenor];
      if (rate == null) return null;
      const x = ecbXPos(tenor);
      if (x === null) return null;
      const y = yPos(rate, yMin, yMax);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter(Boolean);
  if (points.length < 2) return '';
  return `<polyline points="${points.join(' ')}" fill="none" stroke="#2ecc71" stroke-width="1.5" stroke-dasharray="5,3" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function buildEcbCircles(ecbRates: Record<string, number>, yMin: number, yMax: number): string {
  return ECB_TENOR_ORDER.map((tenor) => {
    const rate = ecbRates[tenor];
    if (rate == null) return '';
    const x = ecbXPos(tenor);
    if (x === null) return '';
    const y = yPos(rate, yMin, yMax);
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.5" fill="#2ecc71" stroke="rgba(0,0,0,0.4)" stroke-width="1"/>`;
  }).join('');
}

function renderChart(current: YieldPoint[], prior: YieldPoint[], ecbRates: Record<string, number> | null): string {
  const usValues = current.map(p => p.value).filter((v): v is number => v !== null);
  const priorValues = prior.map(p => p.value).filter((v): v is number => v !== null);
  const ecbValues = ecbRates ? Object.values(ecbRates) : [];
  const allValues = [...usValues, ...priorValues, ...ecbValues];
  if (allValues.length === 0) return '<div style="padding:16px;color:var(--text-dim);font-size:12px">No yield data available.</div>';

  const yMin = Math.max(0, Math.min(...allValues) - 0.25);
  const yMax = Math.max(...allValues) + 0.5;

  const curPoints = buildPolylinePoints(current, yMin, yMax);
  const priorPoints = buildPolylinePoints(prior, yMin, yMax);

  const priorLine = priorPoints.length > 0
    ? `<polyline points="${priorPoints}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" stroke-dasharray="4,3" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';

  const ecbLine = ecbRates ? buildEcbPolyline(ecbRates, yMin, yMax) : '';
  const ecbDots = ecbRates ? buildEcbCircles(ecbRates, yMin, yMax) : '';

  return `
    <svg viewBox="0 0 ${SVG_W} ${SVG_H}" width="100%" style="display:block;overflow:visible">
      ${buildYAxisLabels(yMin, yMax)}
      ${buildXAxisLabels(current.length)}
      ${priorLine}
      ${ecbLine}
      <polyline points="${curPoints}" fill="none" stroke="#3498db" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${buildCircles(current, yMin, yMax, '#3498db')}
      ${ecbDots}
    </svg>`;
}

function renderTable(points: YieldPoint[]): string {
  const headers = points.map(p => `<th style="font-size:9px;font-weight:600;color:var(--text-dim);padding:4px 6px;text-align:center">${escapeHtml(p.tenor)}</th>`).join('');
  const cells = points.map(p => {
    const val = p.value !== null ? `${p.value.toFixed(2)}%` : 'N/A';
    return `<td style="font-size:11px;color:var(--text);padding:4px 6px;text-align:center">${escapeHtml(val)}</td>`;
  }).join('');
  return `
    <div style="overflow-x:auto;margin-top:8px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>${headers}</tr></thead>
        <tbody><tr>${cells}</tr></tbody>
      </table>
    </div>`;
}

interface RateRow {
  id: string;
  label: string;
  obs: RateObs[];
  color: string;
}

function miniRateSparkline(obs: RateObs[], color: string, w = 80, h = 22): string {
  const vals = obs.map(o => o.value).filter(v => Number.isFinite(v));
  if (vals.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 0.01;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${w}" height="${h}" style="display:inline-block;vertical-align:middle"><polyline points="${pts}" fill="none" stroke="${escapeHtml(color)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderRatesTab(rows: RateRow[]): string {
  const hasAny = rows.some(r => r.obs.length > 0);
  if (!hasAny) return '<div style="padding:16px;color:var(--text-dim);font-size:12px">ECB rate data unavailable</div>';

  const items = rows.map(row => {
    const latest = row.obs[row.obs.length - 1];
    if (!latest) return '';
    const prev = row.obs[row.obs.length - 2];
    const change = prev ? latest.value - prev.value : null;
    const changeStr = change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '';
    const changeColor = change === null ? '' : change >= 0 ? '#e74c3c' : '#27ae60';
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
      <div style="width:90px;font-size:10px;color:var(--text-dim)">${escapeHtml(row.label)}</div>
      ${miniRateSparkline(row.obs.slice(-24), row.color)}
      <div style="min-width:44px;text-align:right;font-size:13px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums">${escapeHtml(latest.value.toFixed(2))}%</div>
      ${changeStr ? `<div style="font-size:10px;color:${changeColor}">${escapeHtml(changeStr)}</div>` : ''}
      <div style="font-size:9px;color:var(--text-dim);margin-left:auto">${escapeHtml(latest.date)}</div>
    </div>`;
  }).join('');

  return `<div style="padding:4px 0">${items}</div>
    <div style="margin-top:8px;font-size:9px;color:var(--text-dim)">Source: ECB</div>`;
}

export class YieldCurvePanel extends Panel {
  private _hasData = false;
  private _tab: Tab = 'curve';
  private _current: YieldPoint[] = [];
  private _prior: YieldPoint[] = [];
  private _ecbRates: Record<string, number> | null = null;
  private _rateRows: RateRow[] = [];

  constructor() {
    super({ id: 'yield-curve', title: 'Yield Curve & Rates', showCount: false, infoTooltip: t('components.yieldCurve.infoTooltip') });

    this.content.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (btn?.dataset.tab === 'curve' || btn?.dataset.tab === 'rates') {
        this._tab = btn.dataset.tab as Tab;
        this._render();
      }
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const client = await getEconomicClient();
      const [fredResp, ecbResp] = await Promise.allSettled([
        client.getFredSeriesBatch({
          seriesIds: [...SERIES_IDS, 'ESTR', 'EURIBOR3M', 'EURIBOR6M', 'EURIBOR1Y'],
          limit: 36,
        }),
        client.getEuYieldCurve({}),
      ]);

      const results = fredResp.status === 'fulfilled' ? (fredResp.value.results ?? {}) : {};

      this._current = SERIES_IDS.map((id, i) => {
        const obs = results[id]?.observations ?? [];
        return { tenor: TENOR_LABELS[i] ?? id, value: obs.length > 0 ? (obs[obs.length - 1]?.value ?? null) : null };
      });
      this._prior = SERIES_IDS.map((id, i) => {
        const obs = results[id]?.observations ?? [];
        return { tenor: TENOR_LABELS[i] ?? id, value: obs.length > 1 ? (obs[obs.length - 2]?.value ?? null) : null };
      });

      this._ecbRates = ecbResp.status === 'fulfilled' && !ecbResp.value.unavailable && ecbResp.value.data?.rates
        ? (ecbResp.value.data.rates as Record<string, number>)
        : null;

      this._rateRows = [
        { id: 'ESTR', label: '€STR', obs: results['ESTR']?.observations ?? [], color: '#2ecc71' },
        { id: 'EURIBOR3M', label: 'EURIBOR 3M', obs: results['EURIBOR3M']?.observations ?? [], color: '#3498db' },
        { id: 'EURIBOR6M', label: 'EURIBOR 6M', obs: results['EURIBOR6M']?.observations ?? [], color: '#9b59b6' },
        { id: 'EURIBOR1Y', label: 'EURIBOR 1Y', obs: results['EURIBOR1Y']?.observations ?? [], color: '#e67e22' },
      ];

      const validCount = this._current.filter(p => p.value !== null).length;
      if (validCount === 0) {
        if (!this._hasData) this.showError('No yield data available', () => void this.fetchData());
        return false;
      }

      this._hasData = true;
      this._render();
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load yield curve', () => void this.fetchData());
      return false;
    }
  }

  private _render(): void {
    const tabBar = `<div style="display:flex;gap:4px;margin-bottom:6px">
      <button class="panel-tab${this._tab === 'curve' ? ' active' : ''}" data-tab="curve" style="font-size:11px;padding:3px 10px">US Curve</button>
      <button class="panel-tab${this._tab === 'rates' ? ' active' : ''}" data-tab="rates" style="font-size:11px;padding:3px 10px">ECB Rates</button>
    </div>`;

    if (this._tab === 'rates') {
      this.setContent(`<div style="padding:10px 14px 6px">${tabBar}${renderRatesTab(this._rateRows)}</div>`);
      return;
    }

    const y2 = this._current.find(p => p.tenor === '2Y')?.value ?? null;
    const y10 = this._current.find(p => p.tenor === '10Y')?.value ?? null;
    const isInverted = y2 !== null && y10 !== null && y2 > y10;
    const spreadBps = y2 !== null && y10 !== null ? ((y10 - y2) * 100).toFixed(0) : null;
    const spreadSign = spreadBps !== null ? (Number(spreadBps) >= 0 ? '+' : '') : '';

    const statusBadge = isInverted
      ? `<span style="background:#e74c3c;color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;letter-spacing:0.08em">INVERTED</span>`
      : `<span style="background:#2ecc71;color:#000;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;letter-spacing:0.08em">NORMAL</span>`;

    const spreadHtml = spreadBps !== null
      ? `<span style="font-size:11px;color:var(--text-dim);margin-left:10px">2Y-10Y Spread: <span style="color:${isInverted ? '#e74c3c' : '#2ecc71'}">${escapeHtml(spreadSign + spreadBps)}bps</span></span>`
      : '';

    const ecbLegend = this._ecbRates
      ? `<span><svg width="20" height="4" style="vertical-align:middle"><line x1="0" y1="2" x2="20" y2="2" stroke="#2ecc71" stroke-width="1.5" stroke-dasharray="5,3"/></svg> EU (ECB AAA)</span>`
      : '';

    this.setContent(`
      <div style="padding:10px 14px 6px">
        ${tabBar}
        <div style="display:flex;align-items:center;margin-bottom:10px;gap:4px">
          ${statusBadge}${spreadHtml}
        </div>
        <div style="margin:0 -4px">${renderChart(this._current, this._prior, this._ecbRates)}</div>
        ${renderTable(this._current)}
        <div style="margin-top:8px;font-size:9px;color:var(--text-dim);display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span><svg width="20" height="4" style="vertical-align:middle"><line x1="0" y1="2" x2="20" y2="2" stroke="#3498db" stroke-width="2"/></svg> US (Current)</span>
          <span><svg width="20" height="4" style="vertical-align:middle"><line x1="0" y1="2" x2="20" y2="2" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" stroke-dasharray="4,3"/></svg> US (Prior)</span>
          ${ecbLegend}
          <span style="margin-left:auto">Source: FRED / ECB</span>
        </div>
      </div>`);
  }
}
