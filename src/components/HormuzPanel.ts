import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { fetchHormuzTracker } from '@/services/hormuz-tracker';
import type { HormuzTrackerData, HormuzChart, HormuzSeries } from '@/services/hormuz-tracker';

function statusColor(status: string): string {
  switch (status) {
    case 'closed': return '#e74c3c';
    case 'disrupted': return '#e67e22';
    case 'restricted': return '#f39c12';
    default: return '#2ecc71';
  }
}

function statusLabel(status: string): string {
  return status.toUpperCase();
}

function barChart(series: HormuzSeries[], width = 280, height = 48): string {
  if (!series.length) return `<div style="height:${height}px;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:10px">No data</div>`;

  const max = Math.max(...series.map(p => p.value), 1);
  const barW = Math.max(1, Math.floor((width - series.length) / series.length));
  const bars = series.map(p => {
    const h = Math.round((p.value / max) * (height - 2));
    const color = p.value === 0 ? '#e74c3c' : '#3498db';
    return `<rect x="0" y="${height - h}" width="${barW}" height="${h}" fill="${color}" rx="1"/>`;
  });

  let x = 0;
  const positioned = bars.map(b => {
    const rect = `<g transform="translate(${x},0)">${b}</g>`;
    x += barW + 1;
    return rect;
  });

  return `<svg width="${width}" height="${height}" style="display:block;overflow:visible">
    ${positioned.join('')}
  </svg>`;
}

function renderChart(chart: HormuzChart): string {
  const last = chart.series[chart.series.length - 1];
  const lastVal = last ? last.value.toFixed(0) : 'N/A';
  const lastDate = last ? last.date.slice(5) : '';
  const unit = chart.label.includes('crude_oil') ? 'kt/day' : 'units';

  return `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
        <span style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(chart.title)}</span>
        <span style="font-size:11px;font-weight:600;color:var(--text)">${escapeHtml(lastVal)} <span style="font-size:9px;color:var(--text-dim)">${unit} · ${escapeHtml(lastDate)}</span></span>
      </div>
      ${barChart(chart.series)}
    </div>`;
}

export class HormuzPanel extends Panel {
  private data: HormuzTrackerData | null = null;

  constructor() {
    super({ id: 'hormuz-tracker', title: 'Hormuz Trade Tracker', showCount: false });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      const data = await fetchHormuzTracker();
      if (!data) {
        this.showError('Hormuz data unavailable', () => void this.fetchData());
        return false;
      }
      this.data = data;
      this.renderPanel();
      return true;
    } catch (e) {
      this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private renderPanel(): void {
    if (!this.data) return;
    const d = this.data;
    const color = statusColor(d.status);

    const charts = d.charts.length
      ? d.charts.map(c => renderChart(c)).join('')
      : '<div style="color:var(--text-dim);font-size:11px;padding:8px 0">Chart data unavailable</div>';

    const dateStr = d.updatedDate ? `<span style="font-size:10px;color:var(--text-dim)">${escapeHtml(d.updatedDate)}</span>` : '';
    const summary = d.summary ? `<div style="font-size:11px;color:var(--text-dim);margin:6px 0;line-height:1.4">${escapeHtml(d.summary)}</div>` : '';

    const html = `
      <div style="padding:12px 14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="background:${color};color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:0.08em">${statusLabel(d.status)}</span>
          ${dateStr}
        </div>
        ${summary}
        <div style="border-top:1px solid rgba(255,255,255,0.07);padding-top:8px;margin-top:4px">
          ${charts}
        </div>
        <div style="margin-top:6px;font-size:9px;color:var(--text-dim)">
          Source: <a href="${escapeHtml(d.attribution.url)}" target="_blank" rel="noopener" style="color:var(--text-dim);text-decoration:underline">${escapeHtml(d.attribution.source)}</a>
        </div>
      </div>`;

    this.setContent(html);
  }
}
