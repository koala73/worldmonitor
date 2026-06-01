import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import type { UnhcrSummary, CountryDisplacement } from '@/services/displacement';
import { formatPopulation } from '@/services/displacement';
import { t } from '@/services/i18n';
import { renderFollowedOnlyChip, type FollowedOnlyChipHandle } from '@/utils/followed-only-chip';
import { isFollowed, subscribe as subscribeFollowed } from '@/services/followed-countries';
import { toIso2 } from '@/utils/country-codes';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


type DisplacementTab = 'origins' | 'hosts';

export class DisplacementPanel extends Panel {
  private data: UnhcrSummary | null = null;
  private activeTab: DisplacementTab = 'origins';
  private onCountryClick?: (lat: number, lon: number) => void;
  private followedOnlyChip: FollowedOnlyChipHandle | null = null;
  private followedOnlyHost: HTMLElement | null = null;
  private followedOnlyTeardown: (() => void) | null = null;
  private followedUnsub: (() => void) | null = null;

  constructor() {
    super({
      id: 'displacement',
      title: t('panels.displacement'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.displacement.infoTooltip'),
      defaultRowSpan: 2,
    });
    this.showLoading(t('common.loadingDisplacement'));

    this.content.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.panel-tab');
      if (tab?.dataset.tab) {
        this.activeTab = tab.dataset.tab as DisplacementTab;
        this.renderContent();
        return;
      }
      const row = (e.target as HTMLElement).closest<HTMLElement>('.disp-row');
      if (row) {
        const lat = Number(row.dataset.lat);
        const lon = Number(row.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onCountryClick?.(lat, lon);
      }
    });
    this.mountFollowedOnlyChip();
  }

  private mountFollowedOnlyChip(): void {
    const host = document.createElement('span');
    host.className = 'panel-header-followed-only-host';
    this.followedOnlyHost = host;
    this.followedOnlyChip = renderFollowedOnlyChip({
      panelId: 'displacement',
      onChange: () => {
        if (this.data) this.renderContent();
      },
    });
    if (this.followedOnlyChip.html === '') return;
    setTrustedHtml(host, trustedHtml(this.followedOnlyChip.html, "legacy direct innerHTML migration"));
    // Insert BEFORE the close button so close stays rightmost. The Panel
    // base appends `.panel-close-btn` first; a plain `appendChild` would
    // land the chip after close and break the user expectation that X
    // is always the last header control.
    const closeBtn = this.header.querySelector('.panel-close-btn');
    if (closeBtn) {
      this.header.insertBefore(host, closeBtn);
    } else {
      this.header.appendChild(host);
    }
    this.followedOnlyTeardown = this.followedOnlyChip.attach(host);
    // Re-filter on external watchlist change so a follow/unfollow from
    // another surface refreshes the displacement table immediately.
    this.followedUnsub = subscribeFollowed(() => {
      if (this.data) this.renderContent();
    });
  }

  public setCountryClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onCountryClick = handler;
  }

  public setData(data: UnhcrSummary): void {
    this.data = data;
    this.setCount(data.countries?.length ?? 0);
    this.renderContent();
  }

  private renderContent(): void {
    if (!this.data) return;

    const g = this.data.globalTotals;

    const stats = [
      { label: t('components.displacement.refugees'), value: formatPopulation(g.refugees), cls: 'disp-stat-refugees' },
      { label: t('components.displacement.asylumSeekers'), value: formatPopulation(g.asylumSeekers), cls: 'disp-stat-asylum' },
      { label: t('components.displacement.idps'), value: formatPopulation(g.idps), cls: 'disp-stat-idps' },
      { label: t('components.displacement.total'), value: formatPopulation(g.total), cls: 'disp-stat-total' },
    ];

    const statsHtml = stats.map(s =>
      `<div class="disp-stat-box ${s.cls}">
        <span class="disp-stat-value">${s.value}</span>
        <span class="disp-stat-label">${s.label}</span>
      </div>`
    ).join('');

    const tabsHtml = `
      <div class="panel-tabs" role="tablist" aria-label="Displacement data view">
        <button class="panel-tab ${this.activeTab === 'origins' ? 'active' : ''}" data-tab="origins" role="tab" aria-selected="${this.activeTab === 'origins'}" id="disp-tab-origins" aria-controls="disp-tab-panel">${t('components.displacement.origins')}</button>
        <button class="panel-tab ${this.activeTab === 'hosts' ? 'active' : ''}" data-tab="hosts" role="tab" aria-selected="${this.activeTab === 'hosts'}" id="disp-tab-hosts" aria-controls="disp-tab-panel">${t('components.displacement.hosts')}</button>
      </div>
    `;

    let countries: CountryDisplacement[];
    if (this.activeTab === 'origins') {
      countries = [...this.data.countries]
        .filter(c => c.refugees + c.asylumSeekers > 0)
        .sort((a, b) => (b.refugees + b.asylumSeekers) - (a.refugees + a.asylumSeekers));
    } else {
      countries = [...this.data.countries]
        .filter(c => (c.hostTotal || 0) > 0)
        .sort((a, b) => (b.hostTotal || 0) - (a.hostTotal || 0));
    }

    // U7 — "Followed only" filter chip. When active, drop rows whose
    // country code is not in the user's watchlist. Items without a
    // resolvable ISO-2 are dropped (we can't prove they belong to a
    // followed country).
    const followedOnlyActive = this.followedOnlyChip?.isActive() === true;
    if (followedOnlyActive) {
      countries = countries.filter(c => {
        const code = toIso2(c.code ?? '');
        return code ? isFollowed(code) : false;
      });
    }

    const displayed = countries.slice(0, 30);
    let tableHtml: string;

    if (displayed.length === 0) {
      const emptyMsg = followedOnlyActive
        ? 'No items in your followed countries. Add countries by tapping the star, or turn off this filter.'
        : t('common.noDataShort');
      tableHtml = `<div class="panel-empty">${escapeHtml(emptyMsg)}</div>`;
    } else {
      const rows = displayed.map(c => {
        const hostTotal = c.hostTotal || 0;
        const count = this.activeTab === 'origins' ? c.refugees + c.asylumSeekers : hostTotal;
        const total = this.activeTab === 'origins' ? c.totalDisplaced : hostTotal;
        const badgeCls = total >= 1_000_000 ? 'disp-crisis'
          : total >= 500_000 ? 'disp-high'
            : total >= 100_000 ? 'disp-elevated'
              : '';
        const badgeLabel = total >= 1_000_000 ? t('components.displacement.badges.crisis')
          : total >= 500_000 ? t('components.displacement.badges.high')
            : total >= 100_000 ? t('components.displacement.badges.elevated')
              : '';
        const badgeHtml = badgeLabel
          ? `<span class="disp-badge ${badgeCls}">${badgeLabel}</span>`
          : '';

        return `<tr class="disp-row" data-lat="${c.lat || ''}" data-lon="${c.lon || ''}">
          <td class="disp-name">${escapeHtml(c.name)}</td>
          <td class="disp-status">${badgeHtml}</td>
          <td class="disp-count">${formatPopulation(count)}</td>
        </tr>`;
      }).join('');

      tableHtml = `
        <table class="disp-table">
          <thead>
            <tr>
              <th>${t('components.displacement.country')}</th>
              <th>${t('components.displacement.status')}</th>
              <th>${t('components.displacement.count')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    this.setSafeContent(unsafeRawHtml(`
      <div class="disp-panel-content">
        <div class="disp-stats-grid">${statsHtml}</div>
        ${tabsHtml}
        <div id="disp-tab-panel" role="tabpanel" aria-labelledby="disp-tab-${this.activeTab}">
          ${tableHtml}
        </div>
      </div>
    `, 'legacy Panel.setContent() migration'));
  }

  public override destroy(): void {
    if (this.followedOnlyTeardown) {
      try {
        this.followedOnlyTeardown();
      } catch {
        /* swallow */
      }
      this.followedOnlyTeardown = null;
    }
    if (this.followedUnsub) {
      try {
        this.followedUnsub();
      } catch {
        /* swallow */
      }
      this.followedUnsub = null;
    }
    if (this.followedOnlyHost && this.followedOnlyHost.parentElement) {
      this.followedOnlyHost.parentElement.removeChild(this.followedOnlyHost);
    }
    this.followedOnlyHost = null;
    this.followedOnlyChip = null;
    super.destroy();
  }
}
