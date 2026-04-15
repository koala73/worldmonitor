import { Panel } from './Panel';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { getHydratedData } from '@/services/bootstrap';
import { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GetEnergyCrisisPoliciesResponse, EnergyCrisisPolicy } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { escapeHtml } from '@/utils/sanitize';

type PolicyData = GetEnergyCrisisPoliciesResponse;

const CATEGORY_LABELS: Record<string, string> = {
  conservation: 'Energy Conservation',
  consumer_support: 'Consumer Support',
};

const SECTOR_LABELS: Record<string, string> = {
  transport: 'Transport',
  buildings: 'Buildings',
  industry: 'Industry',
  electricity: 'Electricity',
  agriculture: 'Agriculture',
  general: 'General',
};

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
    super({
      id: 'energy-crisis',
      title: 'Energy Crisis Tracker',
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip: 'IEA 2026 Energy Crisis Policy Response Tracker. Tracks government measures to conserve energy and support consumers in response to Middle East conflict and Strait of Hormuz supply disruptions.',
    });
    this.showLoading('Loading energy crisis policies...');
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
        this.error = 'Energy crisis data unavailable';
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
      this.showLoading('Loading energy crisis policies...');
      return;
    }

    if (this.error || !this.data) {
      this.showError(this.error || 'No data available', () => void this.fetchData());
      return;
    }

    if (!this.data.policies?.length) {
      this.setContent('<div class="panel-empty">No energy crisis policies tracked.</div>');
      return;
    }

    const summary = this.buildSummary();
    const filtered = this.getFilteredPolicies();

    const summaryHtml = `
      <div class="ecp-summary">
        <div class="ecp-summary-card">
          <span class="ecp-summary-value">${summary.countryCount}</span>
          <span class="ecp-summary-label">Countries</span>
        </div>
        <div class="ecp-summary-card ecp-summary-conservation">
          <span class="ecp-summary-value">${summary.conservationCount}</span>
          <span class="ecp-summary-label">Conservation</span>
        </div>
        <div class="ecp-summary-card ecp-summary-support">
          <span class="ecp-summary-value">${summary.supportCount}</span>
          <span class="ecp-summary-label">Consumer Support</span>
        </div>
      </div>
    `;

    const filterHtml = `
      <div class="ecp-filters">
        <button class="ecp-filter-btn ${this.activeFilter === 'all' ? 'ecp-filter-active' : ''}" data-filter="all">All</button>
        <button class="ecp-filter-btn ${this.activeFilter === 'conservation' ? 'ecp-filter-active' : ''}" data-filter="conservation">Conservation</button>
        <button class="ecp-filter-btn ${this.activeFilter === 'consumer_support' ? 'ecp-filter-active' : ''}" data-filter="consumer_support">Consumer Support</button>
      </div>
    `;

    const policyRows = filtered.map(p => {
      const categoryLabel = CATEGORY_LABELS[p.category] || p.category;
      const sectorLabel = SECTOR_LABELS[p.sector] || p.sector;
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
      this.data.updatedAt ? `Updated ${new Date(this.data.updatedAt).toLocaleDateString()}` : '',
      'Source: IEA',
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
