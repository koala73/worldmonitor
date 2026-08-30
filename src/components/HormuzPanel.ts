import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { fetchHormuzTracker } from '@/services/hormuz-tracker';
import type { HormuzTrackerData, HormuzChart, HormuzSeries } from '@/services/hormuz-tracker';
import { fetchChokepointDependencies } from '@/services/supply-chain';
import type { GetChokepointDependenciesResponse } from '@/services/supply-chain';

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
  if (!series.length) return `<div style="height:${height}px;display:flex;align-items:center;color:var(--text-dim);font-size:calc(10px * var(--wm-panel-effective-scale, 1))">${escapeHtml(t('components.hormuzTracker.noData'))}</div>`;

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
  const lastVal = last ? Number(last.value).toFixed(0) : t('components.hormuzTracker.notAvailable');
  const lastDate = last ? last.date.slice(5) : '';
  const unit = chart.label.includes('crude_oil') ? t('components.hormuzTracker.units.ktPerDay') : t('components.hormuzTracker.units.generic');

  return `
    <div class="hz-chart" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(chart.title)}</span>
        <span style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));font-weight:600;color:${color}">${escapeHtml(lastVal)} <span style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${unit} · ${escapeHtml(lastDate)}</span></span>
      </div>
      <div style="position:relative">${barChart(chart.series, color, unit)}</div>
    </div>`;
}

export class HormuzPanel extends Panel {
  private data: HormuzTrackerData | null = null;
  private dependencies: GetChokepointDependenciesResponse | null = null;
  private dependencyState: 'loading' | 'loaded' | 'unavailable' = 'loading';
  private tooltipBound = false;
  private fetchGeneration = 0;

  constructor() {
    super({ id: 'hormuz-tracker', title: t('components.hormuzTracker.title'), showCount: false, infoTooltip: t('components.hormuzTracker.infoTooltip') });
  }

  public async fetchData(): Promise<boolean> {
    const generation = ++this.fetchGeneration;
    this.showLoading();
    this.dependencyState = 'loading';
    const dependenciesPromise = fetchChokepointDependencies('hormuz_strait', 25, { signal: this.signal })
      .catch(() => null);
    try {
      const data = await fetchHormuzTracker();
      if (generation !== this.fetchGeneration) return false;
      if (!data) {
        this.showError(t('components.hormuzTracker.errors.unavailable'), () => void this.fetchData());
        return false;
      }
      this.data = data;
      this.dependencies = null;
      this.renderPanel();
      this.bindTooltip();
      void dependenciesPromise.then((dependencies) => {
        if (this.signal.aborted || generation !== this.fetchGeneration) return;
        this.dependencies = dependencies;
        this.dependencyState = dependencies?.upstreamUnavailable === false
          ? 'loaded'
          : 'unavailable';
        this.renderPanel();
      });
      return true;
    } catch (e) {
      if (generation !== this.fetchGeneration) return false;
      this.showError(e instanceof Error ? e.message : t('components.hormuzTracker.errors.failedToLoad'), () => void this.fetchData());
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
      : `<div style="color:var(--text-dim);font-size:calc(11px * var(--wm-panel-effective-scale, 1));padding:8px 0">${escapeHtml(t('components.hormuzTracker.chartUnavailable'))}</div>`;

    const dateStr = d.updatedDate ? `<span style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${escapeHtml(d.updatedDate)}</span>` : '';
    const dependencies = this.renderDependencies();

    const html = `
      <div style="padding:12px 14px;position:relative">
        <div class="hz-tip" style="position:fixed;pointer-events:none;background:rgba(15,17,26,0.95);border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:3px 8px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:#fff;white-space:nowrap;z-index:9999;opacity:0;transition:opacity 0.08s;letter-spacing:0.02em"></div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="background:${sColor};color:#fff;font-size:calc(9px * var(--wm-panel-effective-scale, 1));font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:0.08em">${d.status.toUpperCase()}</span>
          ${dateStr}
        </div>
        <div>${charts}</div>
        ${dependencies}
        <div style="margin-top:4px;font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">
          ${escapeHtml(t('components.hormuzTracker.sourcePrefix'))} <a href="${escapeHtml(d.attribution.url)}" target="_blank" rel="noopener" style="color:var(--text-dim);text-decoration:underline">${escapeHtml(d.attribution.source)}</a>
        </div>
      </div>`;

    this.setSafeContent(unsafeRawHtml(html, 'legacy Panel.setContent() migration'));
  }

  private renderDependencies(): string {
    const response = this.dependencies;
    if (this.dependencyState === 'loading') {
      return `<div class="hz-dependencies" data-state="loading" style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)"><div class="hz-dependencies-title" style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));font-weight:700;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(t('components.supplyVulnerability.hormuzTitle'))}</div><div class="hz-dependencies-empty" style="margin-top:5px;color:var(--text-dim);font-size:calc(10px * var(--wm-panel-effective-scale, 1))">${escapeHtml(t('components.supplyVulnerability.loading'))}</div></div>`;
    }
    if (!response || response.upstreamUnavailable || response.dependencies.length === 0) {
      const emptyMessage = !response || response.upstreamUnavailable
        ? t('components.supplyVulnerability.unavailable')
        : t('components.supplyVulnerability.noCoverage');
      return `<div class="hz-dependencies" data-state="${this.dependencyState}" style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)"><div class="hz-dependencies-title" style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));font-weight:700;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(t('components.supplyVulnerability.hormuzTitle'))}</div><div class="hz-dependencies-empty" style="margin-top:5px;color:var(--text-dim);font-size:calc(10px * var(--wm-panel-effective-scale, 1))">${escapeHtml(emptyMessage)}</div></div>`;
    }

    const countries = new Map<string, typeof response.dependencies[number]>();
    const commodities = new Map<string, typeof response.dependencies[number]>();
    for (const dependency of response.dependencies) {
      if (!countries.has(dependency.countryIso2)) countries.set(dependency.countryIso2, dependency);
      if (!commodities.has(dependency.commodityId)) commodities.set(dependency.commodityId, dependency);
    }
    const renderItems = (items: Array<typeof response.dependencies[number]>, mode: 'country' | 'commodity') => items
      .slice(0, 5)
      .map((dependency) => {
        const label = mode === 'country' ? dependency.countryName : dependency.commodity;
        const context = mode === 'country' ? dependency.commodity : dependency.countryName;
        const score = dependency.score == null
          ? t('components.supplyVulnerability.unknown')
          : dependency.score.toFixed(1);
        const state = dependency.state === 'ok'
          ? t('components.supplyVulnerability.stateOk')
          : dependency.state === 'stale_input'
            ? t('components.supplyVulnerability.stateStale')
            : t('components.supplyVulnerability.stateInsufficient');
        return `<li><span>${escapeHtml(label)}</span><span>${escapeHtml(context)} · ${escapeHtml(state)} · ${escapeHtml(score)}</span></li>`;
      })
      .join('');

    return `<div class="hz-dependencies" style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)">
      <div class="hz-dependencies-title" style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));font-weight:700;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(t('components.supplyVulnerability.hormuzTitle'))}</div>
      <div class="hz-dependencies-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:7px;font-size:calc(9px * var(--wm-panel-effective-scale, 1))">
        <div><strong>${escapeHtml(t('components.supplyVulnerability.dependentCountries'))}</strong><ul style="list-style:none;margin:5px 0 0;padding:0">${renderItems([...countries.values()], 'country')}</ul></div>
        <div><strong>${escapeHtml(t('components.supplyVulnerability.dependentCommodities'))}</strong><ul style="list-style:none;margin:5px 0 0;padding:0">${renderItems([...commodities.values()], 'commodity')}</ul></div>
      </div>
      <div class="hz-dependencies-method" style="margin-top:7px;color:var(--text-dim);font-size:calc(8px * var(--wm-panel-effective-scale, 1))">${escapeHtml(t('components.supplyVulnerability.methodology'))}: ${escapeHtml(response.methodologyVersion)}</div>
    </div>`;
  }
}
