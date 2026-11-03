import { Panel } from './Panel';
import { t, I18N_RESOURCES_LOADED_EVENT } from '@/services/i18n';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { fetchHormuzTracker } from '@/services/hormuz-tracker';
import type { HormuzTrackerData, HormuzChart, HormuzSeries } from '@/services/hormuz-tracker';
import { fetchChokepointDependencies } from '@/services/supply-chain';
import type { GetChokepointDependenciesResponse } from '@/services/supply-chain';
import { hasPremiumAccess } from '@/services/panel-gating';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { onEntitlementChange } from '@/services/entitlements';

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

  // Bars are laid out in a width-unit coordinate space and stretched to the
  // panel body, so the chart never runs past a narrow column or stops short
  // of a wide one. Height stays fixed.
  return `<svg class="hz-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" style="display:block;overflow:visible">${rects.join('')}${hits.join('')}</svg>`;
}

function renderChart(chart: HormuzChart, idx: number): string {
  const color = CHART_COLORS[idx % CHART_COLORS.length] ?? '#3498db';
  const last = chart.series[chart.series.length - 1];
  const lastVal = last ? Number(last.value).toFixed(0) : t('components.hormuzTracker.notAvailable');
  const lastDate = last ? last.date.slice(5) : '';
  // Every WTO series is a volume index (Jan–Mar 2025 average = 100), not tonnage.
  const unit = t('components.hormuzTracker.units.index');

  return `
    <div class="hz-chart" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:4px">
        <span style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(chart.title)}</span>
        <span style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));font-weight:600;color:${color}">${escapeHtml(lastVal)} <span style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${unit} · ${escapeHtml(lastDate)}</span></span>
      </div>
      <div style="position:relative">${barChart(chart.series, color, unit)}</div>
    </div>`;
}

/**
 * The part of `el` that is on screen: its box cut by every scrolling or
 * clipping ancestor (the sidebar grid scrolls panels partly out of view) and
 * by the viewport.
 */
function visibleBounds(el: HTMLElement): { left: number; top: number; right: number; bottom: number } {
  const r = el.getBoundingClientRect();
  const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = node.getBoundingClientRect();
    box.left = Math.max(box.left, clip.left);
    box.top = Math.max(box.top, clip.top);
    box.right = Math.min(box.right, clip.right);
    box.bottom = Math.min(box.bottom, clip.bottom);
  }
  box.left = Math.max(box.left, 0);
  box.top = Math.max(box.top, 0);
  box.right = Math.min(box.right, window.innerWidth);
  box.bottom = Math.min(box.bottom, window.innerHeight);
  return box;
}

export class HormuzPanel extends Panel {
  private data: HormuzTrackerData | null = null;
  // False while a fetch is loading or after it failed, when `data` is an old snapshot.
  private showingData = false;
  private dependencies: GetChokepointDependenciesResponse | null = null;
  private dependencyState: 'loading' | 'loaded' | 'unavailable' | 'pro-locked' = 'loading';
  private tooltipBound = false;
  private fetchGeneration = 0;
  private dependencyGeneration = 0;
  private dependencyAbortController: AbortController | null = null;
  private dependencyAbortCleanup: (() => void) | null = null;
  private authUnsubscribe: (() => void) | null = null;
  private entitlementUnsubscribe: (() => void) | null = null;
  private lastHadPremium = false;

  constructor() {
    super({ id: 'hormuz-tracker', title: t('components.hormuzTracker.title'), showCount: false, infoTooltip: t('components.hormuzTracker.infoTooltip') });
    this.lastHadPremium = hasPremiumAccess(getAuthState());
    this.authUnsubscribe = subscribeAuthState(() => this.handlePremiumAccessChange());
    this.entitlementUnsubscribe = onEntitlementChange(() => this.handlePremiumAccessChange());
    window.addEventListener(I18N_RESOURCES_LOADED_EVENT, this.handleTranslationsLoaded);
  }

  // The date label, unit and index note are not in the first-paint shell, and the
  // raw-key healer cannot restore an interpolated date, so redraw with real copy.
  // Skip it while loading or after a failed refresh: a redraw would show the old
  // snapshot as current and drop the error's retry.
  private readonly handleTranslationsLoaded = (): void => {
    if (this.data && this.showingData) this.renderPanel();
  };

  public async fetchData(): Promise<boolean> {
    const generation = ++this.fetchGeneration;
    this.invalidateDependencyRequest();
    this.showingData = false;
    this.showLoading();
    // The Hormuz tape itself stays free; only the commodity-dependency fan-out
    // over it is Pro (#6449). Gate just that leg so a free viewer keeps the
    // tracker and sees an upgrade line where the dependencies would be.
    const isPro = hasPremiumAccess(getAuthState());
    this.dependencyState = isPro ? 'loading' : 'pro-locked';
    let dependencyRequest = isPro ? this.startDependencyRequest() : null;
    try {
      const data = await fetchHormuzTracker();
      if (generation !== this.fetchGeneration) return false;
      if (!data) {
        this.showError(t('components.hormuzTracker.errors.unavailable'), () => void this.fetchData());
        return false;
      }
      this.data = data;
      this.showingData = true;
      this.dependencies = null;
      const currentIsPro = hasPremiumAccess(getAuthState());
      if (currentIsPro) {
        this.dependencyState = 'loading';
        if (!dependencyRequest || dependencyRequest.generation !== this.dependencyGeneration) {
          dependencyRequest = this.startDependencyRequest();
        }
      } else {
        this.invalidateDependencyRequest();
        this.dependencyState = 'pro-locked';
      }
      this.renderPanel();
      this.bindTooltip();
      void dependencyRequest?.promise.then((dependencies) => {
        if (
          this.signal.aborted ||
          generation !== this.fetchGeneration ||
          dependencyRequest?.generation !== this.dependencyGeneration ||
          !hasPremiumAccess(getAuthState())
        ) return;
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

  public override destroy(): void {
    window.removeEventListener(I18N_RESOURCES_LOADED_EVENT, this.handleTranslationsLoaded);
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    this.entitlementUnsubscribe?.();
    this.entitlementUnsubscribe = null;
    this.invalidateDependencyRequest();
    super.destroy();
  }

  private handlePremiumAccessChange(): void {
    const hasPremium = hasPremiumAccess(getAuthState());
    if (hasPremium === this.lastHadPremium) return;
    this.lastHadPremium = hasPremium;

    if (hasPremium) {
      if (!this.data) return;
      this.dependencies = null;
      this.dependencyState = 'loading';
      this.renderPanel();
      const dependencyRequest = this.startDependencyRequest();
      void dependencyRequest.promise.then((dependencies) => {
        if (
          this.signal.aborted ||
          dependencyRequest.generation !== this.dependencyGeneration ||
          !hasPremiumAccess(getAuthState())
        ) return;
        this.dependencies = dependencies;
        this.dependencyState = dependencies?.upstreamUnavailable === false
          ? 'loaded'
          : 'unavailable';
        this.renderPanel();
      });
      return;
    }

    this.invalidateDependencyRequest();
    this.dependencies = null;
    this.dependencyState = 'pro-locked';
    if (this.data) this.renderPanel();
  }

  private invalidateDependencyRequest(): void {
    this.dependencyGeneration += 1;
    this.dependencyAbortController?.abort();
    this.dependencyAbortController = null;
    this.dependencyAbortCleanup?.();
    this.dependencyAbortCleanup = null;
  }

  private startDependencyRequest(): {
    generation: number;
    promise: Promise<GetChokepointDependenciesResponse | null>;
  } {
    this.invalidateDependencyRequest();
    const generation = ++this.dependencyGeneration;
    const controller = new AbortController();
    const abortWithPanel = () => controller.abort();
    if (this.signal.aborted) {
      controller.abort();
    } else {
      this.signal.addEventListener('abort', abortWithPanel, { once: true });
    }
    const cleanup = () => this.signal.removeEventListener('abort', abortWithPanel);
    this.dependencyAbortController = controller;
    this.dependencyAbortCleanup = cleanup;
    const promise = fetchChokepointDependencies('hormuz_strait', 25, { signal: controller.signal })
      .catch(() => null)
      .finally(() => {
        if (this.dependencyAbortController !== controller) return;
        this.dependencyAbortController = null;
        this.dependencyAbortCleanup = null;
        cleanup();
      });
    return { generation, promise };
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
      tip.textContent = `${date}  ${val} ${unit}`;
      // The scrolling panel body's layout containment makes it the containing
      // block for this fixed tooltip, and its overflow clips it. Viewport
      // coordinates would land offset by the body's position, so measure
      // where (0, 0) lands and place from there, centred on the bar, inside
      // the visible body, and below the bar when there is no room above it.
      tip.style.transform = 'none';
      tip.style.left = '0px';
      tip.style.top = '0px';
      const origin = tip.getBoundingClientRect();
      const body = visibleBounds(tip.closest<HTMLElement>('.panel-content') ?? this.element as HTMLElement);
      const half = origin.width / 2;
      const centre = Math.min(Math.max(barRect.left + barRect.width / 2, body.left + half + 4), body.right - half - 4);
      const above = barRect.top - origin.height - 6;
      const top = above >= body.top + 4 ? above : Math.min(barRect.bottom + 6, body.bottom - origin.height - 4);
      tip.style.left = `${centre - half - origin.left}px`;
      tip.style.top = `${top - origin.top}px`;
      tip.style.opacity = '1';
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

    const dateStr = d.updatedDate ? `<span style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${escapeHtml(t('components.hormuzTracker.analysisDate', { date: d.updatedDate }))}</span>` : '';
    const dependencies = this.renderDependencies();

    const html = `
      <div style="padding:12px 14px;position:relative">
        <div class="hz-tip" style="position:fixed;pointer-events:none;background:rgba(15,17,26,0.95);border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:3px 8px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:#fff;white-space:nowrap;z-index:9999;opacity:0;transition:opacity 0.08s;letter-spacing:0.02em"></div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="background:${sColor};color:#fff;font-size:calc(9px * var(--wm-panel-effective-scale, 1));font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:0.08em">${d.status.toUpperCase()}</span>
          ${dateStr}
        </div>
        <div style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:var(--text-dim);margin-bottom:6px">${escapeHtml(t('components.hormuzTracker.indexNote'))}</div>
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
      return `<div class="hz-dependencies" data-state="loading"><div class="hz-dependencies-title">${escapeHtml(t('components.supplyVulnerability.hormuzTitle'))}</div><div class="hz-dependencies-empty">${escapeHtml(t('components.supplyVulnerability.loading'))}</div></div>`;
    }
    if (this.dependencyState === 'pro-locked' || !response || response.upstreamUnavailable || response.dependencies.length === 0) {
      const emptyMessage = this.dependencyState === 'pro-locked'
        ? t('components.supplyVulnerability.proLocked')
        : !response || response.upstreamUnavailable
          ? t('components.supplyVulnerability.unavailable')
          : t('components.supplyVulnerability.noCoverage');
      return `<div class="hz-dependencies" data-state="${this.dependencyState}"><div class="hz-dependencies-title">${escapeHtml(t('components.supplyVulnerability.hormuzTitle'))}</div><div class="hz-dependencies-empty">${escapeHtml(emptyMessage)}</div></div>`;
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
        return `<li class="hz-dependency"><span class="hz-dependency-label">${escapeHtml(label)}</span><span class="hz-dependency-context">${escapeHtml(context)} · ${escapeHtml(state)} · ${escapeHtml(score)}</span></li>`;
      })
      .join('');

    return `<div class="hz-dependencies">
      <div class="hz-dependencies-title">${escapeHtml(t('components.supplyVulnerability.hormuzTitle'))}</div>
      <div class="hz-dependencies-grid">
        <div><strong class="hz-dependencies-heading">${escapeHtml(t('components.supplyVulnerability.dependentCountries'))}</strong><ul class="hz-dependencies-list">${renderItems([...countries.values()], 'country')}</ul></div>
        <div><strong class="hz-dependencies-heading">${escapeHtml(t('components.supplyVulnerability.dependentCommodities'))}</strong><ul class="hz-dependencies-list">${renderItems([...commodities.values()], 'commodity')}</ul></div>
      </div>
      <div class="hz-dependencies-method">${escapeHtml(t('components.supplyVulnerability.methodology'))}: ${escapeHtml(response.methodologyVersion)}</div>
    </div>`;
  }
}
