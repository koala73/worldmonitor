import { Panel } from './Panel';
import { joinSafeHtml, safeHtml } from '@/utils/sanitize';
import type { ExposureCoverage, PopulationExposure } from '@/types';
import { formatPopulation } from '@/services/population-exposure';
import { t } from '@/services/i18n';

export class PopulationExposurePanel extends Panel {
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

  public setExposures(exposures: PopulationExposure[], hasCachedUcdp = false, coverage?: ExposureCoverage): void {
    if (hasCachedUcdp) {
      this.setDataBadge('cached', 'UCDP');
    } else {
      this.clearDataBadge();
    }
    this.setCount(exposures.length);
    if (exposures.length === 0) {
      this.setSafeContent(safeHtml`<div class="panel-empty">${t('components.populationExposure.empty')}</div>${this.renderCoverage(coverage)}`);
      return;
    }

    const cards = joinSafeHtml(exposures.slice(0, 30).map(e => {
      const typeIcon = this.getTypeIcon(e.eventType);
      return safeHtml`<div class="popexp-card">
        <div class="popexp-card-name">${typeIcon} ${e.eventName}</div>
        <div class="popexp-card-pop">
          ${t('components.populationExposure.estimateWithin', { count: formatPopulation(e.exposedPopulation), km: e.exposureRadiusKm })}
          ${e.eventCount > 1 ? `· ${t('components.populationExposure.eventCount', { count: e.eventCount })}` : ''}
          ${e.locationPending ? `· ${t('components.populationExposure.locationPending')}` : ''}
        </div>
      </div>`;
    }));

    this.setSafeContent(safeHtml`
      <div class="popexp-panel-content">
        <div class="popexp-method">${t('components.populationExposure.method')}</div>
        <div class="popexp-list">${cards}</div>
        ${this.renderCoverage(coverage)}
      </div>
    `);
  }

  private renderCoverage(coverage: ExposureCoverage | undefined) {
    if (!coverage || (coverage.totalEvents === 0 && !coverage.ucdpPending)) return safeHtml``;
    const n = (value: number) => value.toLocaleString();
    const shown = coverage.totalEvents - coverage.withoutPreciseLocation - coverage.withoutEstimate - coverage.atOtherPlaces;
    return safeHtml`<div class="popexp-coverage">
      ${coverage.ucdpPending ? safeHtml`<div>${t('components.populationExposure.unrestCoverage')}</div>` : ''}
      <div>${t('components.populationExposure.coverageShown', { shown: n(shown), total: n(coverage.totalEvents) })}</div>
      <div>${t('components.populationExposure.coverageLeftOut', {
        imprecise: n(coverage.withoutPreciseLocation),
        noEstimate: n(coverage.withoutEstimate),
        otherPlaces: n(coverage.atOtherPlaces),
      })}</div>
      ${coverage.ucdpPending ? safeHtml`<div>${t('components.populationExposure.ucdpPending')}</div>` : ''}
    </div>`;
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
