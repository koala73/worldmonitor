
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { isDesktopRuntime } from '@/services/runtime';
import {
  getDesktopReadinessChecks,
  getKeyBackedAvailabilitySummary,
  getNonParityFeatures,
} from '@/services/desktop-readiness';
import {
  fetchServiceStatuses,
  type ServiceStatusResult as ServiceStatus,
} from '@/services/infrastructure';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';

interface LocalBackendStatus {
  enabled?: boolean;
  mode?: string;
  port?: number;
  remoteBase?: string;
}

type CategoryFilter = 'all' | 'cloud' | 'dev' | 'comm' | 'ai' | 'saas';

function getCategoryLabel(category: CategoryFilter): string {
  const labels: Record<CategoryFilter, string> = {
    all: t('components.serviceStatus.categories.all'),
    cloud: t('components.serviceStatus.categories.cloud'),
    dev: t('components.serviceStatus.categories.dev'),
    comm: t('components.serviceStatus.categories.comm'),
    ai: t('components.serviceStatus.categories.ai'),
    saas: t('components.serviceStatus.categories.saas'),
  };
  return labels[category];
}

export class ServiceStatusPanel extends Panel {
  private services: ServiceStatus[] = [];
  private loading = true;
  private error: string | null = null;
  private filter: CategoryFilter = 'all';
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private localBackend: LocalBackendStatus | null = null;

  constructor() {
    super({ id: 'service-status', title: t('panels.serviceStatus'), showCount: false });
    void this.fetchStatus();
    this.refreshInterval = setInterval(() => this.fetchStatus(), 60000);
  }

  public destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    super.destroy();
  }

  private async fetchStatus(): Promise<void> {
    try {
      const data = await fetchServiceStatuses();
      if (!data.success) throw new Error('Failed to load status');

      this.services = data.services;
      this.error = null;
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.error = err instanceof Error ? err.message : 'Failed to fetch';
      console.error('[ServiceStatus] Fetch error:', err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private setFilter(filter: CategoryFilter): void {
    this.filter = filter;
    this.render();
  }

  private getFilteredServices(): ServiceStatus[] {
    if (this.filter === 'all') return this.services;
    return this.services.filter(s => s.category === this.filter);
  }

  protected render(): void {
    if (this.loading) {
      replaceChildren(this.content,
        h('div', { className: 'service-status-loading' },
          h('div', { className: 'loading-spinner' }),
          h('span', null, t('components.serviceStatus.checkingServices')),
        ),
      );
      return;
    }

    if (this.error) {
      replaceChildren(this.content,
        h('div', { className: 'service-status-error' },
          h('span', { className: 'error-text' }, this.error),
          h('button', {
            className: 'retry-btn',
            onClick: () => { this.loading = true; this.render(); void this.fetchStatus(); },
          }, t('common.retry')),
        ),
      );
      return;
    }

    const filtered = this.getFilteredServices();
    const issues = filtered.filter(s => s.status !== 'operational');

    replaceChildren(this.content,
      this.buildBackendStatus(),
      this.buildDesktopReadiness(),
      this.buildSummary(filtered),
      this.buildFilters(),
      h('div', { className: 'service-status-list' },
        ...this.buildServiceItems(filtered),
      ),
      issues.length === 0 ? h('div', { className: 'all-operational' }, t('components.serviceStatus.allOperational')) : false,
    );
  }

  private buildBackendStatus(): DomChild {
    if (!isDesktopRuntime()) return false;

    if (!this.localBackend?.enabled) {
      return h('div', { className: 'service-status-backend warning' },
        t('components.serviceStatus.backendUnavailable'),
      );
    }

    const port = this.localBackend.port ?? 46123;
    const remote = this.localBackend.remoteBase ?? 'https://worldmonitor.app';

    return h('div', { className: 'service-status-backend' },
      'Local backend active on ', h('strong', null, `127.0.0.1:${port}`),
      ' · cloud fallback: ', h('strong', null, remote),
    );
  }

  private buildSummary(services: ServiceStatus[]): HTMLElement {
    const operational = services.filter(s => s.status === 'operational').length;
    const degraded = services.filter(s => s.status === 'degraded').length;
    const outage = services.filter(s => s.status === 'outage').length;

    return h('div', { className: 'service-status-summary' },
      h('div', { className: 'summary-item operational' },
        h('span', { className: 'summary-count' }, String(operational)),
        h('span', { className: 'summary-label' }, t('components.serviceStatus.ok')),
      ),
      h('div', { className: 'summary-item degraded' },
        h('span', { className: 'summary-count' }, String(degraded)),
        h('span', { className: 'summary-label' }, t('components.serviceStatus.degraded')),
      ),
      h('div', { className: 'summary-item outage' },
        h('span', { className: 'summary-count' }, String(outage)),
        h('span', { className: 'summary-label' }, t('components.serviceStatus.outage')),
      ),
    );
  }

  private buildDesktopReadiness(): DomChild {
    if (!isDesktopRuntime()) return false;

    const checks = getDesktopReadinessChecks(Boolean(this.localBackend?.enabled));
    const keySummary = getKeyBackedAvailabilitySummary();
    const nonParity = getNonParityFeatures();

    return h('div', { className: 'service-status-desktop-readiness' },
      h('div', { className: 'service-status-desktop-title' }, t('components.serviceStatus.desktopReadiness')),
      h('div', { className: 'service-status-desktop-subtitle' },
        t('components.serviceStatus.acceptanceChecks', { ready: String(checks.filter(check => check.ready).length), total: String(checks.length), available: String(keySummary.available), featureTotal: String(keySummary.total) }),
      ),
      h('ul', { className: 'service-status-desktop-list' },
        ...checks.map(check =>
          h('li', null, `${check.ready ? '✅' : '⚠️'} ${check.label}`),
        ),
      ),
      h('details', { className: 'service-status-non-parity' },
        h('summary', null, t('components.serviceStatus.nonParityFallbacks', { count: String(nonParity.length) })),
        h('ul', null,
          ...nonParity.map(feature =>
            h('li', null, h('strong', null, feature.panel), `: ${feature.fallback}`),
          ),
        ),
      ),
    );
  }

  private buildFilters(): HTMLElement {
    const categories: CategoryFilter[] = ['all', 'cloud', 'dev', 'comm', 'ai', 'saas'];
    return h('div', { className: 'service-status-filters' },
      ...categories.map(key =>
        h('button', {
          className: `status-filter-btn ${this.filter === key ? 'active' : ''}`,
          dataset: { filter: key },
          onClick: () => this.setFilter(key),
        }, getCategoryLabel(key)),
      ),
    );
  }

  private buildServiceItems(services: ServiceStatus[]): HTMLElement[] {
    return services.map(service =>
      h('div', { className: `service-status-item ${service.status}` },
        h('span', { className: 'status-icon' }, this.getStatusIcon(service.status)),
        h('span', { className: 'status-name' }, service.name),
        h('span', { className: `status-badge ${service.status}` }, service.status.toUpperCase()),
      ),
    );
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'operational': return '●';
      case 'degraded': return '◐';
      case 'outage': return '○';
      default: return '?';
    }
  }

}
