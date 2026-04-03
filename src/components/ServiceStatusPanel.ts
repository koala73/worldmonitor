
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import {
  fetchServiceStatuses,
  type ServiceStatusResult as ServiceStatus,
} from '@/services/infrastructure';
import {
  getDesktopReadinessChecks,
  getKeyBackedAvailabilitySummary,
  getNonParityFeatures,
  type DesktopReadinessCheck,
} from '@/services/desktop-readiness';
import { hasTauriInvokeBridge } from '@/services/tauri-bridge';
import { isDesktopRuntime } from '@/services/runtime';
import { h, replaceChildren } from '@/utils/dom-utils';

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
  constructor() {
    super({ id: 'service-status', title: t('panels.serviceStatus'), showCount: false });
  }

  private lastServicesJson = '';

  public async fetchStatus(): Promise<boolean> {
    try {
      const data = await fetchServiceStatuses();
      if (!this.element?.isConnected) return false;
      if (!data.success) throw new Error('Failed to load status');

      const fingerprint = data.services.map(s => `${s.name}:${s.status}`).join(',');
      const changed = fingerprint !== this.lastServicesJson;
      this.lastServicesJson = fingerprint;
      this.services = data.services;
      this.error = null;
      return changed;
    } catch (err) {
      if (this.isAbortError(err)) return false;
      if (!this.element?.isConnected) return false;
      this.error = t('common.failedToLoad');
      console.error('[ServiceStatus] Fetch error:', err);
      return true;
    } finally {
      this.loading = false;
      if (this.element?.isConnected) {
        this.render();
      }
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
      this.showError(this.error, () => { this.loading = true; this.render(); void this.fetchStatus(); });
      return;
    }

    this.setErrorState(false);
    const filtered = this.getFilteredServices();
    const issues = filtered.filter(s => s.status !== 'operational');

    replaceChildren(this.content,
      this.buildDesktopReadiness(),
      this.buildSummary(filtered),
      this.buildFilters(),
      h('div', { className: 'service-status-list' },
        ...this.buildServiceItems(filtered),
      ),
      issues.length === 0 ? h('div', { className: 'all-operational' }, t('components.serviceStatus.allOperational')) : false,
    );
  }

  private buildDesktopReadiness(): HTMLElement | false {
    if (!isDesktopRuntime()) return false;

    const localBackendEnabled = hasTauriInvokeBridge();
    const checks = getDesktopReadinessChecks(localBackendEnabled);
    const readyCount = checks.filter(check => check.ready).length;
    const keyBacked = getKeyBackedAvailabilitySummary();
    const fallbacks = [...getNonParityFeatures()].sort((a, b) => a.priority - b.priority);

    return h('section', { className: 'service-status-readiness' },
      h('div', { className: 'service-status-readiness-title' }, t('components.serviceStatus.desktopReadiness')),
      h('div', { className: 'service-status-readiness-meta' },
        t('components.serviceStatus.acceptanceChecks', {
          ready: String(readyCount),
          total: String(checks.length),
          available: String(keyBacked.available),
          featureTotal: String(keyBacked.total),
        }),
      ),
      !localBackendEnabled
        ? h('div', { className: 'service-status-readiness-warning' }, t('components.serviceStatus.backendUnavailable'))
        : false,
      h('div', { className: 'service-status-readiness-list' },
        ...checks.map((check) => this.buildReadinessItem(check)),
      ),
      fallbacks.length > 0
        ? h('div', { className: 'service-status-fallbacks' },
            h('div', { className: 'service-status-fallbacks-title' },
              t('components.serviceStatus.nonParityFallbacks', { count: String(fallbacks.length) }),
            ),
            h('div', { className: 'service-status-fallbacks-list' },
              ...fallbacks.map((feature) =>
                h('div', { className: 'service-status-fallback-item' },
                  h('div', { className: 'service-status-fallback-panel' }, feature.panel),
                  h('div', { className: 'service-status-fallback-copy' }, feature.fallback),
                ),
              ),
            ),
          )
        : false,
    );
  }

  private buildReadinessItem(check: DesktopReadinessCheck): HTMLElement {
    const status = check.ready ? 'operational' : 'outage';
    const hint = this.getReadinessHint(check);

    return h('div', { className: `service-status-item ${status} service-status-readiness-item` },
      h('span', { className: 'status-icon' }, this.getStatusIcon(status)),
      h('div', { className: 'service-status-readiness-copy' },
        h('div', { className: 'status-name' }, check.label),
        hint ? h('div', { className: 'service-status-readiness-hint' }, hint) : false,
      ),
      h('span', { className: `status-badge ${status}` },
        check.ready ? t('components.serviceStatus.ok').toUpperCase() : t('components.serviceStatus.outage').toUpperCase(),
      ),
    );
  }

  private getReadinessHint(check: DesktopReadinessCheck): string | null {
    if (check.ready) return null;

    switch (check.id) {
      case 'startup':
        return t('components.serviceStatus.backendUnavailable');
      case 'summaries':
        return 'Configure Ollama, Groq, or OpenRouter in Settings to restore provider-backed summaries.';
      case 'live-tracking':
        return 'Configure AISStream or OpenSky credentials in Settings to restore live vessel and flight tracking.';
      default:
        return null;
    }
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
