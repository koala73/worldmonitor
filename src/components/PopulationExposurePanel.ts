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
      infoTooltip: `<strong>Population Exposure Estimates</strong>
        Estimated population within event impact radius.
        Based on WorldPop country density data.
        <ul>
          <li>Conflict: 50km radius</li>
          <li>Earthquake: 100km radius</li>
          <li>Flood: 100km radius</li>
          <li>Wildfire: 30km radius</li>
        </ul>`,
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
      <style>
        .popexp-panel-content { font-size: 12px; }
        .popexp-summary { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; margin-bottom: 6px; background: color-mix(in srgb, var(--threat-critical) 8%, transparent); border-radius: 4px; border-left: 3px solid var(--threat-critical); }
        .popexp-label { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
        .popexp-total { color: var(--accent); font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .popexp-list { display: flex; flex-direction: column; }
        .popexp-card { padding: 6px 10px; border-bottom: 1px solid var(--border-subtle); }
        .popexp-card:hover { background: var(--surface-hover); }
        .popexp-card-name { color: var(--text); font-size: 12px; line-height: 1.4; margin-bottom: 3px; word-break: break-word; }
        .popexp-card-meta { display: flex; justify-content: space-between; align-items: center; }
        .popexp-card-pop { color: var(--threat-critical); font-size: 11px; font-variant-numeric: tabular-nums; font-weight: 500; }
        .popexp-pop-large { color: var(--accent); font-weight: 700; }
        .popexp-card-radius { color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
      </style>
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
