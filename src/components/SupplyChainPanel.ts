import { Panel } from './Panel';
import type {
  GetShippingRatesResponse,
  GetChokepointStatusResponse,
  GetCriticalMineralsResponse,
  GetMineralProductionResponse,
  GetShippingStressResponse,
} from '@/services/supply-chain';
import { fetchBypassOptions, fetchChokepointHistory } from '@/services/supply-chain';
import type { TransitDayCount } from '@/services/supply-chain';
import type { ScenarioResult } from '@/config/scenario-templates';
import { SCENARIO_TEMPLATES } from '@/config/scenario-templates';
import { TransitChart } from '@/utils/transit-chart';
import { t } from '@/services/i18n';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { isFeatureAvailable } from '@/services/runtime-config';
import { isDesktopRuntime } from '@/services/runtime';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { hasPremiumAccess } from '@/services/panel-gating';
import { trackGateHit } from '@/services/analytics';
import { runScenario, getScenarioStatus } from '@/services/scenario';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { bindActivationKeys } from '@/utils/activation';
import { ISO2_TO_ISO3 } from '@/utils/country-codes';
import COUNTRY_PORT_CLUSTERS from '../../scripts/shared/country-port-clusters.json';


type TabId = 'chokepoints' | 'shipping' | 'indicators' | 'minerals' | 'stress';

const FLOW_SUPPORTED_IDS = new Set(['hormuz_strait', 'malacca_strait', 'suez', 'bab_el_mandeb']);

// Scenario country options, built once rather than per chokepoint card per render.
// The exposure seeder writes one key per country in COUNTRY_PORT_CLUSTERS, so codes
// outside it can never return a result — offer them disabled rather than letting a user
// pick a normal-looking country and get an empty simulation back with no explanation.
const SEEDED_SCENARIO_COUNTRIES = new Set(
  Object.keys(COUNTRY_PORT_CLUSTERS).filter(k => k !== '_comment' && k.length === 2),
);

const SCENARIO_COUNTRY_OPTIONS: Array<{ iso2: string; label: string; seeded: boolean }> = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  return Object.keys(ISO2_TO_ISO3)
    .map(iso2 => {
      const seeded = SEEDED_SCENARIO_COUNTRIES.has(iso2);
      const name = names.of(iso2) ?? iso2;
      return { iso2, label: seeded ? name : `${name} (not seeded)`, seeded };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
})();

// Today's transits come from the relay's in-memory 24h AIS window, which is
// empty far more often than it is zero-trafficked, and the relay cannot tell
// the two apart. The RPC coerces the absent case to 0 to keep the int32 wire
// contract, so a bare 0 is uninterpretable -- read todayCountsAvailable
// instead (#7457). Responses cached before that field existed fall back to the
// previous `> 0` inference rather than blanking real counts during rollout.
function hasPublishedTransitCount(ts?: { todayTotal?: number; todayCountsAvailable?: boolean }): boolean {
  if (!ts) return false;
  return ts.todayCountsAvailable ?? ((ts.todayTotal ?? 0) > 0);
}

export class SupplyChainPanel extends Panel {
  private shippingData: GetShippingRatesResponse | null = null;
  private chokepointData: GetChokepointStatusResponse | null = null;
  private mineralsData: GetCriticalMineralsResponse | null = null;
  private mineralProductionData: GetMineralProductionResponse | null = null;
  private mineralsStage: 'mine' | 'refinery' = 'mine';
  private stressData: GetShippingStressResponse | null = null;
  private activeTab: TabId = 'chokepoints';
  private expandedChokepoint: string | null = null;
  private pendingFocusChokepoint: string | null = null;
  private transitChart = new TransitChart();
  private chartObserver: MutationObserver | null = null;
  private chartMountTimer: ReturnType<typeof setTimeout> | null = null;
  // Session-scoped cache for lazy-loaded transit histories (keyed by chokepoint id).
  // Populated on first card expand via fetchChokepointHistory; reused across re-renders
  // so we don't refetch 35KB per expand/collapse cycle.
  private historyCache = new Map<string, TransitDayCount[]>();
  private historyInflight = new Set<string>();
  private bypassUnsubscribe: (() => void) | null = null;
  private bypassGateTracked = false;
  private onDismissScenario: (() => void) | null = null;
  private onScenarioActivate: ((scenarioId: string, result: ScenarioResult) => void) | null = null;
  private activeScenarioState: { scenarioId: string; result: ScenarioResult } | null = null;
  private scenarioControls = new Map<string, { iso2: string; disruptionPct: number }>();
  /**
   * Per-scenario run state. Part of the RENDER MODEL, not the DOM: the button's
   * disabled/label is derived from this in renderChokepoints(), so no code path mutates
   * the button node directly. Absent means idle.
   */
  private scenarioRunState = new Map<string, 'running' | 'idle' | 'error'>();
  /** When true, the next render() commits via setSafeContentImmediate (user gesture). */
  private pendingImmediateRender = false;
  private scenarioPollController: AbortController | null = null;

  constructor() {
    super({ id: 'supply-chain', title: t('panels.supplyChain'), defaultRowSpan: 2, infoTooltip: t('components.supplyChain.infoTooltip') });
    bindActivationKeys(this.content, '.trade-restriction-header');
    // `input` commits every keystroke; `change` additionally invalidates the run.
    // A number input fires `change` only on blur/Enter, so without the `input` half a
    // typed-but-uncommitted severity is silently reverted by any data-driven re-render
    // (the hourly supply-chain refresh, or showScenarioSummary landing mid-poll).
    this.content.addEventListener('input', (e) => {
      this.captureScenarioControls(e.target as HTMLElement);
    });
    this.content.addEventListener('change', (e) => {
      const trigger = this.captureScenarioControls(e.target as HTMLElement);
      if (!trigger) return;
      // Changing a control invalidates any in-flight run. Clear the run state as well as
      // aborting, so the button returns to "Simulate Closure" now rather than sitting at
      // "Computing…" until the abandoned poll happens to settle. The abandoned run's own
      // exit path is ownership-guarded, so it cannot clobber a newer run's button.
      this.scenarioPollController?.abort();
      const scenarioId = trigger.dataset.scenarioId;
      if (scenarioId) this.scenarioRunState.delete(scenarioId);
      this.renderFromUser();
    });
    this.content.addEventListener('click', (e) => {
      const stageBtn = (e.target as HTMLElement).closest('[data-mineral-stage]') as HTMLElement | null;
      if (stageBtn?.dataset.mineralStage === 'mine' || stageBtn?.dataset.mineralStage === 'refinery') {
        const next = stageBtn.dataset.mineralStage as 'mine' | 'refinery';
        if (next !== this.mineralsStage) {
          this.mineralsStage = next;
          this.render();
        }
        return;
      }
      const tab = (e.target as HTMLElement).closest('.panel-tab') as HTMLElement | null;
      if (tab?.dataset.tab) {
        const tabId = tab.dataset.tab as TabId;
        if (tabId !== this.activeTab) {
          this.clearTransitChart();
          this.activeTab = tabId;
          this.render();
        }
        return;
      }
      const scenarioTrigger = (e.target as HTMLElement).closest('.sc-scenario-trigger') as HTMLElement | null;
      if (scenarioTrigger) {
        e.stopPropagation();
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.sc-scenario-btn');
        if (btn && !btn.disabled) void this.runScenario(scenarioTrigger, btn);
        return;
      }
      const card = (e.target as HTMLElement).closest('.trade-restriction-card') as HTMLElement | null;
      if (card?.dataset.cpId) {
        const newId = this.expandedChokepoint === card.dataset.cpId ? null : card.dataset.cpId;
        if (!newId) this.clearTransitChart();
        this.expandedChokepoint = newId;
        this.pendingFocusChokepoint = card.dataset.cpId ?? null;
        this.render();
      }
    });
  }

  /**
   * Commit the country/severity controls for whichever scenario trigger `target` sits in.
   * Returns the trigger element, or null when the event came from elsewhere in the panel.
   */
  private captureScenarioControls(target: HTMLElement | null): HTMLElement | null {
    const trigger = target?.closest<HTMLElement>('.sc-scenario-trigger') ?? null;
    if (!trigger) return null;
    const scenarioId = trigger.dataset.scenarioId;
    if (!scenarioId) return null;
    const iso2 = trigger.querySelector<HTMLSelectElement>('.sc-scenario-country-select')?.value ?? '';
    const severityInput = trigger.querySelector<HTMLInputElement>('.sc-scenario-severity');
    const template = SCENARIO_TEMPLATES.find(tmpl => tmpl.id === scenarioId);
    // An empty box means "no override" — fall back to the template default rather than
    // persisting it as a deliberate 0% closure, which is a meaningfully different run.
    const raw = severityInput?.value ?? '';
    const disruptionPct = raw === '' ? (template?.disruptionPct ?? 0) : Number(raw);
    if (!Number.isFinite(disruptionPct)) return trigger;
    this.scenarioControls.set(scenarioId, { iso2, disruptionPct });
    return trigger;
  }

  /** Record run state and repaint immediately — this always follows a user action. */
  private setScenarioRunState(scenarioId: string, state: 'running' | 'idle' | 'error'): void {
    if (state === 'idle') this.scenarioRunState.delete(scenarioId);
    else this.scenarioRunState.set(scenarioId, state);
    this.renderFromUser();
  }

  private restoreChokepointHeaderFocus(): void {
    const name = this.pendingFocusChokepoint;
    this.pendingFocusChokepoint = null;
    if (!name) return;
    const cards = this.content.querySelectorAll<HTMLElement>('.trade-restriction-card');
    for (const card of cards) {
      if (card.dataset.cpId === name) {
        card.querySelector<HTMLElement>('.trade-restriction-header')?.focus();
        return;
      }
    }
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

  public updateMineralProduction(data: GetMineralProductionResponse): void {
    this.mineralProductionData = data;
    this.render();
  }

  public clearMineralProduction(): void {
    this.mineralProductionData = null;
    this.render();
  }

  public updateShippingStress(data: GetShippingStressResponse): void {
    this.stressData = data;
    this.render();
  }

  /** User-gesture repaint: bypass Panel's content coalesce so controls update same-tick. */
  private renderFromUser(): void {
    this.pendingImmediateRender = true;
    this.render();
  }

  /**
   * Paint the panel. Scenario control gestures use renderFromUser() so the button state
   * commits in the same tick instead of waiting on Panel's 150 ms content coalesce.
   */
  private render(): void {
    const immediate = this.pendingImmediateRender;
    this.pendingImmediateRender = false;
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
            : (this.mineralProductionData?.commodities?.length ?? 0) > 0
              || (this.mineralsData?.minerals?.length ?? 0) > 0;
    const activeData = this.activeTab === 'chokepoints' ? this.chokepointData
      : (this.activeTab === 'shipping' || this.activeTab === 'indicators') ? this.shippingData
      : this.activeTab === 'stress' ? this.stressData
      : this.mineralProductionData?.commodities?.length
        ? this.mineralProductionData
        : this.mineralsData;
    const unavailableBanner = activeData?.upstreamUnavailable
      && (this.activeTab === 'chokepoints' || !activeHasData)
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

    const html = unsafeRawHtml(`
      ${tabsHtml}
      ${unavailableBanner}
      <div class="economic-content">${contentHtml}</div>
    `, 'legacy Panel.setContent() migration');
    const afterUpdate = (): void => {
      this.restoreChokepointHeaderFocus();
      for (const trigger of this.content.querySelectorAll<HTMLElement>('.sc-scenario-trigger')) {
        const controls = this.scenarioControls.get(trigger.dataset.scenarioId!);
        const select = trigger.querySelector<HTMLSelectElement>('.sc-scenario-country-select');
        if (select) select.value = controls?.iso2 ?? '';
        // The severity input renders its value from an attribute, which a browser may keep
        // from the previous DOM; restore it explicitly alongside the select.
        const severityInput = trigger.querySelector<HTMLInputElement>('.sc-scenario-severity');
        if (severityInput && controls) severityInput.value = String(controls.disruptionPct);
      }
      // Re-insert the scenario banner after setContent replaces inner content.
      // Use the private renderScenarioBanner() — NOT showScenarioSummary() — so this
      // render() call doesn't recurse. showScenarioSummary() is the public activate
      // entrypoint that triggers render(); the banner DOM itself is built here from
      // activeScenarioState. Running it inside the setContent callback (rather than
      // after) guarantees it lands on the freshly committed DOM.
      if (this.activeScenarioState) this.renderScenarioBanner();
    };
    if (immediate) {
      this.setSafeContentImmediate(html, afterUpdate);
    } else {
      this.setSafeContent(html, afterUpdate);
    }

    if (this.activeTab === 'chokepoints' && this.expandedChokepoint) {
      const expandedCpName = this.expandedChokepoint;
      const cp = this.chokepointData?.chokepoints?.find(c => c.name === expandedCpName);

      const mountTransitChart = (): boolean => {
        const el = this.content.querySelector(`[data-chart-cp="${expandedCpName}"]`) as HTMLElement | null;
        if (!el) return false;
        const cpId = cp?.id ?? '';
        if (!cpId) { el.textContent = t('components.supplyChain.historyUnavailable') || 'History unavailable'; return true; }

        const cached = this.historyCache.get(cpId);
        if (cached && cached.length) {
          el.removeAttribute('style');
          el.style.marginTop = '8px';
          el.style.minHeight = '200px';
          el.textContent = '';
          this.transitChart.mount(el, cached);
          return true;
        }

        // NOTE: we do NOT cache empty/error results — a transient deploy-window
        // miss or a brief Redis error would otherwise poison the chokepoint for
        // the entire session. Each re-expand retries; the /get-chokepoint-history
        // gateway tier is "slow" (5-min CF edge cache) so retries stay cheap.

        if (this.historyInflight.has(cpId)) return true;
        this.historyInflight.add(cpId);
        void fetchChokepointHistory(cpId).then(resp => {
          this.historyInflight.delete(cpId);
          // Still mounted? Re-query — DOM may have re-rendered since fetch started.
          const liveEl = this.content.querySelector(`[data-chart-cp-id="${cpId}"]`) as HTMLElement | null;
          if (!liveEl) return;
          if (resp.history.length) {
            this.historyCache.set(cpId, resp.history);
            liveEl.removeAttribute('style');
            liveEl.style.marginTop = '8px';
            liveEl.style.minHeight = '200px';
            liveEl.textContent = '';
            this.transitChart.mount(liveEl, resp.history);
          } else {
            liveEl.textContent = t('components.supplyChain.historyUnavailable') || 'History unavailable';
          }
        }).catch(() => {
          this.historyInflight.delete(cpId);
          const liveEl = this.content.querySelector(`[data-chart-cp-id="${cpId}"]`) as HTMLElement | null;
          if (liveEl) liveEl.textContent = t('components.supplyChain.historyUnavailable') || 'History unavailable';
        });
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
          WAR_RISK_TIER_UNSPECIFIED: 'Normal',
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
        <thead><tr><th scope="col">Corridor</th><th scope="col">+Days</th><th scope="col">+Cost</th><th scope="col">Risk</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    };

    const applyAuthState = (isPro: boolean, bypassOptions?: import('@/services/supply-chain').BypassOption[]): void => {
      if (!isPro) {
        setTrustedHtml(container, trustedHtml(renderGate(), "legacy direct innerHTML migration"));
        if (!this.bypassGateTracked) {
          trackGateHit('bypass-corridors');
          this.bypassGateTracked = true;
        }
        return;
      }
      if (bypassOptions !== undefined) {
        setTrustedHtml(container, trustedHtml(renderRows(bypassOptions), "legacy direct innerHTML migration"));
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
          setTrustedHtml(container, trustedHtml(`<div class="sc-bypass-loading">Loading bypass options\u2026</div>`, "legacy direct innerHTML migration"));
          void fetchBypassOptions(chokepointId, 'container', 100).then(resp => {
            if (!this.content.contains(container)) return;
            setTrustedHtml(container, trustedHtml(renderRows(resp.options), "legacy direct innerHTML migration"));
          }).catch(() => {
            if (!this.content.contains(container)) return;
            setTrustedHtml(container, trustedHtml(`<div class="sc-bypass-error">Bypass data unavailable</div>`, "legacy direct innerHTML migration"));
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
      setTrustedHtml(container, trustedHtml(`<div class="sc-bypass-error">Bypass data unavailable</div>`, "legacy direct innerHTML migration"));
    });
  }

  private renderChokepoints(): string {
    if (!this.chokepointData || !this.chokepointData.chokepoints?.length) {
      return `<div class="economic-empty">${t('components.supplyChain.noChokepoints')}</div>`;
    }

    // Scenario projection overlay: when a scenario is active, show the
    // projected disruption score on every affected chokepoint card (current
    // XX → projected YY arrow). Before this, the scenario affected only the
    // map and a small banner; the card itself gave no visual indication that
    // the card's chokepoint was the one being simulated.
    const scenarioResult = this.activeScenarioState?.result;
    const affectedSet = new Set(scenarioResult?.affectedChokepointIds ?? []);
    const projectedScore = scenarioResult?.template?.disruptionPct ?? null;

    return `<div class="trade-restrictions-list">
      ${[...this.chokepointData.chokepoints].sort((a, b) => b.disruptionScore - a.disruptionScore).map(cp => {
        const isAffectedByScenario = affectedSet.has(cp.id);
        const statusClass = cp.status === 'red' ? 'status-active' : cp.status === 'yellow' ? 'status-notified' : 'status-terminated';
        const statusDot = cp.status === 'red' ? 'sc-dot-red' : cp.status === 'yellow' ? 'sc-dot-yellow' : 'sc-dot-green';
        const sourceMetrics = [
          cp.navigationalWarningsAvailable === true
            ? `${cp.activeWarnings} ${t('components.supplyChain.warnings')}`
            : '',
          cp.aisSnapshotAvailable === true
            ? `${cp.aisDisruptions} ${t('components.supplyChain.aisDisruptions')}`
            : '',
        ].filter(Boolean).join(' · ');
        const ts = cp.transitSummary;
        const wowPct = ts?.wowChangePct ?? 0;
        const hasWow = ts && wowPct !== 0;
        const hasTransitCount = hasPublishedTransitCount(ts);
        const wowSpan = hasWow ? `<span class="${wowPct >= 0 ? 'change-positive' : 'change-negative'}">${wowPct >= 0 ? '\u25B2' : '\u25BC'}${Math.abs(wowPct).toFixed(1)}%</span>` : '';
        const disruptPct = ts?.disruptionPct ?? 0;
        const disruptClass = disruptPct > 10 ? 'sc-disrupt-red' : disruptPct > 3 ? 'sc-disrupt-yellow' : 'sc-disrupt-green';
        const riskClass = (ts?.riskLevel === 'critical' || ts?.riskLevel === 'high') ? 'sc-disrupt-red'
          : (ts?.riskLevel === 'elevated' || ts?.riskLevel === 'moderate') ? 'sc-disrupt-yellow' : 'sc-disrupt-green';

        const expanded = this.expandedChokepoint === cp.name;
        // Render the chart placeholder only when expanded AND upstream reported
        // data available for this chokepoint. If dataAvailable === false, the
        // per-id history key would also be zero (we skip the lazy-fetch).
        const chartPlaceholder = expanded && ts?.dataAvailable !== false
          ? `<div data-chart-cp="${escapeHtml(cp.name)}" data-chart-cp-id="${escapeHtml(cp.id)}" style="margin-top:8px;min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--text-dim,#888);font-size:calc(12px * var(--wm-panel-effective-scale, 1))">${t('components.supplyChain.loadingHistory') || 'Loading transit history\u2026'}</div>`
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
          ? `<div class="sc-bypass-section" data-bypass-cp="${escapeHtml(cp.id)}"><div class="sc-bypass-heading">Bypass Options</div><div class="sc-bypass-loading">Loading bypass options\u2026</div></div>`
          : '';

        const scenarioSection = expanded ? (() => {
          const template = SCENARIO_TEMPLATES.find(tmpl =>
            tmpl.affectedChokepointIds.includes(cp.id) && tmpl.type !== 'tariff_shock'
          );
          if (!template) return '';
          const isPro = hasPremiumAccess(getAuthState());
          // Derive button state from activeScenarioState so it stays correct
          // across re-renders. Previously runScenario() imperatively set
          // btn.disabled = true + btn.textContent = 'Active' AFTER the
          // activate path had already called render() (via showScenarioSummary),
          // so the mutation hit a detached node and the visible button
          // remained enabled + "Simulate Closure" — letting users queue
          // duplicate runs of an already-active scenario.
          const controls = this.scenarioControls.get(template.id) ?? { iso2: '', disruptionPct: template.disruptionPct };
          const active = this.activeScenarioState;
          const isActiveScenario = active?.scenarioId === template.id
            && (active.result.scopedIso2 ?? '') === controls.iso2
            && active.result.template?.disruptionPct === controls.disruptionPct;
          // Button state is derived entirely from the model (run state + active scenario),
          // so a render can always repair it. Nothing mutates the button node directly.
          const runState = this.scenarioRunState.get(template.id);
          const isRunning = runState === 'running';
          const btnClass = [
            'sc-scenario-btn',
            !isPro ? 'sc-scenario-btn--gated' : '',
            isActiveScenario ? 'sc-scenario-btn--active' : '',
          ].filter(Boolean).join(' ');
          const btnLabel = isRunning ? 'Computing\u2026'
            : isActiveScenario ? 'Active'
            : runState === 'error' ? 'Error \u2014 retry'
            : 'Simulate Closure';
          const btnAttrs = [
            !isPro ? 'data-gated="1"' : '',
            isActiveScenario || isRunning ? 'disabled' : '',
          ].filter(Boolean).join(' ');
          return `<div class="sc-scenario-trigger" data-scenario-id="${escapeHtml(template.id)}" data-chokepoint-id="${escapeHtml(cp.id)}">
            <div class="sc-scenario-section-label">Scenario settings</div>
            <div class="sc-scenario-controls">
              <label class="sc-scenario-control sc-scenario-control--country">Country
                <select class="sc-scenario-country-select" aria-label="Scenario country">
                  <option value="">All seeded countries</option>
                  ${SCENARIO_COUNTRY_OPTIONS.map(c => `<option value="${c.iso2}"${c.seeded ? '' : ' disabled'}>${escapeHtml(c.label)}</option>`).join('')}
                </select>
              </label>
              <label class="sc-scenario-control">Closure severity (%)
                <input class="sc-scenario-severity" type="number" min="0" max="100" step="1" value="${controls.disruptionPct}" aria-label="Closure severity (%)">
              </label>
            </div>
            <div class="sc-scenario-actions"><p class="sc-scenario-hint">${template.durationDays} days is descriptive only. Coverage is checked when the run completes.</p>
            <button class="${btnClass}" ${btnAttrs} aria-label="Simulate ${escapeHtml(template.name)}">
              ${btnLabel}
            </button></div>
          </div>`;
        })() : '';

        // Projected score (0–100) when this card is the scenario target AND
        // the scenario would push the score higher than today's. disruptionPct
        // is "% of capacity blocked" in the template — NOT the same scale as
        // the computed cp.disruptionScore (threat + warnings + anomaly), but
        // they share the 0–100 axis so we can compare directionally.
        //
        // Only show the projection arrow when `template.disruptionPct >
        // cp.disruptionScore`. When current already meets or exceeds the
        // scenario's closure level (e.g., Suez scenario at 80% with Suez
        // currently at 82/100, or Panama at 50% scenario vs a 60/100
        // current score), the arrow would render `N/100 → N/100` and
        // imply the scenario has zero effect, which is misleading. The
        // red left border + scenario callout still indicate the card is
        // affected; the arrow stays reserved for a genuine escalation.
        const showProjection = isAffectedByScenario
          && projectedScore != null
          && projectedScore > cp.disruptionScore;
        const badgeHtml = showProjection
          ? `<span class="trade-badge">${cp.disruptionScore}/100</span> <span class="trade-badge trade-badge--projected" style="background:#7f1d1d;color:#fff;margin-left:4px">\u2192 ${projectedScore}/100</span>`
          : `<span class="trade-badge">${cp.disruptionScore}/100</span>`;

        return `<div class="trade-restriction-card${expanded ? ' expanded' : ''}${isAffectedByScenario ? ' scenario-affected' : ''}" data-cp-id="${escapeHtml(cp.name)}" style="cursor:pointer${isAffectedByScenario ? ';border-left:3px solid #dc2626' : ''}">
          <div class="trade-restriction-header" role="button" tabindex="0" aria-expanded="${expanded ? 'true' : 'false'}">
            <span class="trade-country">${escapeHtml(cp.name)}</span>
            <span class="sc-status-dot ${statusDot}"></span>
            ${badgeHtml}
            <span class="trade-status ${statusClass}">${escapeHtml(cp.status)}</span>
          </div>
          <div class="trade-restriction-body">
            ${isAffectedByScenario && scenarioResult?.template ? `<div class="sc-metric-row" style="white-space:normal;background:#7f1d1d22;padding:4px 6px;border-radius:3px;margin-bottom:4px;font-size:calc(11px * var(--wm-panel-effective-scale, 1))">
              <span style="color:#fca5a5;font-weight:600">\u26A0 Projected under scenario: ${scenarioResult.template.disruptionPct}% closure for ${scenarioResult.template.durationDays} days${scenarioResult.template.costShockMultiplier > 1 ? ` (+${Math.round((scenarioResult.template.costShockMultiplier - 1) * 100)}% cost)` : ''}</span>
            </div>` : ''}
            <div class="sc-metric-row"${sourceMetrics || cp.directions?.length ? '' : ' hidden'}>
              ${sourceMetrics ? `<span>${sourceMetrics}</span>` : ''}
              ${cp.directions?.length ? `<span>${cp.directions.map(d => escapeHtml(d)).join('/')}</span>` : ''}
            </div>
            ${ts && ts.dataAvailable === false ? `<div class="sc-metric-row" style="opacity:0.5;font-size:calc(11px * var(--wm-panel-effective-scale, 1))"><span>${t('components.supplyChain.transitDataUnavailable') || 'Transit data unavailable (upstream partial)'}</span></div>` : ''}
            ${ts && ts.dataAvailable !== false && (hasTransitCount || hasWow || disruptPct > 0) ? `<div class="sc-metric-row">
              ${hasTransitCount ? `<span>${ts.todayTotal} ${t('components.supplyChain.vessels')}</span>` : ''}
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
                ? ` <span style="background:#ea580c;color:#fff;font-size:calc(9px * var(--wm-panel-effective-scale, 1));padding:1px 5px;border-radius:3px;margin-left:4px">&#9888; ${escapeHtml(fe.hazardAlertName.toUpperCase())}</span>`
                : '';
              return `<div class="sc-metric-row" style="color:${flowColor}">
                <span>~${fe.currentMbd} mb/d <span style="opacity:0.7">(${pct}% of ${fe.baselineMbd} baseline)</span>${hazardBadge}</span>
              </div>`;
            })() : FLOW_SUPPORTED_IDS.has(cp.id) ? `<div class="sc-metric-row" style="color:var(--text-dim,#888);font-size:calc(11px * var(--wm-panel-effective-scale, 1));opacity:0.7">
                <span>${t('components.supplyChain.flowUnavailable')}</span>
              </div>` : ''}
            ${cp.description ? `<div class="trade-description">${escapeHtml(cp.description)}</div>` : ''}
            <div class="trade-affected">${cp.affectedRoutes.slice(0, 3).map(r => escapeHtml(r)).join(', ')}</div>
            ${chartPlaceholder}
            ${bypassSection}
            ${scenarioSection}
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
      const hasTransitCount = hasPublishedTransitCount(ts);
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
        <td>${hasTransitCount && ts ? ts.todayTotal : '-'}</td>
        <td>${wowCell}</td>
        <td><span class="${disruptClass}">${disruptPct > 0 ? disruptPct.toFixed(1) + '%' : '-'}</span></td>
        <td>${riskClass ? `<span class="${riskClass}">${escapeHtml(riskLevel)}</span>` : escapeHtml(riskLevel)}</td>
      </tr>`;
    }).join('');

    return `<div style="margin-bottom:8px">
      <div class="trade-sector" style="font-weight:600;margin-bottom:4px">${t('components.supplyChain.corridorDisruption')}</div>
      <table class="sc-disruption-table">
        <thead><tr>
          <th scope="col">${t('components.supplyChain.corridor')}</th>
          <th scope="col">${t('components.supplyChain.vessels')}</th>
          <th scope="col">${t('components.supplyChain.wowChange')}</th>
          <th scope="col">${t('components.supplyChain.disruption')}</th>
          <th scope="col">${t('components.supplyChain.risk')}</th>
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
        <span style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em">Composite Stress Score</span>
        <span style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));font-weight:700;padding:2px 7px;border-radius:3px;background:${gaugeBg};color:${levelColor}">${escapeHtml(stressLevel.toUpperCase())}</span>
      </div>
      <div style="position:relative;height:6px;border-radius:3px;background:rgba(255,255,255,0.08)">
        <div style="position:absolute;left:0;top:0;height:100%;width:${gaugeWidth}%;border-radius:3px;background:${levelColor};transition:width 0.4s"></div>
      </div>
      <div style="text-align:right;font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim);margin-top:2px">${stressScore.toFixed(1)}/100</div>
    </div>`;

    const rows = carriers.map(c => {
      const changeClass = c.changePct >= 0 ? 'change-positive' : 'change-negative';
      const arrow = c.changePct >= 0 ? '▲' : '▼';
      const typeLabel = c.carrierType === 'etf' ? 'ETF' : c.carrierType === 'index' ? 'IDX' : 'CARR';
      const spark = c.sparkline?.length >= 2 ? this.renderSparkline(c.sparkline) : '';
      return `<div class="trade-restriction-card">
        <div class="trade-restriction-header">
          <span class="trade-country" style="font-size:calc(11px * var(--wm-panel-effective-scale, 1))">${escapeHtml(c.symbol)}</span>
          <span style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));padding:1px 5px;border-radius:2px;background:rgba(255,255,255,0.06);color:var(--text-dim)">${typeLabel}</span>
          <span class="trade-badge">${c.price.toFixed(2)}</span>
          <span class="trade-flow-change ${changeClass}">${arrow} ${Math.abs(c.changePct).toFixed(2)}%</span>
        </div>
        <div class="trade-restriction-body" style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:var(--text-dim)">${escapeHtml(c.name)}${spark}</div>
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
      <text x="0" y="${totalH - 1}" fill="var(--text-dim,#888)" style="font-size:calc(9px * var(--wm-panel-effective-scale, 1))" text-anchor="start">${escapeHtml(dates[0]!.slice(0, 7))}</text>
      <text x="${w}" y="${totalH - 1}" fill="var(--text-dim,#888)" style="font-size:calc(9px * var(--wm-panel-effective-scale, 1))" text-anchor="end">${escapeHtml(dates[dates.length - 1]!.slice(0, 7))}</text>
    ` : '';

    return `<svg width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}" style="display:block;margin:4px 0">
      <polyline points="${points}" fill="none" stroke="var(--accent-primary, #4fc3f7)" stroke-width="1.5" />
      ${dateLabels}
    </svg>`;
  }

  private renderMinerals(): string {
    const production = this.mineralProductionData;
    if (production?.commodities?.length) {
      const stage = this.mineralsStage;
      const rows = production.commodities.map((item) => {
        const snap = stage === 'refinery' ? item.refinery : item.mine;
        if (!snap) {
          return `<tr>
            <td>${escapeHtml(item.commodity)}</td>
            <td colspan="2">${escapeHtml(t('components.supplyChain.stageUnavailable'))}</td>
          </tr>`;
        }
        // `residual` is the USGS "Other countries" bucket -- an aggregate, not a
        // producer. Without this it outranks real countries and occupies a named
        // slot (copper mine renders it 3rd at 13%, displacing Peru).
        const top3 = snap.countries.filter((c) => !c.withheld && !c.residual && c.share != null).slice(0, 3)
          .map((p) => `${escapeHtml(p.country)} ${(p.share ?? 0).toFixed(0)}%`)
          .join(', ');
        const residual = snap.countries.find((c) => c.residual && c.share != null);
        // Uses the upstream label ("Other countries") rather than a new i18n key,
        // matching the untranslated country names already rendered in this table.
        const residualNote = residual
          ? ` <span class="sc-mineral-residual">+${(residual.share ?? 0).toFixed(0)}% ${escapeHtml(residual.country || 'other')}</span>`
          : '';
        const withheld = snap.withheldCount > 0
          ? ` <span class="sc-risk-moderate">${escapeHtml(t('components.supplyChain.withheldNote'))}</span>`
          : '';
        // Each commodity-stage picks its own year, so a BGS-filled commodity can
        // be years older than the caption's global max. Label the row when it
        // differs rather than letting the caption imply one vintage for all.
        const rowYear = snap.year && snap.year !== production.dataYear
          ? ` <span class="sc-mineral-vintage">(${escapeHtml(String(snap.year))})</span>`
          : '';
        return `<tr>
          <td>${escapeHtml(item.commodity)}${rowYear}</td>
          <td>${top3 || '—'}${residualNote}${withheld}</td>
          <td>${snap.hhi.toFixed(0)}</td>
        </tr>`;
      }).join('');
      const year = production.dataYear ? String(production.dataYear) : '';
      return `<div class="trade-tariffs-table">
        <div class="panel-tabs" style="margin-bottom:8px">
          <button class="panel-tab ${stage === 'mine' ? 'active' : ''}" data-mineral-stage="mine">${t('components.supplyChain.mineStage')}</button>
          <button class="panel-tab ${stage === 'refinery' ? 'active' : ''}" data-mineral-stage="refinery">${t('components.supplyChain.refineryStage')}</button>
        </div>
        <p class="sc-mineral-caption">${t('components.supplyChain.productionCaption')}${year ? ` (${escapeHtml(year)})` : ''}</p>
        <table>
          <thead>
            <tr>
              <th scope="col">${t('components.supplyChain.mineral')}</th>
              <th scope="col">${t('components.supplyChain.topProducers')}</th>
              <th scope="col">HHI</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

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

    // Reached whenever the production snapshot is absent — for a free viewer
    // that is now the steady state, because the mine/refinery shares are Pro
    // (#6439) and the loader skips the fetch. The free deposits table above is
    // a genuine fallback, not an error, so the only addition is a line naming
    // what the upgrade buys.
    const productionUpsell = hasPremiumAccess(getAuthState())
      ? ''
      : `<p class="sc-mineral-caption">${escapeHtml(t('components.supplyChain.productionProLocked'))}</p>`;

    return `<div class="trade-tariffs-table">
      <table>
        <thead>
          <tr>
            <th scope="col">${t('components.supplyChain.mineral')}</th>
            <th scope="col">${t('components.supplyChain.topProducers')}</th>
            <th scope="col">HHI</th>
            <th scope="col">${t('components.supplyChain.risk')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${productionUpsell}
    </div>`;
  }

  // ─── Scenario banner ─────────────────────────────────────────────────────────

  /**
   * Activate a scenario: set state and trigger a full re-render. Re-rendering
   * is required so renderChokepoints() sees the new activeScenarioState and
   * paints the projected score + red border on affected chokepoint cards —
   * prior code only mutated the banner DOM, leaving cards stale until an
   * unrelated update forced a re-render.
   */
  public showScenarioSummary(scenarioId: string, result: ScenarioResult): void {
    this.activeScenarioState = { scenarioId, result };
    this.render();
  }

  /**
   * Build the banner DOM from activeScenarioState and prepend it. Called
   * from render() after setContent() wipes inner HTML. Kept private so no
   * caller mutates banner-only state without triggering a full re-render.
   */
  private renderScenarioBanner(): void {
    const state = this.activeScenarioState;
    if (!state) return;
    const { scenarioId, result } = state;
    this.content.querySelector('.sc-scenario-banner')?.remove();
    const top5 = result.topImpactCountries.slice(0, 5);
    // impactPct is already a 0–100 integer from the scenario-worker
    // (scripts/scenario-worker.mjs: `Math.min(Math.round((totalImpact / maxImpact) * 100), 100)`).
    // A country whose requested evidence was only partly available carries a lower-bound
    // subtotal, not its impact \u2014 mark it inline so the number is not read as low exposure.
    const countriesHtml = top5.map(c => {
      const partial = c.partialEvidence === true;
      const suffix = partial
        ? ` <span class="sc-scenario-partial" title="${escapeHtml(`Only ${c.evaluatedRecords ?? 0} of ${c.requestedRecords ?? 0} requested country/sector records were available; this is a lower bound, not low exposure.`)}">(partial evidence)</span>`
        : '';
      return `<div class="sc-scenario-country"><span class="sc-scenario-country-code">${escapeHtml(c.iso2)}</span><div><strong>${partial ? '\u2265' : ''}${c.totalImpact.toFixed(2)} score units</strong><span class="sc-scenario-relative">${c.impactPct.toFixed(0)}% relative ${suffix}</span></div></div>`;
    }).join('');
    const banner = document.createElement('div');
    banner.className = 'sc-scenario-banner';
    const scenarioName = SCENARIO_TEMPLATES.find(tmpl => tmpl.id === scenarioId)?.name ?? scenarioId.replace(/-/g, ' ');

    // Surface the scenario's defining parameters — before this, users saw only
    // a list of country percentages with no context for what "100% impact"
    // actually meant (100% of what? over how long?). The template fields
    // (durationDays, disruptionPct, costShockMultiplier) come from the scenario
    // worker's result.template — optional field, defaults hide cleanly if absent.
    const tpl = result.template;
    const paramsHtml = tpl ? `<dl class="sc-scenario-metrics">
      <div><dt>Closure</dt><dd aria-label="${tpl.disruptionPct}% closure">${tpl.disruptionPct}%<small>${result.affectedChokepointIds.length} chokepoint${result.affectedChokepointIds.length === 1 ? '' : 's'}</small></dd></div>
      <div><dt>Duration</dt><dd>${tpl.durationDays} days<small>descriptive only</small></dd></div>
      <div><dt>Cost multiplier</dt><dd>${tpl.costShockMultiplier.toFixed(2)}×<small>modeled freight cost</small></dd></div>
    </dl>` : '';
    const mapSummary = tpl?.disruptionPct === 0
      ? 'No physical route disruption is highlighted.'
      : 'Map highlights disrupted routes.';

    const coverage = result.coverage;
    const records = coverage?.records ?? [];
    const count = (state: string) => records.filter(r => r.state === state).length;
    // "could not be read" rather than naming the producer: this branch also covers a
    // manifest the status handler rejected, which is not the seeder's fault.
    const coverageKnown = coverage && coverage.status !== 'unknown';
    const coverageText = !coverageKnown
      ? 'Unknown coverage: the country/sector manifest could not be read for this run. No broad exposure conclusion is supported.'
      : `${coverage.status === 'complete' ? 'Complete within seeded scope' : 'Partial coverage'}: ${count('evaluated')}/${records.length} country/sector records evaluated`;
    const coverageCounts = [
      [count('missing'), 'missing'], [count('malformed'), 'malformed'],
      [count('incomplete_routes'), 'incomplete routes'], [count('not_seeded'), 'not seeded'],
      [records.filter(r => r.basis === 'flow_weighted').length, 'flow-weighted'],
      [records.filter(r => r.basis === 'country_route_fallback').length, 'geographic fallback'],
      [records.filter(r => r.rawImpact === 0).length, 'valid zero impacts'],
    ] as const;
    const coverageCountsHtml = coverageKnown ? coverageCounts.filter(([total]) => total > 0)
      .map(([total, label]) => `<span>${total} ${label}</span>`).join('') : '';

    setTrustedHtml(banner, trustedHtml([
      `<div class="sc-scenario-top"><div class="sc-scenario-heading">`,
      `<span class="sc-scenario-section-label">Scenario result</span>`,
      `<h3 class="sc-scenario-name">${escapeHtml(scenarioName)}</h3>`,
      `<span class="sc-scenario-scope">Country scope: ${escapeHtml(result.scopedIso2 || 'All seeded countries')}</span></div>`,
      `<button class="sc-scenario-dismiss" aria-label="Dismiss scenario">\u00D7</button></div>`,
      paramsHtml,
      countriesHtml ? `<div class="sc-scenario-countries">${countriesHtml}</div>` : '',
      `<div class="sc-scenario-coverage-block"><span class="sc-scenario-section-label">Evidence coverage</span>`,
      `<p class="sc-scenario-coverage">${escapeHtml(coverageText)}</p>`,
      coverageCountsHtml ? `<div class="sc-scenario-coverage-counts">${coverageCountsHtml}</div>` : '',
      `</div>`,
      `<details class="sc-scenario-evidence"><summary>Country/sector evidence <span>${records.length} records</span></summary><ul></ul></details>`,
      `<div class="sc-scenario-footer"><p class="sc-scenario-hint">Raw impact is a modeled relative score, not currency or lost trade. Duration does not change the score. ${mapSummary}</p>`,
      `<button class="sc-scenario-export">Download scenario JSON</button></div>`,
    ].join(''), "scenario result presentation"));
    const evidenceDetails = banner.querySelector('details')!;
    evidenceDetails.addEventListener('toggle', () => {
      const list = evidenceDetails.querySelector('ul')!;
      if (evidenceDetails.open && !list.childElementCount) {
        const details = records.map(r => `<li>${escapeHtml(r.iso2)} / HS ${escapeHtml(r.hs2)}: ${escapeHtml(r.state.replace(/_/g, ' '))}${r.basis ? `, ${r.basis === 'flow_weighted' ? 'flow-weighted' : 'geographic fallback'}` : ''}${r.rawImpact !== undefined ? `, ${r.rawImpact.toFixed(2)} score units` : ''}. Cache date: ${escapeHtml(r.fetchedAt || 'unknown')}; trade observation date: unknown.</li>`).join('');
        setTrustedHtml(list, trustedHtml(details, 'scenario evidence requested by user'));
      }
    });
    banner.querySelector('.sc-scenario-export')!.addEventListener('click', () => {
      const exported = { scenarioId, result, units: 'relative score units, not currency or lost trade', durationBasis: 'descriptive only', observationDate: 'unknown', source: 'HS2 chokepoint exposure model; flow_weighted uses recorded Comtrade shares with modeled routes; country_route_fallback uses geography' };
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `scenario-${scenarioId}-${result.scopedIso2 || 'all'}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    banner.querySelector('.sc-scenario-dismiss')!.addEventListener('click', () => this.onDismissScenario?.());
    this.content.prepend(banner);
  }

  /**
   * Dismiss the active scenario: clear state and trigger a full re-render.
   * Re-rendering strips the projected score / red border / callout from
   * affected chokepoint cards, and the fresh card template resets the
   * Simulate Closure button text by construction — no manual button loop
   * needed.
   */
  public hideScenarioSummary(): void {
    this.activeScenarioState = null;
    this.render();
  }

  public setOnDismissScenario(cb: () => void): void {
    this.onDismissScenario = cb;
  }

  public setOnScenarioActivate(cb: (scenarioId: string, result: ScenarioResult) => void): void {
    this.onScenarioActivate = cb;
  }

  private async runScenario(trigger: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    if (btn.dataset.gated === '1') {
      trackGateHit('scenario-engine');
      return;
    }
    // Read and validate BEFORE touching the shared controller: bailing on an invalid
    // severity must not cancel a scenario that is already running.
    const scenarioId = trigger.dataset.scenarioId!;
    const severityInput = trigger.querySelector<HTMLInputElement>('.sc-scenario-severity')!;
    if (!severityInput.value || !severityInput.reportValidity()) return;
    const iso2 = trigger.querySelector<HTMLSelectElement>('.sc-scenario-country-select')!.value;
    const disruptionPct = Number(severityInput.value);

    this.scenarioPollController?.abort();
    for (const [id, state] of this.scenarioRunState) {
      if (state === 'running') this.scenarioRunState.delete(id);
    }
    const controller = new AbortController();
    this.scenarioPollController = controller;
    const { signal } = controller;
    // In-flight state goes through the render model, never onto the DOM node. An
    // imperative `btn.disabled = true` desyncs Panel's committed-HTML snapshot, and the
    // next render that produces identical HTML short-circuits and can never repair it.
    this.setScenarioRunState(scenarioId, 'running');

    // Guarantee the button never stays stuck at "Computing…" regardless of
    // exit path. Prior logic early-returned on `signal.aborted` and
    // `!this.content.isConnected` without ever re-enabling the button, and
    // swallowed AbortError in the catch block. When the scenario-worker is
    // down (no result key written in 24h), the polling loop DID fire a
    // timeout but the abort paths above it leaked the stuck state.
    // Ownership check: a cancelled run must not re-enable a button that a NEWER run
    // now owns. The poll loop's 1s sleep is not abort-aware, so a second run can start
    // inside that window; without this guard the loser's exit path would relabel the
    // winner's button back to "Simulate Closure" and let the user queue a duplicate run.
    const resetButton = (label: 'idle' | 'error') => {
      if (this.scenarioPollController !== controller) return;
      this.setScenarioRunState(scenarioId, label);
    };
    try {
      // Hard timeout on POST /run so a hanging edge function can't leave
      // the button in "Computing…" indefinitely.
      const runSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const runResp = await runScenario({ scenarioId, iso2, disruptionPct }, { signal: runSignal });
      const jobId = runResp.jobId;
      let result: ScenarioResult | null = null;
      // 60 × 1s = 60s max (worker typically completes in <1s). 1s poll keeps
      // the perceived latency <2s in the common case. First iteration polls
      // immediately (no sleep) in case the worker was already running on a
      // previous job and blocked here only because of network round-trip.
      for (let i = 0; i < 60; i++) {
        if (signal.aborted) { resetButton('idle'); return; }
        if (!this.content.isConnected) return; // panel gone — nothing to update
        if (i > 0) await new Promise(r => setTimeout(r, 1000));
        const status = await getScenarioStatus(jobId, { signal });
        if (status.status === 'done') {
          const r = status.result;
          if (!r || !Array.isArray(r.topImpactCountries)) throw new Error('done without valid result');
          result = r;
          break;
        }
        if (status.status === 'failed') throw new Error('Scenario failed');
      }
      if (!result) throw new Error('Timeout — scenario worker may be down');
      if (signal.aborted) { resetButton('idle'); return; }
      if (!this.content.isConnected) return;
      // After this callback fires, showScenarioSummary() → render() will rebuild
      // the scenario-trigger DOM with the button already in its "Active" +
      // disabled state (driven by activeScenarioState in renderChokepoints()).
      // Do NOT touch the captured btn reference here — it's about to be detached
      // by render()'s setContent(), and any imperative update would no-op
      // silently while the fresh button shows the wrong state.
      this.scenarioRunState.delete(scenarioId);
      this.onScenarioActivate?.(scenarioId, result);
    } catch (err) {
      // Abort from a new click = user-triggered retry, no error banner needed.
      if (err instanceof Error && err.name === 'AbortError') {
        resetButton('idle');
        return;
      }
      console.error('[scenario] run failed:', err);
      resetButton('error');
    }
  }
}
