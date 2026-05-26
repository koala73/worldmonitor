import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';
import type { InternetOutage } from '@/types';
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

  constructor() {
    super({
      id: 'internet-disruptions',
      title: t('panels.internetDisruptions'),
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip: t('components.internetDisruptions.infoTooltip'),
    });
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
    this.updateCount();
    this.render();
  }

  public setDdos(data: ListInternetDdosAttacksResponse): void {
    this.ddos = data;
    this.render();
  }

  public setAnomalies(anomalies: TrafficAnomaly[]): void {
    this.anomalies = anomalies;
    this.updateCount();
    this.render();
  }

  private updateCount(): void {
    this.setCount(this.outages.length + this.anomalies.length);
  }

  protected render(): void {
    const tabs = this.buildTabs();
    const body = this.tab === 'outages'
      ? this.buildOutages()
      : this.tab === 'ddos'
        ? this.buildDdos()
        : this.buildAnomalies();
    replaceChildren(this.content, tabs, body);
  }

  private buildTabs(): HTMLElement {
    const counts: Record<Tab, number> = {
      outages: this.outages.length,
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

  private buildOutages(): HTMLElement {
    if (!this.outages.length) {
      return h('div', { className: 'id-empty' }, t('components.internetDisruptions.noOutages'));
    }
    const sorted = [...this.outages].sort((a, b) => {
      const order = { total: 0, major: 1, partial: 2 };
      return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
    });
    return h('div', { className: 'id-list' },
      ...sorted.map(o => this.buildOutageRow(o)),
    );
  }

  private buildOutageRow(o: InternetOutage): HTMLElement {
    const severityColor = o.severity === 'total' ? '#ff2020' : o.severity === 'major' ? '#ff8800' : '#ffcc00';
    const badge = o.severity === 'total' ? 'NATIONWIDE' : o.severity === 'major' ? 'REGIONAL' : 'PARTIAL';
    const ongoing = !o.endDate;
    return h('div', { className: 'id-row' },
      h('div', { className: 'id-row-header' },
        h('span', { className: 'id-severity-dot', style: { color: severityColor } }, '●'),
        h('span', { className: 'id-row-title' }, o.country),
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
