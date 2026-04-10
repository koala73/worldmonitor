import { Panel } from './Panel';
import type {
  GetShippingRatesResponse,
  GetChokepointStatusResponse,
  GetCriticalMineralsResponse,
  GetShippingStressResponse,
} from '@/services/supply-chain';
import { fetchBypassOptions } from '@/services/supply-chain';
import { TransitChart } from '@/utils/transit-chart';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { isFeatureAvailable } from '@/services/runtime-config';
import { isDesktopRuntime } from '@/services/runtime';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { hasPremiumAccess } from '@/services/panel-gating';
import { trackGateHit } from '@/services/analytics';

type TabId = 'chokepoints' | 'shipping' | 'indicators' | 'minerals' | 'stress';

const FLOW_SUPPORTED_IDS = new Set(['hormuz_strait', 'malacca_strait', 'suez', 'bab_el_mandeb']);

export class SupplyChainPanel extends Panel {
  private shippingData: GetShippingRatesResponse | null = null;
  private chokepointData: GetChokepointStatusResponse | null = null;
  private mineralsData: GetCriticalMineralsResponse | null = null;
  private stressData: GetShippingStressResponse | null = null;
  private activeTab: TabId = 'chokepoints';
  private expandedChokepoint: string | null = null;
  private transitChart = new TransitChart();
  private chartObserver: MutationObserver | null = null;
  private chartMountTimer: ReturnType<typeof setTimeout> | null = null;
  private bypassUnsubscribe: (() => void) | null = null;
  private bypassGateTracked = false;

  constructor() {
    super({ id: 'supply-chain', title: t('panels.supplyChain'), defaultRowSpan: 2, infoTooltip: t('components.supplyChain.infoTooltip') });
    this.content.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.panel-tab') as HTMLElement | null;
      if (tab) {
        const tabId = tab.dataset.tab as TabId;
        if (tabId && tabId !== this.activeTab) {
          this.clearTransitChart();
          this.activeTab = tabId;
          this.render();
        }
        return;
      }
      const card = (e.target as HTMLElement).closest('.trade-restriction-card') as HTMLElement | null;
      if (card?.dataset.cpId) {
        const newId = this.expandedChokepoint === card.dataset.cpId ? null : card.dataset.cpId;
        if (!newId) this.clearTransitChart();
        this.expandedChokepoint = newId;
        this.render();
      }
    });
  }

  private clearTransitChart(): void {
    if (this.chartMountTimer) { clearTimeout(this.chartMountTimer); this.chartMountTimer = null; }
    if (this.chartObserver) { this.chartObserver.disconnect(); this.chartObserver = null; }
    this.transitChart.destroy();
    if (this.bypassUnsubscribe) { this.bypassUnsubscribe(); this.bypassUnsubscribe = null; }
    this.bypassGateTracked = false;
  }

  public updateShippingRates(data: GetShippingRatesResponse): void {
    this.shippingData = data;
    this.render();
  }

  public updateChokepointStatus(data: GetChokepointStatusResponse): void {
    this.chokepointData = data;
    this.render();
  }

  public updateCriticalMinerals(data: GetCriticalMineralsResponse): void {
    this.mineralsData = data;
    this.render();
  }

  public updateShippingStress(data: GetShippingStressResponse): void {
    this.stressData = data;
    this.render();
  }

  private render(): void {
    this.clearTransitChart();

    const tabsHtml = `
      <div class="panel-tabs">
        <button class="panel-tab ${this.activeTab === 'chokepoints' ? 'active' : ''}" data-tab="chokepoints">
          ${t('components.supplyChain.chokepoints')}
        </button>
        <button class="panel-tab ${this.activeTab === 'shipping' ? 'active' : ''}" data-tab="shipping">
          ${t('components.supplyChain.shipping')}
        </button>
        <button class="panel-tab ${this.activeTab === 'indicators' ? 'active' : ''}" data-tab="indicators">
          ${t('components.supplyChain.economicIndicators')}
        </button>
        <button class="panel-tab ${this.activeTab === 'minerals' ? 'active' : ''}" data-tab="minerals">
          ${t('components.supplyChain.minerals')}
        </button>
        <button class="panel-tab ${this.activeTab === 'stress' ? 'active' : ''}" data-tab="stress">
          Stress
        </button>
      </div>
    `;

    const activeHasData = this.activeTab === 'chokepoints'
      ? (this.chokepointData?.chokepoints?.length ?? 0) > 0
      : this.activeTab === 'shipping'
        ? (this.shippingData?.indices?.length ?? 0) > 0 || this.chokepointData !== null
        : this.activeTab === 'indicators'
          ? (this.shippingData?.indices?.length ?? 0) > 0
          : this.activeTab === 'stress'
            ? (this.stressData?.carriers?.length ?? 0) > 0
            : (this.mineralsData?.minerals?.length ?? 0) > 0;
    const activeData = this.activeTab === 'chokepoints' ? this.chokepointData
      : (this.activeTab === 'shipping' || this.activeTab === 'indicators') ? this.shippingData
      : this.activeTab === 'stress' ? this.stressData
      : this.mineralsData;
    const unavailableBanner = !activeHasData && activeData?.upstreamUnavailable
      ? `<div class="economic-warning">${t('components.supplyChain.upstreamUnavailable')}</div>`
      : '';

    let contentHtml = '';
    switch (this.activeTab) {
      case 'chokepoints': contentHtml = this.renderChokepoints(); break;
      case 'shipping': contentHtml = this.renderShipping(); break;
      case 'indicators': contentHtml = this.renderIndicators(); break;
      case 'minerals': contentHtml = this.renderMinerals(); break;
      case 'stress': contentHtml = this.renderStress(); break;
    }

    this.setContent(`
      ${tabsHtml}
      ${unavailableBanner}
      <div class="economic-content">${contentHtml}</div>
    `);

    if (this.activeTab === 'chokepoints' && this.expandedChokepoint) {
      const expandedCpName = this.expandedChokepoint;
      const cp = this.chokepointData?.chokepoints?.find(c => c.name === expandedCpName);

      const mountTransitChart = (): boolean => {
        const el = this.content.querySelector(`[data-chart-cp="${expandedCpName}"]`) as HTMLElement | null;
        if (!el) return false;
        if (cp?.transitSummary?.history?.length) {
          this.transitChart.mount(el, cp.transitSummary.history);
        }
        return true;
      };

      const mountBypassOptions = (): boolean => {
        const bypassEl = this.content.querySelector(`[data-bypass-cp="${cp?.id ?? ''}"]`) as HTMLElement | null;
        if (!bypassEl) return false;
        this.renderBypassSection(bypassEl, cp?.id ?? '');
        return true;
      };

      // Use the bypass element as the "card is in DOM" sentinel — it is always rendered for
      // expanded cards, unlike the chart placeholder which is conditional on transit history.
      const mountAfterRender = (): boolean => {
        if (!mountBypassOptions()) return false;
        mountTransitChart();
        return true;
      };

      this.chartObserver = new MutationObserver(() => {
        if (!mountAfterRender()) return;
        if (this.chartMountTimer) { clearTimeout(this.chartMountTimer); this.chartMountTimer = null; }
        this.chartObserver?.disconnect();
        this.chartObserver = null;
      });
      this.chartObserver.observe(this.content, { childList: true, subtree: true });

      // Fallback for no-op renders where setContent short-circuits and no mutation fires.
      this.chartMountTimer = setTimeout(() => {
        if (!mountAfterRender()) return;
        if (this.chartObserver) { this.chartObserver.disconnect(); this.chartObserver = null; }
        this.chartMountTimer = null;
      }, 220);
    }
  }

  private renderBypassSection(container: HTMLElement, chokepointId: string): void {
    if (!chokepointId) return;

    const renderGate = (): string => {
      return `<div class="sc-bypass-gate"><span class="sc-bypass-lock">\uD83D\uDD12</span><span class="sc-bypass-gate-text">Bypass corridors available with PRO</span></div>`;
    };

    const renderRows = (options: import('@/services/supply-chain').BypassOption[]): string => {
      const top3 = options.slice(0, 3);
      if (!top3.length) return `<div class="sc-bypass-error">No bypass options available</div>`;
      const rows = top3.map(opt => {
        const days = opt.addedTransitDays > 0 ? `+${opt.addedTransitDays}d` : '-';
        const cost = opt.addedCostMultiplier > 1 ? `+${((opt.addedCostMultiplier - 1) * 100).toFixed(0)}%` : '-';
        const riskTierMap: Record<string, string> = {
          WAR_RISK_TIER_WAR_ZONE: 'War Zone',
          WAR_RISK_TIER_CRITICAL: 'Critical',
          WAR_RISK_TIER_HIGH: 'High',
          WAR_RISK_TIER_ELEVATED: 'Elevated',
          WAR_RISK_TIER_NORMAL: 'Normal',
        };
        const risk = riskTierMap[opt.bypassWarRiskTier] ?? opt.bypassWarRiskTier;
        return `<tr><td>${escapeHtml(opt.name)}</td><td>${days}</td><td>${cost}</td><td>${escapeHtml(risk)}</td></tr>`;
      }).join('');
      return `<table class="sc-bypass-table">
        <thead><tr><th>Corridor</th><th>+Days</th><th>+Cost</th><th>Risk</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    };

    const applyAuthState = (isPro: boolean, bypassOptions?: import('@/services/supply-chain').BypassOption[]): void => {
      if (!isPro) {
        container.innerHTML = renderGate();
        if (!this.bypassGateTracked) {
          trackGateHit('bypass-corridors');
          this.bypassGateTracked = true;
        }
        return;
      }
      if (bypassOptions !== undefined) {
        container.innerHTML = renderRows(bypassOptions);
      }
    };

    const isPro = hasPremiumAccess(getAuthState());
    if (!isPro) {
      applyAuthState(false);
      if (this.bypassUnsubscribe) { this.bypassUnsubscribe(); }
      this.bypassUnsubscribe = subscribeAuthState(state => {
        if (hasPremiumAccess(state)) {
          if (this.bypassUnsubscribe) { this.bypassUnsubscribe(); this.bypassUnsubscribe = null; }
          if (!this.content.contains(container)) return;
          container.innerHTML = `<div class="sc-bypass-loading">Loading bypass options\u2026</div>`;
          void fetchBypassOptions(chokepointId, 'container', 100).then(resp => {
            if (!this.content.contains(container)) return;
            container.innerHTML = renderRows(resp.options);
          }).catch(() => {
            if (!this.content.contains(container)) return;
            container.innerHTML = `<div class="sc-bypass-error">Bypass data unavailable</div>`;
          });
        }
      });
      return;
    }

    void fetchBypassOptions(chokepointId, 'container', 100).then(resp => {
      if (!this.content.contains(container)) return;
      applyAuthState(true, resp.options);
    }).catch(() => {
      if (!this.content.contains(container)) return;
      container.innerHTML = `<div class="sc-bypass-error">Bypass data unavailable</div>`;
    });
  }

  private renderChokepoints(): string {
    if (!this.chokepointData || !this.chokepointData.chokepoints?.length) {
      return `<div class="economic-empty">${t('components.supplyChain.noChokepoints')}</div>`;
    }

    return `<div class="trade-restrictions-list">
      ${[...this.chokepointData.chokepoints].sort((a, b) => b.disruptionScore - a.disruptionScore).map(cp => {
        const statusClass = cp.status === 'red' ? 'status-active' : cp.status === 'yellow' ? 'status-notified' : 'status-terminated';
        const statusDot = cp.status === 'red' ? 'sc-dot-red' : cp.status === 'yellow' ? 'sc-dot-yellow' : 'sc-dot-green';
        const aisDisruptions = cp.aisDisruptions ?? (cp.congestionLevel === 'normal' ? 0 : 1);
        const ts = cp.transitSummary;
        const wowPct = ts?.wowChangePct ?? 0;
        const hasWow = ts && wowPct !== 0;
        const wowSpan = hasWow ? `<span class="${wowPct >= 0 ? 'change-positive' : 'change-negative'}">${wowPct >= 0 ? '\u25B2' : '\u25BC'}${Math.abs(wowPct).toFixed(1)}%</span>` : '';
        const disruptPct = ts?.disruptionPct ?? 0;
        const disruptClass = disruptPct > 10 ? 'sc-disrupt-red' : disruptPct > 3 ? 'sc-disrupt-yellow' : 'sc-disrupt-green';
        const riskClass = (ts?.riskLevel === 'critical' || ts?.riskLevel === 'high') ? 'sc-disrupt-red'
          : (ts?.riskLevel === 'elevated' || ts?.riskLevel === 'moderate') ? 'sc-disrupt-yellow' : 'sc-disrupt-green';

        const expanded = this.expandedChokepoint === cp.name;
        const actionRow = expanded && ts?.riskReportAction
          ? `<div class="sc-routing-advisory">${escapeHtml(ts.riskReportAction)}</div>`
          : '';
        const chartPlaceholder = expanded && ts?.history?.length
          ? `<div data-chart-cp="${escapeHtml(cp.name)}" style="margin-top:8px;min-height:200px"></div>`
          : '';

        const tier = cp.warRiskTier ?? 'WAR_RISK_TIER_NORMAL';
        const tierLabel: Record<string, string> = {
          WAR_RISK_TIER_WAR_ZONE: 'War Zone',
          WAR_RISK_TIER_CRITICAL: 'Critical',
          WAR_RISK_TIER_HIGH: 'High',
          WAR_RISK_TIER_ELEVATED: 'Elevated',
          WAR_RISK_TIER_NORMAL: 'Normal',
        };
        const tierClass: Record<string, string> = {
          WAR_RISK_TIER_WAR_ZONE: 'war',
          WAR_RISK_TIER_CRITICAL: 'critical',
          WAR_RISK_TIER_HIGH: 'high',
          WAR_RISK_TIER_ELEVATED: 'elevated',
          WAR_RISK_TIER_NORMAL: 'normal',
        };
        const warRiskBadge = `<span class="sc-war-risk-badge sc-war-risk-badge--${tierClass[tier] ?? 'normal'}">${tierLabel[tier] ?? 'Normal'}</span>`;

        const bypassSection = expanded
          ? `<div class="sc-bypass-section" data-bypass-cp="${escapeHtml(cp.id)}"><div class="sc-bypass-loading">Loading bypass options\u2026</div></div>`
          : '';

        return `<div class="trade-restriction-card${expanded ? ' expanded' : ''}" data-cp-id="${escapeHtml(cp.name)}" style="cursor:pointer">
          <div class="trade-restriction-header">
            <span class="trade-country">${escapeHtml(cp.name)}</span>
            <span class="sc-status-dot ${statusDot}"></span>
            <span class="trade-badge">${cp.disruptionScore}/100</span>
            <span class="trade-status ${statusClass}">${escapeHtml(cp.status)}</span>
          </div>
          <div class="trade-restriction-body">
            <div class="sc-metric-row">
              <span>${cp.activeWarnings} ${t('components.supplyChain.warnings')} · ${aisDisruptions} ${t('components.supplyChain.aisDisruptions')}</span>
              ${cp.directions?.length ? `<span>${cp.directions.map(d => escapeHtml(d)).join('/')}</span>` : ''}
            </div>
            ${ts && (ts.todayTotal > 0 || hasWow || disruptPct > 0) ? `<div class="sc-metric-row">
              ${ts.todayTotal > 0 ? `<span>${ts.todayTotal} ${t('components.supplyChain.vessels')}</span>` : ''}
              ${hasWow ? `<span>${t('components.supplyChain.wowChange')}: ${wowSpan}</span>` : ''}
              ${disruptPct > 0 ? `<span>${t('components.supplyChain.disruption')}: <span class="${disruptClass}">${disruptPct.toFixed(1)}%</span></span>` : ''}
            </div>` : ''}
            ${ts?.riskLevel ? `<div class="sc-metric-row">
              <span>${t('components.supplyChain.riskLevel')}: <span class="${riskClass}">${escapeHtml(ts.riskLevel)}</span></span>
              <span>${ts.incidentCount7d} ${t('components.supplyChain.incidents7d')}</span>
            </div>` : ''}
            <div class="sc-metric-row">${warRiskBadge}</div>
            ${cp.flowEstimate ? (() => {
              const fe = cp.flowEstimate;
              const pct = Math.round(fe.flowRatio * 100);
              const flowColor = fe.disrupted || pct < 85 ? '#ef4444' : pct < 95 ? '#f59e0b' : 'var(--text-dim,#888)';
              const hazardBadge = fe.hazardAlertLevel && fe.hazardAlertName
                ? ` <span style="background:#ea580c;color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px">&#9888; ${escapeHtml(fe.hazardAlertName.toUpperCase())}</span>`
                : '';
              return `<div class="sc-metric-row" style="color:${flowColor}">
                <span>~${fe.currentMbd} mb/d <span style="opacity:0.7">(${pct}% of ${fe.baselineMbd} baseline)</span>${hazardBadge}</span>
              </div>`;
            })() : FLOW_SUPPORTED_IDS.has(cp.id) ? `<div class="sc-metric-row" style="color:var(--text-dim,#888);font-size:11px;opacity:0.7">
                <span>${t('components.supplyChain.flowUnavailable')}</span>
              </div>` : ''}
            ${cp.description ? `<div class="trade-description">${escapeHtml(cp.description)}</div>` : ''}
            <div class="trade-affected">${cp.affectedRoutes.slice(0, 3).map(r => escapeHtml(r)).join(', ')}</div>
            ${actionRow}
            ${chartPlaceholder}
            ${bypassSection}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  private renderShipping(): string {
    const hasFred = this.shippingData?.indices?.length;
    const disruptionHtml = this.renderDisruptionSnapshot();

    if (!hasFred && !disruptionHtml) {
      return `<div class="economic-empty">${t('components.supplyChain.noShipping')}</div>`;
    }

    return `<div class="trade-restrictions-list">
      ${disruptionHtml}
      ${hasFred ? this.renderFredIndices() : ''}
    </div>`;
  }

  private renderDisruptionSnapshot(): string {
    if (this.chokepointData === null) {
      return `<div class="trade-sector" style="padding:8px;opacity:0.6">${t('components.supplyChain.loadingCorridors')}</div>`;
    }
    const cps = this.chokepointData.chokepoints;
    if (!cps?.length) return '';

    const sorted = [...cps].sort((a, b) => b.disruptionScore - a.disruptionScore);
    const filtered = sorted.filter(cp => cp.disruptionScore > 0);
    const rows = (filtered.length > 0 ? filtered : sorted.slice(0, 5));

    const tableRows = rows.map(cp => {
      const ts = cp.transitSummary;
      const statusDot = cp.status === 'red' ? 'sc-dot-red' : cp.status === 'yellow' ? 'sc-dot-yellow' : 'sc-dot-green';
      const wowPct = ts?.wowChangePct ?? 0;
      const wowCell = wowPct !== 0
        ? `<span class="${wowPct >= 0 ? 'change-positive' : 'change-negative'}">${wowPct >= 0 ? '\u25B2' : '\u25BC'}${Math.abs(wowPct).toFixed(1)}%</span>`
        : '-';
      const disruptPct = ts?.disruptionPct ?? 0;
      const disruptClass = disruptPct > 10 ? 'sc-disrupt-red' : disruptPct > 3 ? 'sc-disrupt-yellow' : 'sc-disrupt-green';
      const riskLevel = ts?.riskLevel || '-';
      const riskClass = (riskLevel === 'critical' || riskLevel === 'high') ? 'sc-disrupt-red'
        : (riskLevel === 'elevated' || riskLevel === 'moderate') ? 'sc-disrupt-yellow' : '';
      return `<tr>
        <td><span class="sc-status-dot ${statusDot}"></span> ${escapeHtml(cp.name)}</td>
        <td>${ts?.todayTotal ?? 0}</td>
        <td>${wowCell}</td>
        <td><span class="${disruptClass}">${disruptPct > 0 ? disruptPct.toFixed(1) + '%' : '-'}</span></td>
        <td>${riskClass ? `<span class="${riskClass}">${escapeHtml(riskLevel)}</span>` : escapeHtml(riskLevel)}</td>
      </tr>`;
    }).join('');

    return `<div style="margin-bottom:8px">
      <div class="trade-sector" style="font-weight:600;margin-bottom:4px">${t('components.supplyChain.corridorDisruption')}</div>
      <table class="sc-disruption-table">
        <thead><tr>
          <th>${t('components.supplyChain.corridor')}</th>
          <th>${t('components.supplyChain.vessels')}</th>
          <th>${t('components.supplyChain.wowChange')}</th>
          <th>${t('components.supplyChain.disruption')}</th>
          <th>${t('components.supplyChain.risk')}</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
  }

  private renderFredIndices(): string {
    if (isDesktopRuntime() && !isFeatureAvailable('supplyChain')) return '';
    if (!this.shippingData?.indices?.length) return '';
    const container = new Set(['SCFI', 'CCFI']);
    const bulk = new Set(['BDI', 'BCI', 'BPI', 'BSI', 'BHSI']);

    const containerIndices = this.shippingData.indices.filter(i => container.has(i.indexId));
    const bulkIndices = this.shippingData.indices.filter(i => bulk.has(i.indexId));

    const renderGroup = (label: string, indices: typeof this.shippingData.indices): string => {
      if (!indices.length) return '';
      const cards = indices.map(idx => {
        const changeClass = idx.changePct >= 0 ? 'change-positive' : 'change-negative';
        const changeArrow = idx.changePct >= 0 ? '\u25B2' : '\u25BC';
        const sparkline = this.renderSparkline(idx.history.map(h => h.value), idx.history.map(h => h.date));
        const spikeBanner = idx.spikeAlert
          ? `<div class="economic-warning">${t('components.supplyChain.spikeAlert')}</div>`
          : '';
        return `<div class="trade-restriction-card">
          ${spikeBanner}
          <div class="trade-restriction-header">
            <span class="trade-country">${escapeHtml(idx.name)}</span>
            <span class="trade-badge">${idx.currentValue.toFixed(0)} ${escapeHtml(idx.unit)}</span>
            <span class="trade-flow-change ${changeClass}">${changeArrow} ${Math.abs(idx.changePct).toFixed(1)}%</span>
          </div>
          <div class="trade-restriction-body">
            ${sparkline}
          </div>
        </div>`;
      }).join('');
      return `<div class="trade-sector" style="font-weight:600;margin:8px 0 4px">${escapeHtml(label)}</div>${cards}`;
    };

    return [
      renderGroup(t('components.supplyChain.containerRates'), containerIndices),
      renderGroup(t('components.supplyChain.bulkShipping'), bulkIndices),
    ].join('');
  }

  private renderIndicators(): string {
    if (isDesktopRuntime() && !isFeatureAvailable('supplyChain')) return '';
    if (!this.shippingData?.indices?.length) {
      return `<div class="economic-empty">${t('components.supplyChain.noShipping')}</div>`;
    }
    const container = new Set(['SCFI', 'CCFI']);
    const bulk = new Set(['BDI', 'BCI', 'BPI', 'BSI', 'BHSI']);
    const econIndices = this.shippingData.indices.filter(i => !container.has(i.indexId) && !bulk.has(i.indexId));
    if (!econIndices.length) {
      return `<div class="economic-empty">${t('components.supplyChain.noShipping')}</div>`;
    }
    const cards = econIndices.map(idx => {
      const changeClass = idx.changePct >= 0 ? 'change-positive' : 'change-negative';
      const changeArrow = idx.changePct >= 0 ? '\u25B2' : '\u25BC';
      const sparkline = this.renderSparkline(idx.history.map(h => h.value), idx.history.map(h => h.date));
      const spikeBanner = idx.spikeAlert
        ? `<div class="economic-warning">${t('components.supplyChain.spikeAlert')}</div>`
        : '';
      return `<div class="trade-restriction-card">
          ${spikeBanner}
          <div class="trade-restriction-header">
            <span class="trade-country">${escapeHtml(idx.name)}</span>
            <span class="trade-badge">${idx.currentValue.toFixed(0)} ${escapeHtml(idx.unit)}</span>
            <span class="trade-flow-change ${changeClass}">${changeArrow} ${Math.abs(idx.changePct).toFixed(1)}%</span>
          </div>
          <div class="trade-restriction-body">
            ${sparkline}
          </div>
        </div>`;
    }).join('');
    return `<div class="trade-restrictions-list">${cards}</div>`;
  }

  private renderStress(): string {
    if (!this.stressData || !this.stressData.carriers?.length) {
      return `<div class="economic-empty">Shipping stress data unavailable</div>`;
    }

    const { stressScore, stressLevel, carriers } = this.stressData;
    const levelColor = stressLevel === 'critical' ? '#e74c3c'
      : stressLevel === 'elevated' ? '#e67e22'
      : stressLevel === 'moderate' ? '#f1c40f'
      : '#27ae60';

    const gaugeWidth = Math.round(Math.min(100, Math.max(0, stressScore)));
    const gaugeBg = stressLevel === 'critical' ? 'rgba(231,76,60,0.15)'
      : stressLevel === 'elevated' ? 'rgba(230,126,34,0.15)'
      : stressLevel === 'moderate' ? 'rgba(241,196,15,0.15)'
      : 'rgba(39,174,96,0.15)';

    const header = `<div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em">Composite Stress Score</span>
        <span style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:3px;background:${gaugeBg};color:${levelColor}">${escapeHtml(stressLevel.toUpperCase())}</span>
      </div>
      <div style="position:relative;height:6px;border-radius:3px;background:rgba(255,255,255,0.08)">
        <div style="position:absolute;left:0;top:0;height:100%;width:${gaugeWidth}%;border-radius:3px;background:${levelColor};transition:width 0.4s"></div>
      </div>
      <div style="text-align:right;font-size:10px;color:var(--text-dim);margin-top:2px">${stressScore.toFixed(1)}/100</div>
    </div>`;

    const rows = carriers.map(c => {
      const changeClass = c.changePct >= 0 ? 'change-positive' : 'change-negative';
      const arrow = c.changePct >= 0 ? '▲' : '▼';
      const typeLabel = c.carrierType === 'etf' ? 'ETF' : c.carrierType === 'index' ? 'IDX' : 'CARR';
      const spark = c.sparkline?.length >= 2 ? this.renderSparkline(c.sparkline) : '';
      return `<div class="trade-restriction-card">
        <div class="trade-restriction-header">
          <span class="trade-country" style="font-size:11px">${escapeHtml(c.symbol)}</span>
          <span style="font-size:9px;padding:1px 5px;border-radius:2px;background:rgba(255,255,255,0.06);color:var(--text-dim)">${typeLabel}</span>
          <span class="trade-badge">${c.price.toFixed(2)}</span>
          <span class="trade-flow-change ${changeClass}">${arrow} ${Math.abs(c.changePct).toFixed(2)}%</span>
        </div>
        <div class="trade-restriction-body" style="font-size:10px;color:var(--text-dim)">${escapeHtml(c.name)}${spark}</div>
      </div>`;
    }).join('');

    return `<div class="trade-restrictions-list">${header}${rows}</div>`;
  }

  private renderSparkline(values: number[], dates?: string[]): string {
    if (values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const w = 200;
    const h = 40;
    const totalH = dates?.length ? h + 14 : h;
    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const dateLabels = dates?.length ? `
      <text x="0" y="${totalH - 1}" fill="var(--text-dim,#888)" font-size="9" text-anchor="start">${escapeHtml(dates[0]!.slice(0, 7))}</text>
      <text x="${w}" y="${totalH - 1}" fill="var(--text-dim,#888)" font-size="9" text-anchor="end">${escapeHtml(dates[dates.length - 1]!.slice(0, 7))}</text>
    ` : '';

    return `<svg width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}" style="display:block;margin:4px 0">
      <polyline points="${points}" fill="none" stroke="var(--accent-primary, #4fc3f7)" stroke-width="1.5" />
      ${dateLabels}
    </svg>`;
  }

  private renderMinerals(): string {
    if (!this.mineralsData || !this.mineralsData.minerals?.length) {
      return `<div class="economic-empty">${t('components.supplyChain.noMinerals')}</div>`;
    }

    const rows = this.mineralsData.minerals.map(m => {
      const riskClass = m.riskRating === 'critical' ? 'sc-risk-critical'
        : m.riskRating === 'high' ? 'sc-risk-high'
        : m.riskRating === 'moderate' ? 'sc-risk-moderate'
        : 'sc-risk-low';
      const top3 = m.topProducers.slice(0, 3).map(p =>
        `${escapeHtml(p.country)} ${p.sharePct.toFixed(0)}%`
      ).join(', ');
      return `<tr>
        <td>${escapeHtml(m.mineral)}</td>
        <td>${top3}</td>
        <td>${m.hhi.toFixed(0)}</td>
        <td><span class="${riskClass}">${escapeHtml(m.riskRating)}</span></td>
      </tr>`;
    }).join('');

    return `<div class="trade-tariffs-table">
      <table>
        <thead>
          <tr>
            <th>${t('components.supplyChain.mineral')}</th>
            <th>${t('components.supplyChain.topProducers')}</th>
            <th>HHI</th>
            <th>${t('components.supplyChain.risk')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }
}
