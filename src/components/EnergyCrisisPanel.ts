import { Panel } from './Panel';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { getHydratedData } from '@/services/bootstrap';
import { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GetEnergyCrisisPoliciesResponse, EnergyCrisisPolicy } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { escapeHtml } from '@/utils/sanitize';
import { getCurrentLanguage } from '@/services/i18n';

type PolicyData = GetEnergyCrisisPoliciesResponse;

function getCategoryLabels(): Record<string, string> {
  const ja = getCurrentLanguage() === 'ja';
  return {
    conservation: ja ? 'エネルギー節約' : 'Energy Conservation',
    consumer_support: ja ? '消費者支援' : 'Consumer Support',
  };
}

function getSectorLabels(): Record<string, string> {
  const ja = getCurrentLanguage() === 'ja';
  return {
    transport: ja ? '交通' : 'Transport',
    buildings: ja ? '建築' : 'Buildings',
    industry: ja ? '産業' : 'Industry',
    electricity: ja ? '電力' : 'Electricity',
    agriculture: ja ? '農業' : 'Agriculture',
    general: ja ? '一般' : 'General',
  };
}

const STATUS_CLASS: Record<string, string> = {
  active: 'ecp-status-active',
  planned: 'ecp-status-planned',
  ended: 'ecp-status-ended',
};

export class EnergyCrisisPanel extends Panel {
  private data: PolicyData | null = null;
  private loading = true;
  private error: string | null = null;
  private activeFilter: string = 'all';

  constructor() {
    const ja = getCurrentLanguage() === 'ja';
    super({
      id: 'energy-crisis',
      title: ja ? 'エネルギー危機トラッカー' : 'Energy Crisis Tracker',
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip: 'IEA 2026 Energy Crisis Policy Response Tracker. Tracks government measures to conserve energy and support consumers in response to Middle East conflict and Strait of Hormuz supply disruptions.',
    });
    this.showLoading(getCurrentLanguage() === 'ja' ? 'エネルギー危機政策を読み込み中...' : 'Loading energy crisis policies...');
  }

  public async fetchData(): Promise<void> {
    const hydrated = getHydratedData('energyCrisisPolicies') as PolicyData | undefined;
    if (hydrated?.policies?.length) {
      this.data = hydrated;
      this.error = null;
      this.loading = false;
      this.setCount(hydrated.policies.length);
      this.render();
      void this.refreshFromRpc();
      return;
    }
    await this.refreshFromRpc();
  }

  private async refreshFromRpc(): Promise<void> {
    try {
      const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
      const fresh = await client.getEnergyCrisisPolicies({ countryCode: '', category: '' });
      if (!this.element?.isConnected) return;
      if (fresh.policies?.length || !this.data) {
        this.data = fresh;
        this.error = null;
        this.loading = false;
        this.setCount(fresh.policies.length);
        this.render();
      }
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      if (!this.data) {
        console.warn('[EnergyCrisis] Fetch error:', err);
        this.error = getCurrentLanguage() === 'ja' ? 'エネルギー危機データを取得できません' : 'Energy crisis data unavailable';
        this.loading = false;
        this.render();
      }
    }
  }

  private getFilteredPolicies(): EnergyCrisisPolicy[] {
    if (!this.data?.policies) return [];
    if (this.activeFilter === 'all') return this.data.policies;
    return this.data.policies.filter(p => p.category === this.activeFilter);
  }

  private buildSummary(): { conservationCount: number; supportCount: number; countryCount: number } {
    const policies = this.data?.policies ?? [];
    const conservationCount = policies.filter(p => p.category === 'conservation').length;
    const supportCount = policies.filter(p => p.category === 'consumer_support').length;
    const countryCount = new Set(policies.map(p => p.countryCode)).size;
    return { conservationCount, supportCount, countryCount };
  }

  private render(): void {
    if (this.loading) {
      this.showLoading(getCurrentLanguage() === 'ja' ? 'エネルギー危機政策を読み込み中...' : 'Loading energy crisis policies...');
      return;
    }

    if (this.error || !this.data) {
      this.showError(this.error || (getCurrentLanguage() === 'ja' ? 'データなし' : 'No data available'), () => void this.fetchData());
      return;
    }

    if (!this.data.policies?.length) {
      this.setContent(`<div class="panel-empty">${getCurrentLanguage() === 'ja' ? '追跡中のエネルギー危機政策はありません。' : 'No energy crisis policies tracked.'}</div>`);
      return;
    }

    const summary = this.buildSummary();
    const filtered = this.getFilteredPolicies();

    const ja = getCurrentLanguage() === 'ja';
    const summaryHtml = `
      <div class="ecp-summary">
        <div class="ecp-summary-card">
          <span class="ecp-summary-value">${summary.countryCount}</span>
          <span class="ecp-summary-label">${ja ? '国' : 'Countries'}</span>
        </div>
        <div class="ecp-summary-card ecp-summary-conservation">
          <span class="ecp-summary-value">${summary.conservationCount}</span>
          <span class="ecp-summary-label">${ja ? '節約' : 'Conservation'}</span>
        </div>
        <div class="ecp-summary-card ecp-summary-support">
          <span class="ecp-summary-value">${summary.supportCount}</span>
          <span class="ecp-summary-label">${ja ? '消費者支援' : 'Consumer Support'}</span>
        </div>
      </div>
    `;

    const filterHtml = `
      <div class="ecp-filters">
        <button class="ecp-filter-btn ${this.activeFilter === 'all' ? 'ecp-filter-active' : ''}" data-filter="all">${ja ? 'すべて' : 'All'}</button>
        <button class="ecp-filter-btn ${this.activeFilter === 'conservation' ? 'ecp-filter-active' : ''}" data-filter="conservation">${ja ? '節約' : 'Conservation'}</button>
        <button class="ecp-filter-btn ${this.activeFilter === 'consumer_support' ? 'ecp-filter-active' : ''}" data-filter="consumer_support">${ja ? '消費者支援' : 'Consumer Support'}</button>
      </div>
    `;

    const policyRows = filtered.map(p => {
      const categoryLabel = getCategoryLabels()[p.category] || p.category;
      const sectorLabel = getSectorLabels()[p.sector] || p.sector;
      const statusClass = STATUS_CLASS[p.status] || '';
      const categoryClass = p.category === 'conservation' ? 'ecp-cat-conservation' : 'ecp-cat-support';

      return `
        <div class="ecp-policy-row">
          <div class="ecp-policy-header">
            <span class="ecp-country">${escapeHtml(p.country)}</span>
            <span class="ecp-pill ${categoryClass}">${escapeHtml(categoryLabel)}</span>
            <span class="ecp-pill ecp-pill-sector">${escapeHtml(sectorLabel)}</span>
            <span class="ecp-pill ${statusClass}">${escapeHtml(p.status)}</span>
          </div>
          <div class="ecp-measure">${escapeHtml(p.measure)}</div>
          <div class="ecp-date">${escapeHtml(p.dateAnnounced)}</div>
        </div>
      `;
    }).join('');

    const sourceUrl = this.data.sourceUrl || 'https://www.iea.org/data-and-statistics/data-tools/2026-energy-crisis-policy-response-tracker';
    const footer = [
      this.data.updatedAt ? `${ja ? '更新' : 'Updated'} ${new Date(this.data.updatedAt).toLocaleDateString()}` : '',
      `${ja ? 'ソース' : 'Source'}: IEA`,
    ].filter(Boolean).join(' · ');

    this.setContent(`
      <div class="ecp-container">
        ${summaryHtml}
        ${filterHtml}
        <div class="ecp-policy-list">${policyRows}</div>
        <div class="ecp-footer">
          <span>${escapeHtml(footer)}</span>
          <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="ecp-source-link">IEA Tracker ↗</a>
        </div>
      </div>
    `);

    this.content?.querySelectorAll('.ecp-filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const filter = (e.currentTarget as HTMLElement).dataset.filter || 'all';
        this.activeFilter = filter;
        this.render();
      });
    });
  }
}
