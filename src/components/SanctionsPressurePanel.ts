import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { CountrySanctionsPressure, ProgramSanctionsPressure, SanctionsEntry, SanctionsPressureResult } from '@/services/sanctions-pressure';
import { escapeHtml } from '@/utils/sanitize';

export class SanctionsPressurePanel extends Panel {
  private data: SanctionsPressureResult | null = null;

  constructor() {
    super({
      id: 'sanctions-pressure',
      title: t('components.sanctionsPressure.title'),
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip: t('components.sanctionsPressure.infoTooltip'),
    });
    this.showLoading(t('components.sanctionsPressure.loading'));
  }

  public setData(data: SanctionsPressureResult): void {
    this.data = data;
    this.setCount(data.totalCount);
    this.render();
  }

  private render(): void {
    if (!this.data || this.data.totalCount === 0) {
      this.setContent(`<div class="economic-empty">${escapeHtml(t('components.sanctionsPressure.unavailable'))}</div>`);
      return;
    }

    const data = this.data;

    const summaryHtml = `
      <div class="sanctions-summary">
        ${this.renderSummaryCard(t('components.sanctionsPressure.summary.new'), data.newEntryCount, data.newEntryCount > 0 ? 'highlight' : '')}
        ${this.renderSummaryCard(t('components.sanctionsPressure.summary.vessels'), data.vesselCount)}
        ${this.renderSummaryCard(t('components.sanctionsPressure.summary.aircraft'), data.aircraftCount)}
      </div>
    `;

    const countriesHtml = data.countries.length > 0
      ? data.countries.slice(0, 8).map((country) => this.renderCountryRow(country)).join('')
      : `<div class="economic-empty">${escapeHtml(t('components.sanctionsPressure.empty.countries'))}</div>`;

    const entriesHtml = data.entries.length > 0
      ? data.entries.slice(0, 10).map((entry) => this.renderEntryRow(entry)).join('')
      : `<div class="economic-empty">${escapeHtml(t('components.sanctionsPressure.empty.entries'))}</div>`;

    const programsHtml = data.programs.length > 0
      ? data.programs.slice(0, 6).map((program) => this.renderProgramRow(program)).join('')
      : `<div class="economic-empty">${escapeHtml(t('components.sanctionsPressure.empty.programs'))}</div>`;

    const footer = [
      t('components.sanctionsPressure.footer.updated', { time: data.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
      data.datasetDate ? t('components.sanctionsPressure.footer.dataset', { date: data.datasetDate.toISOString().slice(0, 10) }) : '',
      t('components.sanctionsPressure.footer.source'),
    ].filter(Boolean).join(' · ');

    this.setContent(`
      <div class="sanctions-panel-content">
        ${summaryHtml}
        <div class="sanctions-sections">
          <div class="sanctions-section">
            <div class="sanctions-section-title">${escapeHtml(t('components.sanctionsPressure.sections.countries'))}</div>
            <div class="sanctions-list">${countriesHtml}</div>
          </div>
          <div class="sanctions-section">
            <div class="sanctions-section-title">${escapeHtml(t('components.sanctionsPressure.sections.entries'))}</div>
            <div class="sanctions-list">${entriesHtml}</div>
          </div>
          <div class="sanctions-section">
            <div class="sanctions-section-title">${escapeHtml(t('components.sanctionsPressure.sections.programs'))}</div>
            <div class="sanctions-list">${programsHtml}</div>
          </div>
        </div>
        <div class="economic-footer">${escapeHtml(footer)}</div>
      </div>
    `);
  }

  private renderSummaryCard(label: string, value: string | number, tone = ''): string {
    return `
      <div class="sanctions-summary-card ${tone ? `sanctions-summary-card-${tone}` : ''}">
        <span class="sanctions-summary-label">${escapeHtml(label)}</span>
        <span class="sanctions-summary-value">${escapeHtml(String(value))}</span>
      </div>
    `;
  }

  private renderCountryRow(country: CountrySanctionsPressure): string {
    const flags: string[] = [];
    if (country.newEntryCount > 0) flags.push(`<span class="sanctions-pill sanctions-pill-new">${escapeHtml(t('components.sanctionsPressure.pills.newCount', { count: country.newEntryCount }))}</span>`);
    if (country.vesselCount > 0) flags.push(`<span class="sanctions-pill">🚢 ${country.vesselCount}</span>`);
    if (country.aircraftCount > 0) flags.push(`<span class="sanctions-pill">✈ ${country.aircraftCount}</span>`);

    return `
      <div class="sanctions-row">
        <div class="sanctions-row-main">
          <div class="sanctions-row-title">${escapeHtml(country.countryName)}</div>
          <div class="sanctions-row-meta">${escapeHtml(country.countryCode)} · ${escapeHtml(t('components.sanctionsPressure.designations', { count: country.entryCount }))}</div>
        </div>
        <div class="sanctions-row-flags">${flags.join('')}</div>
      </div>
    `;
  }

  private renderProgramRow(program: ProgramSanctionsPressure): string {
    return `
      <div class="sanctions-row">
        <div class="sanctions-row-main">
          <div class="sanctions-row-title">${escapeHtml(program.program)}</div>
          <div class="sanctions-row-meta">${escapeHtml(t('components.sanctionsPressure.designations', { count: program.entryCount }))}</div>
        </div>
        <div class="sanctions-row-flags">
          ${program.newEntryCount > 0 ? `<span class="sanctions-pill sanctions-pill-new">${escapeHtml(t('components.sanctionsPressure.pills.newCount', { count: program.newEntryCount }))}</span>` : ''}
        </div>
      </div>
    `;
  }

  private renderEntryRow(entry: SanctionsEntry): string {
    const location = entry.countryNames[0] || entry.countryCodes[0] || t('components.sanctionsPressure.fallbacks.unattributed');
    const program = entry.programs[0] || t('components.sanctionsPressure.fallbacks.program');
    const note = entry.note ? `<div class="sanctions-entry-note">${escapeHtml(entry.note)}</div>` : '';
    const effective = entry.effectiveAt ? entry.effectiveAt.toISOString().slice(0, 10) : t('components.sanctionsPressure.fallbacks.undated');

    return `
      <div class="sanctions-entry">
        <div class="sanctions-entry-top">
          <span class="sanctions-entry-name">${escapeHtml(entry.name)}</span>
          <span class="sanctions-pill sanctions-pill-type">${escapeHtml(entry.entityType)}</span>
          ${entry.isNew ? `<span class="sanctions-pill sanctions-pill-new">${escapeHtml(t('components.sanctionsPressure.pills.new'))}</span>` : ''}
        </div>
        <div class="sanctions-entry-meta">${escapeHtml(location)} · ${escapeHtml(program)} · ${escapeHtml(effective)}</div>
        ${note}
      </div>
    `;
  }
}
