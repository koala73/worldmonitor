import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { fetchSanctionsData, getSanctionsEntities, type SanctionsResponse, type SanctionsEntity } from '@/services/sanctions';

export class SanctionsPanel extends Panel {
  private data: SanctionsResponse | null = null;
  private searchTerm = '';
  private activeProgram = '';

  constructor() {
    super({
      id: 'sanctions',
      title: t('components.sanctions.title'),
      showCount: true,
      infoTooltip: t('components.sanctions.infoTooltip'),
    });
  }

  public async refresh(): Promise<void> {
    this.showLoading();

    try {
      this.data = await fetchSanctionsData();
      this.applyData();
    } catch {
      this.showError(t('common.failedToLoad'));
      this.setDataBadge('unavailable');
    }
  }

  public setData(data: SanctionsResponse): void {
    this.data = data;
    this.applyData();
  }

  private applyData(): void {
    if (!this.data || !this.data.generatedAt) {
      this.showError(t('components.sanctions.unavailable'));
      this.setDataBadge('unavailable');
      return;
    }

    this.setCount(this.data.totalEntities);
    this.setDataBadge('live', new Date(this.data.generatedAt).toLocaleTimeString());
    this.render();
  }

  private render(): void {
    if (!this.data) return;

    const entities = getSanctionsEntities(this.data, {
      search: this.searchTerm || undefined,
      program: this.activeProgram || undefined,
      limit: 100,
    });

    // Country summary header
    const countryCounts = Object.entries(this.data.countries)
      .filter(([name]) => name !== 'Unknown')
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8);

    const severityClass = (sev: string) =>
      sev === 'severe' ? 'sanctions-severe' : sev === 'high' ? 'sanctions-high' : 'sanctions-moderate';

    // Collect unique programs for filter badges
    const allPrograms = new Set<string>();
    for (const entity of this.data.entities) {
      const prog = (entity.program || '').split(';')[0]?.trim();
      if (prog) allPrograms.add(prog);
    }
    const topPrograms = Array.from(allPrograms).slice(0, 12);

    const html = `
      <div class="sanctions-search">
        <input type="text" class="sanctions-search-input" placeholder="${escapeHtml(t('components.sanctions.searchPlaceholder'))}" value="${escapeHtml(this.searchTerm)}" />
      </div>
      <div class="sanctions-programs">
        <button class="sanctions-program-badge ${this.activeProgram === '' ? 'active' : ''}" data-program="">${escapeHtml(t('common.all'))}</button>
        ${topPrograms.map(p => `<button class="sanctions-program-badge ${this.activeProgram === p ? 'active' : ''}" data-program="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('')}
      </div>
      <div class="sanctions-summary">
        ${countryCounts.map(([name, data]) => `
          <span class="sanctions-country-chip ${severityClass(data.severity)}" title="${escapeHtml(name)}: ${data.count} entities">
            ${escapeHtml(name)} <strong>${data.count}</strong>
          </span>
        `).join('')}
      </div>
      <div class="sanctions-list">
        ${entities.length === 0 ? `<div class="empty-state">${escapeHtml(t('components.sanctions.noResults'))}</div>` : ''}
        ${entities.map(e => this.renderEntity(e)).join('')}
      </div>
    `;

    this.setContent(html);
    this.bindEvents();
  }

  private renderEntity(entity: SanctionsEntity): string {
    const typeIcon = entity.type === 'individual' ? '&#128100;'
      : entity.type === 'vessel' ? '&#9875;'
      : entity.type === 'aircraft' ? '&#9992;'
      : '&#127970;';

    const severityClass = entity.severity === 'severe' ? 'sanctions-severe'
      : entity.severity === 'high' ? 'sanctions-high'
      : 'sanctions-moderate';

    return `
      <div class="sanctions-entity ${severityClass}">
        <span class="sanctions-entity-icon">${typeIcon}</span>
        <div class="sanctions-entity-info">
          <div class="sanctions-entity-name">${escapeHtml(entity.name)}</div>
          <div class="sanctions-entity-meta">
            ${entity.country ? `<span class="sanctions-entity-country">${escapeHtml(entity.country)}</span>` : ''}
            <span class="sanctions-entity-program">${escapeHtml(entity.program)}</span>
            <span class="sanctions-entity-type">${escapeHtml(entity.type)}</span>
          </div>
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    // Search input
    const searchInput = this.content.querySelector<HTMLInputElement>('.sanctions-search-input');
    if (searchInput) {
      let debounceTimer: ReturnType<typeof setTimeout>;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.searchTerm = searchInput.value.trim();
          this.render();
        }, 300);
      });
    }

    // Program filter badges
    const badges = this.content.querySelectorAll<HTMLButtonElement>('.sanctions-program-badge');
    badges.forEach(badge => {
      badge.addEventListener('click', () => {
        this.activeProgram = badge.dataset.program || '';
        this.render();
      });
    });
  }
}
