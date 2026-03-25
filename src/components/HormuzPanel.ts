import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { fetchHormuzTracker } from '@/services/hormuz-tracker';
import type { HormuzTrackerData, HormuzChart, HormuzSeries } from '@/services/hormuz-tracker';

const CHART_COLORS = ['#e67e22', '#1abc9c', '#9b59b6', '#27ae60'];
const ZERO_COLOR = 'rgba(231,76,60,0.5)';

function statusColor(status: string): string {
  switch (status) {
    case 'closed':     return '#e74c3c';
    case 'disrupted':  return '#e67e22';
    case 'restricted': return '#f39c12';
    default:           return '#2ecc71';
  }
}

function barChart(series: HormuzSeries[], color: string, unit: string, width = 280, height = 52): string {
  if (!series.length) return `<div style="height:${height}px;display:flex;align-items:center;color:var(--text-dim);font-size:10px">No data</div>`;

  const max = Math.max(...series.map(p => p.value), 1);
  const barW = Math.max(2, Math.floor((width - series.length) / series.length));

  let x = 0;
  const rects = series.map(p => {
    const h = Math.max(p.value > 0 ? 2 : 1, Math.round((p.value / max) * (height - 2)));
    const fill = p.value === 0 ? ZERO_COLOR : color;
    const rect = `<rect x="${x}" y="${height - h}" width="${barW}" height="${h}" fill="${fill}" rx="1"/>`;
    x += barW + 1;
    return rect;
  });

  x = 0;
  const hits = series.map(p => {
    const hit = `<rect class="hbar" x="${x}" y="0" width="${barW}" height="${height}" fill="transparent" data-date="${escapeHtml(p.date)}" data-val="${p.value}" data-unit="${escapeHtml(unit)}" style="cursor:crosshair"/>`;
    x += barW + 1;
    return hit;
  });

  return `<svg class="hz-svg" width="${width}" height="${height}" style="display:block;overflow:visible">${rects.join('')}${hits.join('')}</svg>`;
}

function renderChart(chart: HormuzChart, idx: number): string {
  const color = CHART_COLORS[idx % CHART_COLORS.length] ?? '#3498db';
  const last = chart.series[chart.series.length - 1];
  const lastVal = last ? last.value.toFixed(0) : 'N/A';
  const lastDate = last ? last.date.slice(5) : '';
  const unit = chart.label.includes('crude_oil') ? 'kt/day' : 'units';

  return `
    <div class="hz-chart" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(chart.title)}</span>
        <span style="font-size:11px;font-weight:600;color:${color}">${escapeHtml(lastVal)} <span style="font-size:9px;color:var(--text-dim)">${unit} · ${escapeHtml(lastDate)}</span></span>
      </div>
      <div style="position:relative">${barChart(chart.series, color, unit)}</div>
    </div>`;
}

export class HormuzPanel extends Panel {
  private data: HormuzTrackerData | null = null;
  private tooltipBound = false;

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
      this.bindTooltip();
      return true;
    } catch (e) {
      this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private bindTooltip(): void {
    if (this.tooltipBound || !this.element) return;
    this.tooltipBound = true;

    this.element.addEventListener('mousemove', (e: Event) => {
      const target = e.target as Element;
      if (!target.classList?.contains('hbar')) return;
      const date = (target.getAttribute('data-date') ?? '').slice(5);
      const val = target.getAttribute('data-val') ?? '';
      const unit = target.getAttribute('data-unit') ?? '';
      const tip = this.element?.querySelector<HTMLElement>('.hz-tip');
      if (!tip) return;
      const barRect = (target as SVGRectElement).getBoundingClientRect();
      tip.style.left = `${barRect.left + barRect.width / 2}px`;
      tip.style.top = `${Math.max(8, barRect.top - 28)}px`;
      tip.style.transform = 'translateX(-50%)';
      tip.style.opacity = '1';
      tip.textContent = `${date}  ${val} ${unit}`;
    });

    this.element.addEventListener('mouseleave', () => {
      const tip = this.element?.querySelector<HTMLElement>('.hz-tip');
      if (tip) tip.style.opacity = '0';
    });
  }

  private renderPanel(): void {
    if (!this.data) return;
    const d = this.data;
    const sColor = statusColor(d.status);

    const charts = d.charts.length
      ? d.charts.map((c, i) => renderChart(c, i)).join('')
      : '<div style="color:var(--text-dim);font-size:11px;padding:8px 0">Chart data unavailable</div>';

    const dateStr = d.updatedDate ? `<span style="font-size:10px;color:var(--text-dim)">${escapeHtml(d.updatedDate)}</span>` : '';

    const html = `
      <div style="padding:12px 14px;position:relative">
        <div class="hz-tip" style="position:fixed;pointer-events:none;background:rgba(15,17,26,0.95);border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:3px 8px;font-size:10px;color:#fff;white-space:nowrap;z-index:9999;opacity:0;transition:opacity 0.08s;letter-spacing:0.02em"></div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="background:${sColor};color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:0.08em">${d.status.toUpperCase()}</span>
          ${dateStr}
        </div>
        <div>${charts}</div>
        <div style="margin-top:4px;font-size:9px;color:var(--text-dim)">
          Source: <a href="${escapeHtml(d.attribution.url)}" target="_blank" rel="noopener" style="color:var(--text-dim);text-decoration:underline">${escapeHtml(d.attribution.source)}</a>
        </div>
      </div>`;

    this.setContent(html);
  }
}
