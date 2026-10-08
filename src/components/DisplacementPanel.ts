import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import type { UnhcrSummary, CountryDisplacement, CrossBorderData, CrossBorderSituation, InternalDisplacementData, InternalDisplacementOperation } from '@/services/displacement';
import { formatPopulation } from '@/services/displacement';
import { t } from '@/services/i18n';
import { renderFollowedOnlyChip, type FollowedOnlyChipHandle } from '@/utils/followed-only-chip';
import { isFollowed, subscribe as subscribeFollowed } from '@/services/followed-countries';
import { toIso2 } from '@/utils/country-codes';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { bindActivationKeys } from '@/utils/activation';


type DisplacementTab = 'origins' | 'hosts' | 'internal' | 'crossBorder';

export class DisplacementPanel extends Panel {
  private data: UnhcrSummary | null = null;
  private internalData: InternalDisplacementData | null = null;
  private crossBorderData: CrossBorderData | null = null;
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
      // An empty attribute means the row has no location; Number('') is 0.
      if (row?.dataset.lat && row.dataset.lon) {
        const lat = Number(row.dataset.lat);
        const lon = Number(row.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onCountryClick?.(lat, lon);
      }
    });
    this.mountFollowedOnlyChip();
    bindActivationKeys(this.content, '.disp-row');
  }

  private mountFollowedOnlyChip(): void {
    const host = document.createElement('span');
    host.className = 'panel-header-followed-only-host';
    this.followedOnlyHost = host;
    this.followedOnlyChip = renderFollowedOnlyChip({
      panelId: 'displacement',
      onChange: () => {
        this.renderContent();
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
      this.renderContent();
    });
  }

  protected override updateFreshnessBadge(): void {
    // The health mapping covers annual UNHCR, not the independent DTM/portal tabs.
    super.updateFreshnessBadge(this.activeTab === 'internal' || this.activeTab === 'crossBorder' ? null : undefined);
  }

  public setCountryClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onCountryClick = handler;
  }

  public setData(data: UnhcrSummary): void {
    this.data = data;
    this.setCount(data.countries?.length ?? 0);
    this.renderContent();
  }

  public setInternalData(data: InternalDisplacementData): void {
    this.internalData = data;
    this.renderContent();
  }

  public setCrossBorderData(data: CrossBorderData): void {
    this.crossBorderData = data;
    this.renderContent();
  }

  // Any one source counts: a later UNHCR failure must not replace DTM or portal tabs with an error.
  public hasData(): boolean {
    return this.data !== null || this.internalData !== null || this.crossBorderData !== null;
  }

  // UNHCR yearly data, IOM DTM and the UNHCR portal load independently; each
  // tab renders as soon as its own data is there.
  private renderContent(): void {
    const sources: { id: DisplacementTab; label: string; render?: () => string }[] = [];
    if (this.data) {
      sources.push({ id: 'origins', label: t('components.displacement.origins') });
      sources.push({ id: 'hosts', label: t('components.displacement.hosts') });
    }
    const internal = this.internalData;
    if (internal) {
      sources.push({ id: 'internal', label: t('components.displacement.internal'), render: () => this.renderInternalTable(internal.operations) });
    }
    const crossBorder = this.crossBorderData;
    if (crossBorder) {
      sources.push({ id: 'crossBorder', label: t('components.displacement.crossBorder'), render: () => this.renderCrossBorderTable(crossBorder.situations) });
    }
    if (sources.length === 0) return;
    if (!sources.some((source) => source.id === this.activeTab)) this.activeTab = sources[0]!.id;
    this.updateFreshnessBadge();

    const tabsHtml = `
      <div class="panel-tabs" role="tablist" aria-label="Displacement data view">
        ${sources.map((source) => `<button class="panel-tab ${this.activeTab === source.id ? 'active' : ''}" data-tab="${source.id}" role="tab" aria-selected="${this.activeTab === source.id}" id="disp-tab-${source.id}" aria-controls="disp-tab-panel">${source.label}</button>`).join('')}
      </div>
    `;
    const statsHtml = this.data ? this.renderStats(this.data) : '';
    const active = sources.find((source) => source.id === this.activeTab)!;
    const bodyHtml = active.render ? active.render() : this.renderUnhcrTable(this.data!);

    this.setSafeContent(unsafeRawHtml(`
      <div class="disp-panel-content">
        ${statsHtml ? `<div class="disp-stats-grid">${statsHtml}</div>` : ''}
        ${tabsHtml}
        <div id="disp-tab-panel" role="tabpanel" aria-labelledby="disp-tab-${this.activeTab}">
          ${bodyHtml}
        </div>
      </div>
    `, 'legacy Panel.setContent() migration'));
  }

  private renderStats(data: UnhcrSummary): string {
    const g = data.globalTotals;
    const stats = [
      { label: t('components.displacement.refugees'), value: formatPopulation(g.refugees), cls: 'disp-stat-refugees' },
      { label: t('components.displacement.asylumSeekers'), value: formatPopulation(g.asylumSeekers), cls: 'disp-stat-asylum' },
      { label: t('components.displacement.idps'), value: formatPopulation(g.idps), cls: 'disp-stat-idps' },
      { label: t('components.displacement.total'), value: formatPopulation(g.total), cls: 'disp-stat-total' },
    ];
    return stats.map(s =>
      `<div class="disp-stat-box ${s.cls}">
        <span class="disp-stat-value">${s.value}</span>
        <span class="disp-stat-label">${s.label}</span>
      </div>`
    ).join('');
  }

  private renderUnhcrTable(data: UnhcrSummary): string {
    let countries: CountryDisplacement[];
    if (this.activeTab === 'origins') {
      countries = [...data.countries]
        .filter(c => c.refugees + c.asylumSeekers > 0)
        .sort((a, b) => (b.refugees + b.asylumSeekers) - (a.refugees + a.asylumSeekers));
    } else {
      countries = [...data.countries]
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

        return `<tr class="disp-row" data-lat="${c.lat || ''}" data-lon="${c.lon || ''}" tabindex="0">
          <td class="disp-name">${escapeHtml(c.name)}</td>
          <td class="disp-status">${badgeHtml}</td>
          <td class="disp-count">${formatPopulation(count)}</td>
        </tr>`;
      }).join('');

      tableHtml = `
        <table class="disp-table">
          <thead>
            <tr>
              <th scope="col">${t('components.displacement.country')}</th>
              <th scope="col">${t('components.displacement.status')}</th>
              <th scope="col">${t('components.displacement.count')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }
    return tableHtml;
  }

  // One row per UNHCR situation. Situations overlap (Sudanese refugees in
  // Chad are also in the Sahel situation), so rows are never added up.
  private renderCrossBorderTable(allSituations: CrossBorderSituation[]): string {
    let situations = allSituations;
    const followedOnlyActive = this.followedOnlyChip?.isActive() === true;
    if (followedOnlyActive) {
      situations = situations.filter(s => s.countryCodes.some(code => isFollowed(code)));
    }
    if (situations.length === 0) {
      const emptyMsg = followedOnlyActive
        ? 'No items in your followed countries. Add countries by tapping the star, or turn off this filter.'
        : t('common.noDataShort');
      return `<div class="panel-empty">${escapeHtml(emptyMsg)}</div>`;
    }
    const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${formatPopulation(Math.abs(n))}`;
    const rows = situations.map(s => {
      let change = '—';
      let period = '';
      if (s.lastMonth) {
        change = signed(s.lastMonth.individuals);
        period = s.lastMonth.month;
      } else if (s.latestChange) {
        change = signed(s.latestChange.delta);
        period = s.latestChange.days ? t('components.displacement.inDays', { days: String(s.latestChange.days) }) : '';
      }
      const badge = s.accelerating ? ` <span class="disp-badge disp-crisis">${t('components.displacement.accelerating')}</span>` : '';
      const detail = [s.asOf, s.topCountries.join(', ')].filter(Boolean).join(' · ');
      return `<tr class="disp-row" data-lat="${s.lat ?? ''}" data-lon="${s.lon ?? ''}" tabindex="0">
          <td class="disp-name">${escapeHtml(s.name)}${badge}<div class="disp-operation">${escapeHtml(detail)}</div></td>
          <td class="disp-round">${escapeHtml(change)}${period ? `<div class="disp-operation">${escapeHtml(period)}</div>` : ''}</td>
          <td class="disp-count">${formatPopulation(s.total)}</td>
        </tr>`;
    }).join('');
    return `
        <table class="disp-table">
          <thead>
            <tr>
              <th scope="col">${t('components.displacement.situation')}</th>
              <th scope="col" class="disp-round">${t('components.displacement.latestChange')}</th>
              <th scope="col" class="disp-count">${t('components.displacement.total')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="disp-source-note">${escapeHtml(t('components.displacement.crossBorderNote'))}</div>`;
  }

  // One row per IOM DTM operation. Operations in a country can overlap, so
  // rows are never added up into a country total.
  private renderInternalTable(allOperations: InternalDisplacementOperation[]): string {
    let operations = allOperations;
    const followedOnlyActive = this.followedOnlyChip?.isActive() === true;
    if (followedOnlyActive) {
      operations = operations.filter(op => {
        const code = toIso2(op.countryCode ?? '');
        return code ? isFollowed(code) : false;
      });
    }
    if (operations.length === 0) {
      const emptyMsg = followedOnlyActive
        ? 'No items in your followed countries. Add countries by tapping the star, or turn off this filter.'
        : t('common.noDataShort');
      return `<div class="panel-empty">${escapeHtml(emptyMsg)}</div>`;
    }
    const rows = operations.slice(0, 40).map(op => `<tr class="disp-row" data-lat="${op.lat ?? ''}" data-lon="${op.lon ?? ''}" tabindex="0">
          <td class="disp-name">${escapeHtml(op.countryName)}<div class="disp-operation">${escapeHtml(op.operation)}</div></td>
          <td class="disp-round">${escapeHtml(op.reportingDate)}</td>
          <td class="disp-count">${formatPopulation(op.totalIdps)}</td>
        </tr>`).join('');
    return `
        <table class="disp-table">
          <thead>
            <tr>
              <th scope="col">${t('components.displacement.country')}</th>
              <th scope="col" class="disp-round">${t('components.displacement.latestRound')}</th>
              <th scope="col" class="disp-count">${t('components.displacement.idps')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="disp-source-note">${escapeHtml(t('components.displacement.internalNote'))}</div>`;
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
