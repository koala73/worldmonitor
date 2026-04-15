import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';

interface BreadthSnapshot {
  date: string;
  // null = reading was missing (partial seed failure); 0 = legitimate 0%.
  pctAbove20d: number | null;
  pctAbove50d: number | null;
  pctAbove200d: number | null;
}

interface BreadthData {
  currentPctAbove20d: number | null;
  currentPctAbove50d: number | null;
  currentPctAbove200d: number | null;
  updatedAt: string;
  history: BreadthSnapshot[];
  unavailable?: boolean;
}

interface RawHistoryEntry {
  date: string;
  pctAbove20d?: number | null;
  pctAbove50d?: number | null;
  pctAbove200d?: number | null;
}

interface RawSeedPayload {
  current?: { pctAbove20d?: number | null; pctAbove50d?: number | null; pctAbove200d?: number | null };
  currentPctAbove20d?: number | null;
  currentPctAbove50d?: number | null;
  currentPctAbove200d?: number | null;
  updatedAt?: string;
  history?: RawHistoryEntry[];
  unavailable?: boolean;
}

function toNullable(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number.isFinite(v) ? v : null;
}

function normalizeBreadthData(raw: RawSeedPayload): BreadthData {
  const current = raw.current;
  const history: BreadthSnapshot[] = (raw.history ?? []).map((e) => ({
    date: e.date,
    pctAbove20d: toNullable(e.pctAbove20d),
    pctAbove50d: toNullable(e.pctAbove50d),
    pctAbove200d: toNullable(e.pctAbove200d),
  }));
  return {
    currentPctAbove20d: toNullable(raw.currentPctAbove20d ?? current?.pctAbove20d),
    currentPctAbove50d: toNullable(raw.currentPctAbove50d ?? current?.pctAbove50d),
    currentPctAbove200d: toNullable(raw.currentPctAbove200d ?? current?.pctAbove200d),
    updatedAt: raw.updatedAt ?? '',
    history,
    unavailable: raw.unavailable,
  };
}

const SVG_W = 480;
const SVG_H = 160;
const ML = 32;
const MR = 12;
const MT = 10;
const MB = 22;
const CW = SVG_W - ML - MR;
const CH = SVG_H - MT - MB;

type NumericSeriesKey = 'pctAbove20d' | 'pctAbove50d' | 'pctAbove200d';
type SeriesRun = Array<{ x: number; y: number }>;

const SERIES: { key: NumericSeriesKey; color: string; label: string; fillOpacity: number }[] = [
  { key: 'pctAbove20d',  color: '#3b82f6', label: '20-day SMA', fillOpacity: 0.08 },
  { key: 'pctAbove50d',  color: '#f59e0b', label: '50-day SMA', fillOpacity: 0.06 },
  { key: 'pctAbove200d', color: '#22c55e', label: '200-day SMA', fillOpacity: 0.04 },
];

function xPos(i: number, total: number): number {
  if (total <= 1) return ML + CW / 2;
  return ML + (i / (total - 1)) * CW;
}

function yPos(v: number): number {
  return MT + CH - (v / 100) * CH;
}

/**
 * Split a series into contiguous runs of valid points. Any null/non-finite
 * reading breaks the run so the chart renders visible gaps at missing days
 * instead of smoothing over them with a continuous line. Without this, a
 * seed partial failure would look like real uninterrupted trend data.
 */
function splitSeriesByNulls(points: BreadthSnapshot[], key: NumericSeriesKey): SeriesRun[] {
  const runs: SeriesRun[] = [];
  let current: SeriesRun = [];
  for (let i = 0; i < points.length; i++) {
    const v = points[i]![key];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      if (current.length > 0) {
        runs.push(current);
        current = [];
      }
      continue;
    }
    current.push({ x: xPos(i, points.length), y: yPos(v as number) });
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function runToAreaPath(run: SeriesRun): string {
  if (run.length < 2) return '';
  const baseline = yPos(0).toFixed(1);
  const first = run[0]!.x.toFixed(1);
  const last = run[run.length - 1]!.x.toFixed(1);
  const coords = run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  return `M${first},${baseline} L${coords.join(' L')} L${last},${baseline} Z`;
}

function runToPolylinePoints(run: SeriesRun): string {
  if (run.length === 0) return '';
  return run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function buildChart(points: BreadthSnapshot[]): string {
  if (points.length < 2) return '<div style="text-align:center;color:var(--text-dim);padding:20px;font-size:11px">Collecting data. Chart appears after 2+ days.</div>';

  const yAxis = [0, 25, 50, 75, 100].map(v => {
    const y = yPos(v);
    return `
      <line x1="${ML}" y1="${y.toFixed(1)}" x2="${SVG_W - MR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
      <text x="${(ML - 3).toFixed(0)}" y="${y.toFixed(1)}" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="8" dominant-baseline="middle">${v}%</text>`;
  }).join('');

  const step = Math.max(1, Math.floor(points.length / 6));
  const xAxis = points.map((p, i) => {
    if (i % step !== 0 && i !== points.length - 1) return '';
    const x = xPos(i, points.length);
    const label = p.date.slice(5);
    return `<text x="${x.toFixed(1)}" y="${SVG_H - MB + 13}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="7">${escapeHtml(label)}</text>`;
  }).join('');

  // Render each contiguous run separately so null/missing days leave visible
  // gaps instead of being bridged by a continuous polyline.
  const areas = SERIES.map(s => {
    const runs = splitSeriesByNulls(points, s.key as NumericSeriesKey);
    return runs
      .map((run) => {
        const d = runToAreaPath(run);
        if (!d) return '';
        return `<path d="${d}" fill="${s.color}" opacity="${s.fillOpacity}"/>`;
      })
      .join('');
  }).join('');

  const lines = SERIES.map(s => {
    const runs = splitSeriesByNulls(points, s.key as NumericSeriesKey);
    return runs
      .map((run) => {
        if (run.length < 2) return '';
        const coords = runToPolylinePoints(run);
        return `<polyline points="${coords}" fill="none" stroke="${s.color}" stroke-width="1.5" opacity="0.9"/>`;
      })
      .join('');
  }).join('');

  const midLine = yPos(50);
  const mid = `<line x1="${ML}" y1="${midLine.toFixed(1)}" x2="${SVG_W - MR}" y2="${midLine.toFixed(1)}" stroke="rgba(255,255,255,0.12)" stroke-width="1" stroke-dasharray="4 3"/>`;

  return `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">${yAxis}${mid}${xAxis}${areas}${lines}</svg>`;
}

function readingBadge(val: number, color: string): string {
  const bg = val >= 60 ? 'rgba(34,197,94,0.12)' : val >= 40 ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)';
  const fg = val >= 60 ? '#22c55e' : val >= 40 ? '#f59e0b' : '#ef4444';
  return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;background:${bg}">
    <span style="width:6px;height:6px;border-radius:50%;background:${color}"></span>
    <span style="font-size:14px;font-weight:600;color:${fg}">${val.toFixed(1)}%</span>
  </span>`;
}

export class MarketBreadthPanel extends Panel {
  private data: BreadthData | null = null;

  constructor() {
    super({ id: 'market-breadth', title: t('panels.marketBreadth'), showCount: false, infoTooltip: 'Percentage of S&P 500 stocks trading above their 20, 50, and 200-day simple moving averages. A measure of market participation and internal strength.' });
  }

  public async fetchData(): Promise<boolean> {
    const hydrated = getHydratedData('breadthHistory') as RawSeedPayload | undefined;
    if (hydrated && !hydrated.unavailable && hydrated.history?.length) {
      this.data = normalizeBreadthData(hydrated);
      this.renderPanel();
      void this.refreshFromRpc();
      return true;
    }

    this.showLoading();
    return this.refreshFromRpc();
  }

  private async refreshFromRpc(): Promise<boolean> {
    try {
      const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
      const { getRpcBaseUrl } = await import('@/services/rpc-client');
      const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
      const resp = await client.getMarketBreadthHistory({});
      if (resp.unavailable) {
        if (!this.data) this.showError(t('common.noDataShort'), () => void this.fetchData());
        return false;
      }
      // The RPC interface types these as `number` but the JSON wire preserves
      // null for missing readings — normalize through the same path as the
      // hydrated payload so partial failures become `null` not `0`.
      this.data = normalizeBreadthData(resp as unknown as RawSeedPayload);
      this.renderPanel();
      return true;
    } catch (e) {
      if (!this.data) this.showError(e instanceof Error ? e.message : t('common.failedToLoad'), () => void this.fetchData());
      return false;
    }
  }

  private renderPanel(): void {
    if (!this.data?.history?.length) {
      this.showError(t('common.noDataShort'), () => void this.fetchData());
      return;
    }

    const d = this.data;
    const chart = buildChart(d.history);

    const currentMap: Record<NumericSeriesKey, number | null> = {
      pctAbove20d: d.currentPctAbove20d,
      pctAbove50d: d.currentPctAbove50d,
      pctAbove200d: d.currentPctAbove200d,
    };

    const legend = SERIES.map(s => {
      const val = currentMap[s.key];
      // Distinguish missing (null) from a real 0% reading — a seed partial
      // failure shows "—", a legit zero renders a badge at 0.0%.
      const hasCurrent = typeof val === 'number' && Number.isFinite(val) && val >= 0;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0">
        <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim)">
          <span style="width:8px;height:3px;border-radius:1px;background:${s.color}"></span>
          % Above ${escapeHtml(s.label)}
        </span>
        ${hasCurrent ? readingBadge(val as number, s.color) : '<span style="font-size:11px;color:var(--text-dim)">\u2014</span>'}
      </div>`;
    }).join('');

    const html = `
      <div style="padding:12px 14px">
        <div style="margin-bottom:8px">${legend}</div>
        <div style="border-radius:6px;background:rgba(255,255,255,0.02);padding:4px 0">${chart}</div>
        ${d.updatedAt ? `<div style="text-align:right;font-size:9px;color:var(--text-dim);margin-top:4px">${escapeHtml(new Date(d.updatedAt).toLocaleString())}</div>` : ''}
      </div>`;

    this.setContent(html);
  }
}
