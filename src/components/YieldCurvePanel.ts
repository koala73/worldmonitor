import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';

const SERIES_IDS = ['DGS1MO', 'DGS3MO', 'DGS6MO', 'DGS1', 'DGS2', 'DGS5', 'DGS10', 'DGS30'] as const;
const TENOR_LABELS = ['1M', '3M', '6M', '1Y', '2Y', '5Y', '10Y', '30Y'];

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

function buildCircles(points: YieldPoint[], yMin: number, yMax: number): string {
  return points.map((p, i) => {
    if (p.value === null) return '';
    const x = xPos(i, points.length);
    const y = yPos(p.value, yMin, yMax);
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="#3498db" stroke="rgba(0,0,0,0.4)" stroke-width="1"/>`;
  }).join('');
}

function renderChart(current: YieldPoint[], prior: YieldPoint[]): string {
  const validValues = current.map(p => p.value).filter((v): v is number => v !== null);
  if (validValues.length === 0) return '<div style="padding:16px;color:var(--text-dim);font-size:12px">No yield data available.</div>';

  const yMin = Math.max(0, Math.min(...validValues) - 0.25);
  const yMax = Math.max(...validValues) + 0.5;

  const curPoints = buildPolylinePoints(current, yMin, yMax);
  const priorPoints = buildPolylinePoints(prior, yMin, yMax);

  const priorLine = priorPoints.length > 0
    ? `<polyline points="${priorPoints}" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" stroke-dasharray="4,3" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';

  return `
    <svg viewBox="0 0 ${SVG_W} ${SVG_H}" width="100%" style="display:block;overflow:visible">
      ${buildYAxisLabels(yMin, yMax)}
      ${buildXAxisLabels(current.length)}
      ${priorLine}
      <polyline points="${curPoints}" fill="none" stroke="#3498db" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${buildCircles(current, yMin, yMax)}
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

export class YieldCurvePanel extends Panel {
  private _hasData = false;

  constructor() {
    super({ id: 'yield-curve', title: 'US Treasury Yield Curve', showCount: false });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const { EconomicServiceClient } = await import('@/generated/client/worldmonitor/economic/v1/service_client');
      const { getRpcBaseUrl } = await import('@/services/rpc-client');
      const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
      const resp = await client.getFredSeriesBatch({ seriesIds: [...SERIES_IDS], limit: 2 });

      const results = resp.results ?? {};
      const current: YieldPoint[] = SERIES_IDS.map((id, i) => {
        const obs = results[id]?.observations ?? [];
        return { tenor: TENOR_LABELS[i] ?? id, value: obs.length > 0 ? (obs[obs.length - 1]?.value ?? null) : null };
      });
      const prior: YieldPoint[] = SERIES_IDS.map((id, i) => {
        const obs = results[id]?.observations ?? [];
        return { tenor: TENOR_LABELS[i] ?? id, value: obs.length > 1 ? (obs[obs.length - 2]?.value ?? null) : null };
      });

      const validCount = current.filter(p => p.value !== null).length;
      if (validCount === 0) {
        if (!this._hasData) this.showError('No yield data available', () => void this.fetchData());
        return false;
      }

      this.render(current, prior);
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load yield curve', () => void this.fetchData());
      return false;
    }
  }

  private render(current: YieldPoint[], prior: YieldPoint[]): void {
    this._hasData = true;

    const y2 = current.find(p => p.tenor === '2Y')?.value ?? null;
    const y10 = current.find(p => p.tenor === '10Y')?.value ?? null;
    const isInverted = y2 !== null && y10 !== null && y2 > y10;
    const spreadBps = y2 !== null && y10 !== null ? ((y10 - y2) * 100).toFixed(0) : null;
    const spreadSign = spreadBps !== null ? (Number(spreadBps) >= 0 ? '+' : '') : '';

    const statusBadge = isInverted
      ? `<span style="background:#e74c3c;color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;letter-spacing:0.08em">INVERTED</span>`
      : `<span style="background:#2ecc71;color:#000;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;letter-spacing:0.08em">NORMAL</span>`;

    const spreadHtml = spreadBps !== null
      ? `<span style="font-size:11px;color:var(--text-dim);margin-left:10px">2Y-10Y Spread: <span style="color:${isInverted ? '#e74c3c' : '#2ecc71'}">${escapeHtml(spreadSign + spreadBps)}bps</span></span>`
      : '';

    const html = `
      <div style="padding:10px 14px 6px">
        <div style="display:flex;align-items:center;margin-bottom:10px;gap:4px">
          ${statusBadge}${spreadHtml}
        </div>
        <div style="margin:0 -4px">${renderChart(current, prior)}</div>
        ${renderTable(current)}
        <div style="margin-top:8px;font-size:9px;color:var(--text-dim);display:flex;gap:12px;align-items:center">
          <span><svg width="20" height="4" style="vertical-align:middle"><line x1="0" y1="2" x2="20" y2="2" stroke="#3498db" stroke-width="2"/></svg> Current</span>
          <span><svg width="20" height="4" style="vertical-align:middle"><line x1="0" y1="2" x2="20" y2="2" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" stroke-dasharray="4,3"/></svg> Prior</span>
          <span style="margin-left:auto">Source: FRED</span>
        </div>
      </div>`;

    this.setContent(html);
  }
}
