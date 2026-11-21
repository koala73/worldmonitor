import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import type { SecurityAdvisory } from '@/services/security-advisories';
import type { ResolvedScope } from '@/services/tab-focus';
import { PanelScopeFilter, focusedEmptyHtml, scopeTagHtml, type ScopeRow } from './panel-scope-filter';

type AdvisoryFilter = 'all' | 'critical' | 'US' | 'AU' | 'UK' | 'health';

export class SecurityAdvisoriesPanel extends Panel {
  private advisories: SecurityAdvisory[] = [];
  private activeFilter: AdvisoryFilter = 'all';
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private onRefreshRequest?: () => void;
  // Dashboard focus (#10453): advisories carry the ISO code of the country they cover.
  private readonly scopeFilter: PanelScopeFilter;
  private hasData = false;

  constructor() {
    super({
      id: 'security-advisories',
      title: t('panels.securityAdvisories'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.securityAdvisories.infoTooltip'),
      defaultRowSpan: 2,
    });
    this.scopeFilter = new PanelScopeFilter({ content: this.content, onChange: () => this.render() });
    this.showLoading(t('components.securityAdvisories.loading'));

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const filterBtn = target.closest<HTMLElement>('.sa-filter');
      if (filterBtn) {
        this.activeFilter = (filterBtn.dataset.filter || 'all') as AdvisoryFilter;
        this.render();
        return;
      }
      if (target.closest('.sa-refresh-btn')) {
        this.showLoading(t('components.securityAdvisories.loading'));
        this.onRefreshRequest?.();
      }
    });
  }

  public override applyScope(scope: ResolvedScope | null): void {
    if (!this.scopeFilter.setScope(scope)) return;
    // The next successful setData draws with the new focus; redrawing now
    // would erase a load failure.
    if (this.hasData && !this.showingLoadFailure && !this.refreshing) this.render();
  }

  /** A refresh is in flight: the loading indicator must stay until setData lands. */
  private refreshing = false;

  public override showError(message?: string, onRetry?: () => void, autoRetrySeconds?: number): void {
    this.refreshing = false;
    this.scopeFilter.hideStrip();
    super.showError(message, onRetry, autoRetrySeconds);
  }

  public override showLoading(message?: string): void {
    this.refreshing = true;
    this.scopeFilter?.hideStrip();
    super.showLoading(message);
  }

  public setData(advisories: SecurityAdvisory[]): void {
    const prevCount = this.advisories.length;
    this.advisories = advisories;
    this.hasData = true;
    this.refreshing = false;

    if (prevCount > 0 && advisories.length > prevCount) {
      this.setNewBadge(advisories.length - prevCount);
    }

    this.render();
  }

  private getFiltered(advisories: SecurityAdvisory[]): SecurityAdvisory[] {
    switch (this.activeFilter) {
      case 'critical':
        return advisories.filter(a => a.level === 'do-not-travel' || a.level === 'reconsider');
      case 'health':
        return advisories.filter(a => a.sourceCountry === 'EU' || a.sourceCountry === 'INT');
      case 'US':
      case 'AU':
      case 'UK':
        return advisories.filter(a => a.sourceCountry === this.activeFilter);
      default:
        return advisories;
    }
  }

  private getLevelClass(level?: SecurityAdvisory['level']): string {
    switch (level) {
      case 'do-not-travel': return 'sa-level-dnt';
      case 'reconsider': return 'sa-level-reconsider';
      case 'caution': return 'sa-level-caution';
      case 'normal': return 'sa-level-normal';
      default: return 'sa-level-info';
    }
  }

  private getLevelLabel(level?: SecurityAdvisory['level']): string {
    switch (level) {
      case 'do-not-travel': return t('components.securityAdvisories.levels.doNotTravel');
      case 'reconsider': return t('components.securityAdvisories.levels.reconsider');
      case 'caution': return t('components.securityAdvisories.levels.caution');
      case 'normal': return t('components.securityAdvisories.levels.normal');
      default: return t('components.securityAdvisories.levels.info');
    }
  }

  private getSourceFlag(sourceCountry: string): string {
    switch (sourceCountry) {
      case 'US': return '\u{1F1FA}\u{1F1F8}';
      case 'AU': return '\u{1F1E6}\u{1F1FA}';
      case 'UK': return '\u{1F1EC}\u{1F1E7}';
      case 'EU': return '\u{1F1EA}\u{1F1FA}';
      case 'INT': return '\u{1F3E5}';
      default: return '\u{1F310}';
    }
  }

  private formatTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return t('components.securityAdvisories.time.justNow');
    if (minutes < 60) return t('components.securityAdvisories.time.minutesAgo', { count: String(minutes) });
    if (hours < 24) return t('components.securityAdvisories.time.hoursAgo', { count: String(hours) });
    if (days < 7) return t('components.securityAdvisories.time.daysAgo', { count: String(days) });
    return date.toLocaleDateString();
  }

  private render(): void {
    if (this.advisories.length === 0) {
      this.scopeFilter.hideStrip();
      this.setCount(0);
      this.setSafeContent(unsafeRawHtml(`<div class="panel-empty">${t('common.noDataAvailable')}</div>`, 'legacy Panel.setContent() migration'));
      return;
    }

    // The focus narrows first (chosen countries, then neighbours); the
    // panel's own source filter then works within it.
    const view = this.scopeFilter.view(this.advisories, (a) => a.country || null);
    this.scopeFilter.renderStrip(view);
    const scoped = view.rows.map((row) => row.item);
    const rowFor = new Map<SecurityAdvisory, ScopeRow<SecurityAdvisory>>(view.rows.map((row) => [row.item, row]));
    this.setCount(scoped.length);
    if (view.emptyByFocus) {
      this.setSafeContent(unsafeRawHtml(focusedEmptyHtml(t('focus.filter.emptyAdvisories')), 'focus empty state: escaped by focusedEmptyHtml'));
      return;
    }

    const filtered = this.getFiltered(scoped);

    const dntCount = scoped.filter(a => a.level === 'do-not-travel').length;
    const reconsiderCount = scoped.filter(a => a.level === 'reconsider').length;
    const cautionCount = scoped.filter(a => a.level === 'caution').length;

    const summaryHtml = `
      <div class="sa-summary">
        <div class="sa-summary-item sa-level-dnt">
          <span class="sa-summary-count">${dntCount}</span>
          <span class="sa-summary-label">${t('components.securityAdvisories.levels.doNotTravel')}</span>
        </div>
        <div class="sa-summary-item sa-level-reconsider">
          <span class="sa-summary-count">${reconsiderCount}</span>
          <span class="sa-summary-label">${t('components.securityAdvisories.levels.reconsider')}</span>
        </div>
        <div class="sa-summary-item sa-level-caution">
          <span class="sa-summary-count">${cautionCount}</span>
          <span class="sa-summary-label">${t('components.securityAdvisories.levels.caution')}</span>
        </div>
      </div>
    `;

    const filtersHtml = `
      <div class="sa-filters">
        <button class="sa-filter ${this.activeFilter === 'all' ? 'sa-filter-active' : ''}" data-filter="all">${t('common.all')}</button>
        <button class="sa-filter ${this.activeFilter === 'critical' ? 'sa-filter-active' : ''}" data-filter="critical">${t('components.securityAdvisories.critical')}</button>
        <button class="sa-filter ${this.activeFilter === 'US' ? 'sa-filter-active' : ''}" data-filter="US">\u{1F1FA}\u{1F1F8} US</button>
        <button class="sa-filter ${this.activeFilter === 'AU' ? 'sa-filter-active' : ''}" data-filter="AU">\u{1F1E6}\u{1F1FA} AU</button>
        <button class="sa-filter ${this.activeFilter === 'UK' ? 'sa-filter-active' : ''}" data-filter="UK">\u{1F1EC}\u{1F1E7} UK</button>
        <button class="sa-filter ${this.activeFilter === 'health' ? 'sa-filter-active' : ''}" data-filter="health">\u{1F3E5} ${t('components.securityAdvisories.health')}</button>
      </div>
    `;

    const displayed = view.partition ? filtered : filtered.slice(0, 30);
    let itemsHtml: string;

    if (displayed.length === 0) {
      itemsHtml = `<div class="panel-empty">${t('components.securityAdvisories.noMatching')}</div>`;
    } else {
      itemsHtml = displayed.map(a => {
        const levelCls = this.getLevelClass(a.level);
        const levelLabel = this.getLevelLabel(a.level);
        const flag = this.getSourceFlag(a.sourceCountry);

        return `<div class="sa-item ${levelCls}">
          <div class="sa-item-header">
            <span class="sa-badge ${levelCls}">${levelLabel}</span>
            <span class="sa-source">${flag} ${escapeHtml(a.source)}</span>
            ${scopeTagHtml(rowFor.get(a))}
          </div>
          <div class="sa-body">
            <a href="${escapeHtml(a.link)}" target="_blank" rel="noopener" class="sa-title">${escapeHtml(a.title)}</a>
            <span class="sa-time">${this.formatTime(a.pubDate)}</span>
          </div>
        </div>`;
      }).join('');
    }

    const footerHtml = `
      <div class="sa-footer">
        <span class="sa-footer-source">${t('components.securityAdvisories.sources')}</span>
        <button class="sa-refresh-btn">${t('components.securityAdvisories.refresh')}</button>
      </div>
    `;

    this.setSafeContent(unsafeRawHtml(`
      <div class="sa-panel-content">
        ${summaryHtml}
        ${filtersHtml}
        <div class="sa-list">${itemsHtml}</div>
        ${footerHtml}
      </div>
    `, 'legacy Panel.setContent() migration'));
  }

  public setRefreshHandler(handler: () => void): void {
    this.onRefreshRequest = handler;
  }

  public destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    super.destroy();
  }
}
