import { Panel } from './Panel';
import { joinSafeHtml, safeHtml, unsafeRawHtml } from '@/utils/sanitize';
import type { ExposureCoverage, PopulationExposure } from '@/types';
import {
  addExposureCoverage, enrichEventsWithExposure, exposureEventCountry, formatPopulation,
  ucdpExposureEvents, type EventForExposure, type ExposureSources,
} from '@/services/population-exposure';
import { t } from '@/services/i18n';
import type { ResolvedScope } from '@/services/tab-focus';
import { fetchUcdpEvents } from '@/services/conflict';
import { PanelScopeFilter, focusedEmptyHtml, scopeTagHtml, type ScopeRow } from './panel-scope-filter';

type FullSet = { events: EventForExposure[]; fromCache: boolean };
type FullSetLoader = () => Promise<FullSet | null>;
const loadFullSet: FullSetLoader = async () => {
  const result = await fetchUcdpEvents();
  return result.success ? { events: ucdpExposureEvents(result.exposure.events), fromCache: result.fromCache } : null;
};

export class PopulationExposurePanel extends Panel {
  private readonly scopeFilter: PanelScopeFilter;
  private readonly loadFullSet: FullSetLoader;
  private sources?: ExposureSources;
  private exposures: PopulationExposure[] = [];
  private coverage?: ExposureCoverage;
  private hasData = false;
  private hasCachedUcdp = false;
  private fullSet: FullSet | null = null;
  private fullSetState: 'idle' | 'loading' | 'failed' = 'idle';
  private request = 0;

  constructor(options: { loadFullSet?: FullSetLoader } = {}) {
    super({
      id: 'population-exposure',
      title: t('panels.populationExposure'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.populationExposure.infoTooltip'),
    });
    this.loadFullSet = options.loadFullSet ?? loadFullSet;
    this.scopeFilter = new PanelScopeFilter({ content: this.content, onChange: () => this.render() });
    this.showLoading(t('common.calculatingExposure'));
  }

  public setExposures(exposures: PopulationExposure[], hasCachedUcdp = false, coverage?: ExposureCoverage, sources?: ExposureSources): void {
    this.hasCachedUcdp = hasCachedUcdp;
    this.exposures = exposures;
    this.coverage = coverage;
    this.sources = sources;
    this.hasData = true;
    this.fullSet = null;
    this.fullSetState = 'idle';
    this.request++;
    this.ensureFullSet();
    this.render();
  }

  public override applyScope(scope: ResolvedScope | null): void {
    if (!this.scopeFilter.setScope(scope)) return;
    if (this.fullSetState === 'failed') this.fullSetState = 'idle';
    this.ensureFullSet();
    if (this.hasData && !this.showingLoadFailure) this.render();
  }

  public override showLoading(message?: string): void {
    this.scopeFilter?.hideStrip();
    super.showLoading(message);
  }

  public override showError(message?: string, onRetry?: () => void, autoRetrySeconds?: number): void {
    this.scopeFilter.hideStrip();
    super.showError(message, onRetry, autoRetrySeconds);
  }

  private ensureFullSet(): void {
    if (!this.scopeFilter.scope || !this.sources?.ucdpIsProjection || this.fullSet || this.fullSetState !== 'idle') return;
    this.fullSetState = 'loading';
    const request = ++this.request;
    Promise.resolve().then(() => this.loadFullSet()).then(result => {
      if (request !== this.request) return;
      this.fullSet = result;
      this.fullSetState = result ? 'idle' : 'failed';
      if (!this.showingLoadFailure) this.render();
    }, () => {
      if (request !== this.request) return;
      this.fullSetState = 'failed';
      if (!this.showingLoadFailure) this.render();
    });
  }

  private render(): void {
    const fromCache = this.scopeFilter.scope && this.fullSet ? this.fullSet.fromCache : this.hasCachedUcdp;
    if (fromCache) this.setDataBadge('cached', 'UCDP');
    else this.clearDataBadge();
    let exposures = this.exposures;
    let coverage = this.coverage;
    const tags = new Map<PopulationExposure, ScopeRow<unknown>>();
    let emptyByFocus = false;
    let partial = false;
    if (this.scopeFilter.scope && this.sources) {
      const events = [
        ...this.sources.unrest.map(event => ({ event, source: 'unrest' as const })),
        ...(this.fullSet?.events ?? this.sources.ucdp).map(event => ({ event, source: 'ucdp' as const })),
      ];
      const view = this.scopeFilter.view(events, row => exposureEventCountry(row.event));
      partial = this.sources.ucdpIsProjection && !this.fullSet;
      this.scopeFilter.renderStrip(view, undefined, partial
        ? t(this.fullSetState === 'loading' ? 'focus.filter.partialExposureLoading' : 'focus.filter.partialExposure')
        : undefined);
      const enrichSource = (source: 'unrest' | 'ucdp') => {
        const rows = view.rows.filter(row => row.item.source === source);
        const byId = new Map(rows.map(row => [row.item.event.id, row]));
        const result = enrichEventsWithExposure(rows.map(row => row.item.event), 10, source === 'ucdp');
        for (const exposure of result.exposures) {
          const row = byId.get(exposure.eventId);
          if (row) tags.set(exposure, row);
        }
        return result;
      };
      const unrest = enrichSource('unrest');
      const ucdp = enrichSource('ucdp');
      exposures = [...unrest.exposures, ...ucdp.exposures];
      exposures.sort((a, b) => (tags.get(a)?.rank ?? 0) - (tags.get(b)?.rank ?? 0) || b.exposedPopulation - a.exposedPopulation);
      // Global projection coverage cannot describe a selected country. Until the
      // full set arrives, report unrest-only counts and explicit pending UCDP.
      coverage = partial ? { ...unrest.coverage, ucdpPending: true } : addExposureCoverage(unrest.coverage, ucdp.coverage);
      emptyByFocus = view.emptyByFocus;
    } else {
      this.scopeFilter.hideStrip();
    }
    this.setCount(exposures.length);
    if (exposures.length === 0) {
      const message = partial ? t('focus.filter.emptyExposurePartial') : t('focus.filter.emptyExposure');
      this.setSafeContent(safeHtml`${emptyByFocus || partial
        ? unsafeRawHtml(focusedEmptyHtml(message), 'escaped focus empty state')
        : safeHtml`<div class="panel-empty">${t('components.populationExposure.empty')}</div>`}${this.renderCoverage(coverage)}`);
      return;
    }

    const cards = joinSafeHtml(exposures.slice(0, 30).map(e => {
      const typeIcon = this.getTypeIcon(e.eventType);
      return safeHtml`<div class="popexp-card">
        <div class="popexp-card-name">${typeIcon} ${e.eventName} ${unsafeRawHtml(scopeTagHtml(tags.get(e)), 'escaped scope tag')}</div>
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

  public override destroy(): void {
    this.request++;
    this.scopeFilter.destroy();
    super.destroy();
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
