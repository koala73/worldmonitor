import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import type { GivingSummary, PlatformGiving, CategoryBreakdown } from '@/services/giving';
import { formatCurrency, formatPercent, getActivityColor, getTrendIcon, getTrendColor } from '@/services/giving';
import { t } from '@/services/i18n';

type GivingTab = 'platforms' | 'categories' | 'crypto' | 'institutional';

export class GivingPanel extends Panel {
  private data: GivingSummary | null = null;
  private activeTab: GivingTab = 'platforms';

  constructor() {
    super({
      id: 'giving',
      title: t('panels.giving'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.giving.infoTooltip'),
    });
    this.showLoading(t('common.loadingGiving'));
  }

  public setData(data: GivingSummary): void {
    this.data = data;
    this.setCount(data.platforms.length);
    this.renderContent();
  }

  private renderContent(): void {
    if (!this.data) return;

    const d = this.data;
    const trendIcon = getTrendIcon(d.trend);
    const trendColor = getTrendColor(d.trend);
    const indexColor = getActivityColor(d.activityIndex);

    // Activity Index + summary stats
    const statsHtml = `
      <div class="giving-stat-box giving-stat-index">
        <span class="giving-stat-value" style="color: ${indexColor}">${d.activityIndex}</span>
        <span class="giving-stat-label">${t('components.giving.activityIndex')}</span>
      </div>
      <div class="giving-stat-box giving-stat-trend">
        <span class="giving-stat-value" style="color: ${trendColor}">${trendIcon} ${escapeHtml(d.trend)}</span>
        <span class="giving-stat-label">${t('components.giving.trend')}</span>
      </div>
      <div class="giving-stat-box giving-stat-daily">
        <span class="giving-stat-value">${formatCurrency(d.estimatedDailyFlowUsd)}</span>
        <span class="giving-stat-label">${t('components.giving.estDailyFlow')}</span>
      </div>
      <div class="giving-stat-box giving-stat-crypto">
        <span class="giving-stat-value">${formatCurrency(d.crypto.dailyInflowUsd)}</span>
        <span class="giving-stat-label">${t('components.giving.cryptoDaily')}</span>
      </div>
    `;

    // Tabs
    const tabs: GivingTab[] = ['platforms', 'categories', 'crypto', 'institutional'];
    const tabLabels: Record<GivingTab, string> = {
      platforms: t('components.giving.tabs.platforms'),
      categories: t('components.giving.tabs.categories'),
      crypto: t('components.giving.tabs.crypto'),
      institutional: t('components.giving.tabs.institutional'),
    };
    const tabsHtml = `
      <div class="giving-tabs">
        ${tabs.map(tab => `<button class="giving-tab ${this.activeTab === tab ? 'giving-tab-active' : ''}" data-tab="${tab}">${tabLabels[tab]}</button>`).join('')}
      </div>
    `;

    // Tab content
    let contentHtml: string;
    switch (this.activeTab) {
      case 'platforms':
        contentHtml = this.renderPlatforms(d.platforms);
        break;
      case 'categories':
        contentHtml = this.renderCategories(d.categories);
        break;
      case 'crypto':
        contentHtml = this.renderCrypto();
        break;
      case 'institutional':
        contentHtml = this.renderInstitutional();
        break;
    }

    this.setContent(`
      <div class="giving-panel-content">
        <div class="giving-stats-grid">${statsHtml}</div>
        ${tabsHtml}
        ${contentHtml}
      </div>
    `);

    // Attach tab click listeners
    this.content.querySelectorAll('.giving-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeTab = (btn as HTMLElement).dataset.tab as GivingTab;
        this.renderContent();
      });
    });
  }

  private renderPlatforms(platforms: PlatformGiving[]): string {
    if (platforms.length === 0) {
      return `<div class="panel-empty">${t('common.noDataShort')}</div>`;
    }

    const rows = platforms.map(p => {
      const freshnessCls = p.dataFreshness === 'live' ? 'giving-fresh-live'
        : p.dataFreshness === 'daily' ? 'giving-fresh-daily'
          : p.dataFreshness === 'weekly' ? 'giving-fresh-weekly'
            : 'giving-fresh-annual';

      return `<tr class="giving-row">
        <td class="giving-platform-name">${escapeHtml(p.platform)}</td>
        <td class="giving-platform-vol">${formatCurrency(p.dailyVolumeUsd)}</td>
        <td class="giving-platform-vel">${p.donationVelocity > 0 ? `${p.donationVelocity.toFixed(0)}/hr` : '\u2014'}</td>
        <td class="giving-platform-fresh"><span class="giving-fresh-badge ${freshnessCls}">${escapeHtml(p.dataFreshness)}</span></td>
      </tr>`;
    }).join('');

    return `
      <table class="giving-table">
        <thead>
          <tr>
            <th>${t('components.giving.platform')}</th>
            <th>${t('components.giving.dailyVol')}</th>
            <th>${t('components.giving.velocity')}</th>
            <th>${t('components.giving.freshness')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  private renderCategories(categories: CategoryBreakdown[]): string {
    if (categories.length === 0) {
      return `<div class="panel-empty">${t('common.noDataShort')}</div>`;
    }

    const rows = categories.map(c => {
      const barWidth = Math.round(c.share * 100);
      const trendingBadge = c.trending ? `<span class="giving-trending-badge">${t('components.giving.trending')}</span>` : '';

      return `<tr class="giving-row">
        <td class="giving-cat-name">${escapeHtml(c.category)} ${trendingBadge}</td>
        <td class="giving-cat-share">
          <div class="giving-share-bar">
            <div class="giving-share-fill" style="width: ${barWidth}%"></div>
          </div>
          <span class="giving-share-label">${formatPercent(c.share)}</span>
        </td>
      </tr>`;
    }).join('');

    return `
      <table class="giving-table giving-cat-table">
        <thead>
          <tr>
            <th>${t('components.giving.category')}</th>
            <th>${t('components.giving.share')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  private renderCrypto(): string {
    if (!this.data?.crypto) {
      return `<div class="panel-empty">${t('common.noDataShort')}</div>`;
    }
    const c = this.data.crypto;

    return `
      <div class="giving-crypto-content">
        <div class="giving-crypto-stats">
          <div class="giving-stat-box">
            <span class="giving-stat-value">${formatCurrency(c.dailyInflowUsd)}</span>
            <span class="giving-stat-label">${t('components.giving.dailyInflow')}</span>
          </div>
          <div class="giving-stat-box">
            <span class="giving-stat-value">${c.trackedWallets}</span>
            <span class="giving-stat-label">${t('components.giving.wallets')}</span>
          </div>
          <div class="giving-stat-box">
            <span class="giving-stat-value">${formatPercent(c.pctOfTotal / 100)}</span>
            <span class="giving-stat-label">${t('components.giving.ofTotal')}</span>
          </div>
        </div>
        <div class="giving-crypto-receivers">
          <div class="giving-section-title">${t('components.giving.topReceivers')}</div>
          <ul class="giving-receiver-list">
            ${c.topReceivers.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
          </ul>
        </div>
      </div>`;
  }

  private renderInstitutional(): string {
    if (!this.data?.institutional) {
      return `<div class="panel-empty">${t('common.noDataShort')}</div>`;
    }
    const inst = this.data.institutional;

    return `
      <div class="giving-inst-content">
        <div class="giving-inst-grid">
          <div class="giving-stat-box">
            <span class="giving-stat-value">$${inst.oecdOdaAnnualUsdBn.toFixed(1)}B</span>
            <span class="giving-stat-label">${t('components.giving.oecdOda')} (${inst.oecdDataYear})</span>
          </div>
          <div class="giving-stat-box">
            <span class="giving-stat-value">${inst.cafWorldGivingIndex}%</span>
            <span class="giving-stat-label">${t('components.giving.cafIndex')} (${inst.cafDataYear})</span>
          </div>
          <div class="giving-stat-box">
            <span class="giving-stat-value">${inst.candidGrantsTracked >= 1_000_000 ? `${(inst.candidGrantsTracked / 1_000_000).toFixed(0)}M` : inst.candidGrantsTracked.toLocaleString()}</span>
            <span class="giving-stat-label">${t('components.giving.candidGrants')}</span>
          </div>
          <div class="giving-stat-box">
            <span class="giving-stat-value">${escapeHtml(inst.dataLag)}</span>
            <span class="giving-stat-label">${t('components.giving.dataLag')}</span>
          </div>
        </div>
      </div>`;
  }
}
