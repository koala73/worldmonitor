import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import type { PopulationExposure } from '@/types';
import { formatPopulation } from '@/services/population-exposure';
import { t } from '@/services/i18n';

export class PopulationExposurePanel extends Panel {
  private exposures: PopulationExposure[] = [];

  constructor() {
    super({
      id: 'population-exposure',
      title: t('panels.populationExposure'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.populationExposure.infoTooltip'),
    });
    this.showLoading(t('common.calculatingExposure'));
  }

  public setExposures(exposures: PopulationExposure[]): void {
    this.exposures = exposures;
    this.setCount(exposures.length);
    this.renderContent();
  }

  private renderContent(): void {
    if (this.exposures.length === 0) {
      this.setContent(`<div class="panel-empty">${t('common.noDataAvailable')}</div>`);
      return;
    }

    const totalAffected = this.exposures.reduce((sum, e) => sum + e.exposedPopulation, 0);

    const cards = this.exposures.slice(0, 30).map(e => {
      const typeIcon = this.getTypeIcon(e.eventType);
      const popClass = e.exposedPopulation >= 1_000_000 ? ' popexp-pop-large' : '';
      return `<div class="popexp-card">
        <div class="popexp-card-name">${typeIcon} ${escapeHtml(e.eventName)}</div>
        <div class="popexp-card-meta">
          <span class="popexp-card-pop${popClass}">${t('components.populationExposure.affectedCount', { count: formatPopulation(e.exposedPopulation) })}</span>
          <span class="popexp-card-radius">${t('components.populationExposure.radiusKm', { km: String(e.exposureRadiusKm) })}</span>
        </div>
      </div>`;
    }).join('');

    this.setContent(`
      <div class="popexp-panel-content">
        <div class="popexp-summary">
          <span class="popexp-label">${t('components.populationExposure.totalAffected')}</span>
          <span class="popexp-total">${formatPopulation(totalAffected)}</span>
        </div>
        <div class="popexp-list">${cards}</div>
      </div>
    `);
  }

  private getTypeIcon(type: string): string {
    switch (type) {
      case 'state-based':
      case 'non-state':
      case 'one-sided':
      case 'conflict':
      case 'battle':
        return '\u2694\uFE0F';
      case 'earthquake':
        return '\uD83C\uDF0D';
      case 'flood':
        return '\uD83C\uDF0A';
      case 'fire':
      case 'wildfire':
        return '\uD83D\uDD25';
      default:
        return '\uD83D\uDCCD';
    }
  }
}
