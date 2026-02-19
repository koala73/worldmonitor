
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { isDesktopRuntime } from '@/services/runtime';
import {
  getDesktopReadinessChecks,
  getKeyBackedAvailabilitySummary,
  getNonParityFeatures,
} from '@/services/desktop-readiness';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';

interface ServiceStatus {
  id: string;
  name: string;
  category: string;
  status: 'operational' | 'degraded' | 'outage' | 'unknown';
  description: string;
}

interface LocalBackendStatus {
  enabled?: boolean;
  mode?: string;
  port?: number;
  remoteBase?: string;
}

interface ServiceStatusResponse {
  success: boolean;
  timestamp: string;
  summary: {
    operational: number;
    degraded: number;
    outage: number;
    unknown: number;
  };
  services: ServiceStatus[];
  local?: LocalBackendStatus;
}

type CategoryFilter = 'all' | 'cloud' | 'dev' | 'comm' | 'ai' | 'saas';

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: 'All',
  cloud: 'Cloud',
  dev: 'Dev Tools',
  comm: 'Comms',
  ai: 'AI',
  saas: 'SaaS',
};

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
  }

  private async fetchStatus(): Promise<void> {
    try {
      const res = await fetch('/api/service-status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data: ServiceStatusResponse = await res.json();
      if (!data.success) throw new Error('Failed to load status');

      this.services = data.services;
      this.localBackend = data.local ?? null;
      this.error = null;
    } catch (err) {
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
          h('span', null, 'Checking services...'),
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
          }, 'Retry'),
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
      issues.length === 0 ? h('div', { className: 'all-operational' }, 'All services operational') : false,
    );
  }


  private buildBackendStatus(): DomChild {
    if (!isDesktopRuntime()) return false;

    if (!this.localBackend?.enabled) {
      return h('div', { className: 'service-status-backend warning' },
        'Desktop local backend unavailable. Falling back to cloud API.',
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
        h('span', { className: 'summary-label' }, 'OK'),
      ),
      h('div', { className: 'summary-item degraded' },
        h('span', { className: 'summary-count' }, String(degraded)),
        h('span', { className: 'summary-label' }, 'Degraded'),
      ),
      h('div', { className: 'summary-item outage' },
        h('span', { className: 'summary-count' }, String(outage)),
        h('span', { className: 'summary-label' }, 'Outage'),
      ),
    );
  }

  private buildDesktopReadiness(): DomChild {
    if (!isDesktopRuntime()) return false;

    const checks = getDesktopReadinessChecks(Boolean(this.localBackend?.enabled));
    const keySummary = getKeyBackedAvailabilitySummary();
    const nonParity = getNonParityFeatures();

    return h('div', { className: 'service-status-desktop-readiness' },
      h('div', { className: 'service-status-desktop-title' }, 'Desktop readiness'),
      h('div', { className: 'service-status-desktop-subtitle' },
        `Acceptance checks: ${checks.filter(check => check.ready).length}/${checks.length} ready · key-backed features ${keySummary.available}/${keySummary.total}`,
      ),
      h('ul', { className: 'service-status-desktop-list' },
        ...checks.map(check =>
          h('li', null, `${check.ready ? '✅' : '⚠️'} ${check.label}`),
        ),
      ),
      h('details', { className: 'service-status-non-parity' },
        h('summary', null, `Non-parity fallbacks (${nonParity.length})`),
        h('ul', null,
          ...nonParity.map(feature =>
            h('li', null, h('strong', null, feature.panel), `: ${feature.fallback}`),
          ),
        ),
      ),
    );
  }

  private buildFilters(): HTMLElement {
    return h('div', { className: 'service-status-filters' },
      ...Object.entries(CATEGORY_LABELS).map(([key, label]) =>
        h('button', {
          className: `status-filter-btn ${this.filter === key ? 'active' : ''}`,
          dataset: { filter: key },
          onClick: () => this.setFilter(key as CategoryFilter),
        }, label),
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

  // Filter listeners are now attached inline via onClick in buildFilters()
}
