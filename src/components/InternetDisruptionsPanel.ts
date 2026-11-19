import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { h } from '@/utils/dom-utils';
import type { InternetOutage } from '@/types';
import type { ResolvedScope } from '@/services/tab-focus';
import { countryCodeFromName } from '@/services/scope-attribution';
import { PanelScopeFilter, focusedEmptyNode, scopeTagNode, type ScopeRow, type ScopeView } from './panel-scope-filter';
import type {
  ListInternetDdosAttacksResponse,
  TrafficAnomaly,
} from '@/generated/client/worldmonitor/infrastructure/v1/service_client';

type Tab = 'outages' | 'ddos' | 'anomalies';

export class InternetDisruptionsPanel extends Panel {
  private tab: Tab = 'outages';
  private outages: InternetOutage[] = [];
  private ddos: ListInternetDdosAttacksResponse | null = null;
  private anomalies: TrafficAnomaly[] = [];
  // Dashboard focus (#10453): only outages name a country (a Cloudflare Radar
  // name). The DDoS and Anomalies tabs are global and say so in the strip.
  private readonly scopeFilter: PanelScopeFilter;
  private hasData = false;

  constructor() {
    super({
      id: 'internet-disruptions',
      title: t('panels.internetDisruptions'),
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip: t('components.internetDisruptions.infoTooltip'),
    });
    this.scopeFilter = new PanelScopeFilter({ content: this.content, onChange: () => this.render() });
    this.content.addEventListener('click', (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (btn?.dataset.tab) {
        this.tab = btn.dataset.tab as Tab;
        this.render();
      }
    });
    this.showLoading();
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outages = outages;
    this.hasData = true;
    this.render();
  }

  public setDdos(data: ListInternetDdosAttacksResponse): void {
    this.ddos = data;
    this.hasData = true;
    this.render();
  }

  public setAnomalies(anomalies: TrafficAnomaly[]): void {
    this.anomalies = anomalies;
    this.hasData = true;
    this.render();
  }

  public override applyScope(scope: ResolvedScope | null): void {
    if (!this.scopeFilter.setScope(scope)) return;
    // The next successful delivery draws with the new focus; redrawing now
    // would erase the loading state or a load failure.
    if (this.hasData && !this.showingLoadFailure) this.render();
  }

  public override showLoading(message?: string): void {
    this.scopeFilter?.hideStrip();
    super.showLoading(message);
  }

  public override showError(message?: string, onRetry?: () => void, autoRetrySeconds?: number): void {
    this.scopeFilter.hideStrip();
    super.showError(message, onRetry, autoRetrySeconds);
  }

  protected render(): void {
    const view = this.scopeFilter.view(this.outages, (o) => countryCodeFromName(o.country));
    // The panel and Outages tab counts follow the focus; anomalies are global.
    this.setCount(view.rows.length + this.anomalies.length);
    if (this.tab !== 'outages') this.scopeFilter.renderStrip(null, t('focus.filter.tabNotFiltered'));
    else if (this.outages.length === 0) this.scopeFilter.hideStrip();
    else this.scopeFilter.renderStrip(view);
    const tabs = this.buildTabs(view.rows.length);
    const body = this.tab === 'outages'
      ? this.buildOutages(view)
      : this.tab === 'ddos'
        ? this.buildDdos()
        : this.buildAnomalies();
    // Route through the sanctioned helper (#6557). render() has four callers:
    // the three data setters (setOutages/setDdos/setAnomalies), each a proven
    // success, and the [data-tab] click listener bound in the constructor,
    // which is not. Clearing the error state on a tab click is harmless only
    // because showError() replaces this.content, so no tab button survives for
    // the user to click while the chip is set. If a retry callback is ever
    // wired to this panel, give the tab path a write that does not clear —
    // otherwise a click resets the backoff rung on a still-failing source.
    // applyScope and the focus strip also call render(); applyScope skips it
    // during a load failure and showError hides the strip.
    this.setContentNodes(tabs, body);
  }

  private buildTabs(outageCount: number): HTMLElement {
    const counts: Record<Tab, number> = {
      outages: outageCount,
      ddos: this.ddos ? (this.ddos.protocol.length + this.ddos.vector.length) : 0,
      anomalies: this.anomalies.length,
    };
    const labels: Record<Tab, string> = {
      outages: t('panels.internetDisruptionsTabs.outages'),
      ddos: t('panels.internetDisruptionsTabs.ddos'),
      anomalies: t('panels.internetDisruptionsTabs.anomalies'),
    };
    return h('div', { className: 'id-tabs' },
      ...(['outages', 'ddos', 'anomalies'] as Tab[]).map(tab =>
        h('button', {
          className: `id-tab-btn${this.tab === tab ? ' active' : ''}`,
          dataset: { tab },
        },
          labels[tab],
          counts[tab] > 0 ? h('span', { className: 'id-tab-count' }, String(counts[tab])) : false,
        ),
      ),
    );
  }

  // ── Tab: Outages ──────────────────────────────────────────────────────────

  private buildOutages(view: ScopeView<InternetOutage>): HTMLElement {
    if (!this.outages.length) {
      return h('div', { className: 'id-empty' }, t('components.internetDisruptions.noOutages'));
    }
    if (view.emptyByFocus) return focusedEmptyNode(t('focus.filter.emptyOutages'));
    // Chosen countries, then neighbours, then no-country rows; severity within each.
    const sorted = [...view.rows].sort((a, b) => {
      const order = { total: 0, major: 1, partial: 2 };
      return a.rank - b.rank || (order[a.item.severity] ?? 3) - (order[b.item.severity] ?? 3);
    });
    return h('div', { className: 'id-list' },
      ...sorted.map(row => this.buildOutageRow(row.item, row)),
    );
  }

  private buildOutageRow(o: InternetOutage, row?: ScopeRow<InternetOutage>): HTMLElement {
    const severityColor = o.severity === 'total' ? '#ff2020' : o.severity === 'major' ? '#ff8800' : '#ffcc00';
    const badge = o.severity === 'total' ? 'NATIONWIDE' : o.severity === 'major' ? 'REGIONAL' : 'PARTIAL';
    const ongoing = !o.endDate;
    return h('div', { className: 'id-row' },
      h('div', { className: 'id-row-header' },
        h('span', { className: 'id-severity-dot', style: { color: severityColor } }, '●'),
        h('span', { className: 'id-row-title' }, o.country),
        scopeTagNode(row),
        h('span', { className: `id-badge severity-${o.severity}` }, badge),
        ongoing ? h('span', { className: 'id-badge ongoing' }, '⚡ LIVE') : false,
      ),
      h('div', { className: 'id-row-sub' }, o.title),
      o.cause ? h('div', { className: 'id-row-meta' }, o.cause.replace(/_/g, ' ')) : false,
    );
  }

  // ── Tab: DDoS ─────────────────────────────────────────────────────────────

  private buildDdos(): HTMLElement {
    if (!this.ddos || (!this.ddos.protocol.length && !this.ddos.vector.length)) {
      return h('div', { className: 'id-empty' }, t('components.internetDisruptions.noDdos'));
    }
    const d = this.ddos;
    const dateRange = d.dateRangeStart
      ? `${this.formatDate(d.dateRangeStart)} – ${this.formatDate(d.dateRangeEnd)}`
      : '';

    return h('div', { className: 'id-ddos' },
      dateRange ? h('div', { className: 'id-date-range' }, dateRange) : false,

      d.protocol.length > 0
        ? h('div', { className: 'id-section' },
            h('div', { className: 'id-section-title' }, t('components.internetDisruptions.byProtocol')),
            ...d.protocol.slice(0, 6).map(e => this.buildBar(e.label, e.percentage, '#b400ff')),
          )
        : false,

      d.vector.length > 0
        ? h('div', { className: 'id-section' },
            h('div', { className: 'id-section-title' }, t('components.internetDisruptions.byVector')),
            ...d.vector.slice(0, 6).map(e => this.buildBar(e.label, e.percentage, '#ff4400')),
          )
        : false,

      d.topTargetLocations.length > 0
        ? h('div', { className: 'id-section' },
            h('div', { className: 'id-section-title' }, t('components.internetDisruptions.topTargets')),
            ...d.topTargetLocations.slice(0, 8).map(loc =>
              this.buildBar(loc.countryName || loc.countryCode, loc.percentage, '#cc0044'),
            ),
          )
        : false,
    );
  }

  private buildBar(label: string, pct: number, color: string): HTMLElement {
    return h('div', { className: 'id-bar-row' },
      h('span', { className: 'id-bar-label' }, label),
      h('div', { className: 'id-bar-track' },
        h('div', { className: 'id-bar-fill', style: { width: `${Math.min(pct, 100)}%`, background: color } }),
      ),
      h('span', { className: 'id-bar-pct' }, `${pct.toFixed(1)}%`),
    );
  }

  // ── Tab: Anomalies ────────────────────────────────────────────────────────

  private buildAnomalies(): HTMLElement {
    if (!this.anomalies.length) {
      return h('div', { className: 'id-empty' }, t('components.internetDisruptions.noAnomalies'));
    }
    const sorted = [...this.anomalies].sort((a, b) => {
      if (a.status === 'ONGOING' && b.status !== 'ONGOING') return -1;
      if (b.status === 'ONGOING' && a.status !== 'ONGOING') return 1;
      return (b.startDate ?? 0) - (a.startDate ?? 0);
    });
    return h('div', { className: 'id-list' },
      ...sorted.map(a => this.buildAnomalyRow(a)),
    );
  }

  private buildAnomalyRow(a: TrafficAnomaly): HTMLElement {
    const ongoing = a.status === 'ONGOING';
    const typeLabel = a.type.replace(/^ANOMALY_/, '');
    const location = a.locationName || a.locationCode || '';
    const asn = a.asnName ? `AS${a.asn} ${a.asnName}` : '';
    return h('div', { className: 'id-row' },
      h('div', { className: 'id-row-header' },
        h('span', { className: 'id-anomaly-type' }, typeLabel),
        location ? h('span', { className: 'id-row-title' }, location) : false,
        ongoing
          ? h('span', { className: 'id-badge ongoing' }, '⚡ ONGOING')
          : h('span', { className: 'id-badge historical' }, 'HISTORICAL'),
      ),
      asn ? h('div', { className: 'id-row-meta' }, asn) : false,
      a.startDate
        ? h('div', { className: 'id-row-meta' }, this.formatEpoch(a.startDate))
        : false,
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private formatDate(iso: string): string {
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
    catch { return iso; }
  }

  private formatEpoch(ms: number): string {
    try { return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }
}
