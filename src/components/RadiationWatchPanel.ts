import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { RadiationObservation, RadiationWatchResult } from '@/services/radiation';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { bindActivationKeys } from '@/utils/activation';
import type { ResolvedScope } from '@/services/tab-focus';
import { countryCodeFromName } from '@/services/scope-attribution';
import { PanelScopeFilter, focusedEmptyHtml, scopeTagHtml, type ScopeRow } from './panel-scope-filter';

export class RadiationWatchPanel extends Panel {
  private observations: RadiationObservation[] = [];
  private fetchedAt: Date | null = null;
  private summary: RadiationWatchResult['summary'] = {
    anomalyCount: 0,
    elevatedCount: 0,
    spikeCount: 0,
    corroboratedCount: 0,
    lowConfidenceCount: 0,
    conflictingCount: 0,
    convertedFromCpmCount: 0,
  };
  private onLocationClick?: (lat: number, lon: number) => void;
  // Dashboard focus (#10453): each station names its country ("Japan").
  private readonly scopeFilter: PanelScopeFilter;
  private hasData = false;
  /** A refresh is in flight: the loading indicator must stay until setData lands. */
  private refreshing = false;

  constructor() {
    super({
      id: 'radiation-watch',
      title: t('components.radiationWatch.title'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.radiationWatch.infoTooltip'),
    });
    this.scopeFilter = new PanelScopeFilter({ content: this.content, onChange: () => this.render() });
    this.showLoading(t('components.radiationWatch.loading'));

    this.content.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.radiation-row');
      if (!row) return;
      const lat = Number(row.dataset.lat);
      const lon = Number(row.dataset.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) this.onLocationClick?.(lat, lon);
    });
    bindActivationKeys(this.content, '.radiation-row');
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public setData(data: RadiationWatchResult): void {
    this.observations = data.observations;
    this.fetchedAt = data.fetchedAt;
    this.summary = data.summary;
    this.hasData = true;
    this.refreshing = false;
    this.render();
  }

  public override applyScope(scope: ResolvedScope | null): void {
    if (!this.scopeFilter.setScope(scope)) return;
    // The next successful setData draws with the new focus; redrawing now
    // would erase a load failure or the loading state.
    if (this.hasData && !this.showingLoadFailure && !this.refreshing) this.render();
  }

  public override showLoading(message?: string): void {
    this.refreshing = true;
    this.scopeFilter?.hideStrip();
    super.showLoading(message);
  }

  public override showError(message?: string, onRetry?: () => void, autoRetrySeconds?: number): void {
    this.refreshing = false;
    this.scopeFilter.hideStrip();
    super.showError(message, onRetry, autoRetrySeconds);
  }

  private render(): void {
    const view = this.scopeFilter.view(this.observations, (obs) => countryCodeFromName(obs.country));
    this.setCount(view.rows.length);
    if (this.observations.length === 0) {
      this.scopeFilter.hideStrip();
      this.setSafeContent(unsafeRawHtml(`<div class="panel-empty">${escapeHtml(t('components.radiationWatch.empty'))}</div>`, 'legacy Panel.setContent() migration'));
      return;
    }
    this.scopeFilter.renderStrip(view);
    if (view.emptyByFocus) {
      this.setSafeContent(unsafeRawHtml(focusedEmptyHtml(t('focus.filter.emptyRadiation')), 'focus empty state: escaped by focusedEmptyHtml'));
      return;
    }
    const rowFor = new Map<RadiationObservation, ScopeRow<RadiationObservation>>(view.rows.map((row) => [row.item, row]));
    // Under a focus the cards count the stations shown; the server's summary
    // covers the whole feed.
    const summaryCounts = this.scopeFilter.filtering
      ? summarize(view.rows.map((row) => row.item))
      : this.summary;

    const rows = view.rows.map(({ item: obs }) => {
      const observed = formatObservedAt(obs.observedAt);
      const reading = formatReading(obs.value, obs.unit);
      const baseline = formatReading(obs.baselineValue, obs.unit);
      const delta = formatDelta(obs.delta, obs.unit, obs.zScore);
      const sourceLine = formatSourceLine(obs);
      const confidence = formatConfidence(obs.confidence);
      const flags = [
        scopeTagHtml(rowFor.get(obs)),
        `<span class="radiation-badge radiation-confidence radiation-confidence-${obs.confidence}">${escapeHtml(confidence)}</span>`,
        obs.corroborated ? `<span class="radiation-badge radiation-flag-confirmed">${escapeHtml(t('components.radiationWatch.flags.confirmed'))}</span>` : '',
        obs.conflictingSources ? `<span class="radiation-badge radiation-flag-conflict">${escapeHtml(t('components.radiationWatch.flags.conflict'))}</span>` : '',
        obs.convertedFromCpm ? `<span class="radiation-badge radiation-flag-converted">${escapeHtml(t('components.radiationWatch.flags.cpmDerived'))}</span>` : '',
        `<span class="radiation-badge radiation-freshness radiation-freshness-${obs.freshness}">${escapeHtml(obs.freshness)}</span>`,
      ].filter(Boolean).join('');
      return `
        <tr class="radiation-row" data-lat="${obs.lat}" data-lon="${obs.lon}" tabindex="0">
          <td class="radiation-location">
            <div class="radiation-location-name">${escapeHtml(obs.location)}</div>
            <div class="radiation-location-meta">${escapeHtml(sourceLine)} · ${escapeHtml(t('components.radiationWatch.baseline', { value: baseline }))}</div>
            <div class="radiation-location-flags">${flags}</div>
          </td>
          <td class="radiation-reading">${escapeHtml(reading)}</td>
          <td class="radiation-delta">${escapeHtml(delta)}</td>
          <td><span class="radiation-severity radiation-severity-${obs.severity}">${escapeHtml(obs.severity)}</span></td>
          <td class="radiation-observed">${escapeHtml(observed)}</td>
        </tr>
      `;
    }).join('');

    const summary = `
      <div class="radiation-summary">
        <div class="radiation-summary-card">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.anomalies'))}</span>
          <span class="radiation-summary-value">${summaryCounts.anomalyCount}</span>
        </div>
        <div class="radiation-summary-card">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.elevated'))}</span>
          <span class="radiation-summary-value">${summaryCounts.elevatedCount}</span>
        </div>
        <div class="radiation-summary-card radiation-summary-card-confirmed">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.confirmed'))}</span>
          <span class="radiation-summary-value">${summaryCounts.corroboratedCount}</span>
        </div>
        <div class="radiation-summary-card radiation-summary-card-low-confidence">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.lowConfidence'))}</span>
          <span class="radiation-summary-value">${summaryCounts.lowConfidenceCount}</span>
        </div>
        <div class="radiation-summary-card radiation-summary-card-conflict">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.conflicts'))}</span>
          <span class="radiation-summary-value">${summaryCounts.conflictingCount}</span>
        </div>
        <div class="radiation-summary-card radiation-summary-card-spike">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.spikes'))}</span>
          <span class="radiation-summary-value">${summaryCounts.spikeCount}</span>
        </div>
      </div>
    `;

    const footer = this.fetchedAt
      ? t('components.radiationWatch.footer.updated', { time: this.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
      : '';

    this.setSafeContent(unsafeRawHtml(`
      <div class="radiation-panel-content">
        ${summary}
        <div class="table-scroll" role="group" tabindex="0" aria-labelledby="${this.panelId}Title">
          <table class="wm-table radiation-table">
            <thead>
              <tr>
                <th scope="col">${escapeHtml(t('components.radiationWatch.headers.station'))}</th>
                <th scope="col">${escapeHtml(t('components.radiationWatch.headers.reading'))}</th>
                <th scope="col">${escapeHtml(t('components.radiationWatch.headers.delta'))}</th>
                <th scope="col">${escapeHtml(t('components.radiationWatch.headers.status'))}</th>
                <th scope="col">${escapeHtml(t('components.radiationWatch.headers.observed'))}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="radiation-footer">${escapeHtml(footer)}</div>
      </div>
    `, 'legacy Panel.setContent() migration'));

  }
}

function summarize(observations: RadiationObservation[]): RadiationWatchResult['summary'] {
  return {
    anomalyCount: observations.filter((obs) => obs.severity !== 'normal').length,
    elevatedCount: observations.filter((obs) => obs.severity === 'elevated').length,
    spikeCount: observations.filter((obs) => obs.severity === 'spike').length,
    corroboratedCount: observations.filter((obs) => obs.corroborated).length,
    lowConfidenceCount: observations.filter((obs) => obs.confidence === 'low').length,
    conflictingCount: observations.filter((obs) => obs.conflictingSources).length,
    convertedFromCpmCount: observations.filter((obs) => obs.convertedFromCpm).length,
  };
}

function formatReading(value: number, unit: string): string {
  const precision = unit === 'nSv/h' ? 1 : 0;
  return `${value.toFixed(precision)} ${unit}`;
}

function formatDelta(value: number, unit: string, zScore: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)} ${unit} · z${zScore.toFixed(1)}`;
}

function formatObservedAt(date: Date): string {
  const ageMs = Date.now() - date.getTime();
  if (ageMs < 24 * 60 * 60 * 1000) {
    const hours = Math.max(1, Math.floor(ageMs / (60 * 60 * 1000)));
    return t('components.radiationWatch.observed.hoursAgo', { count: hours });
  }
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days < 30) return t('components.radiationWatch.observed.daysAgo', { count: days });
  return date.toISOString().slice(0, 10);
}

function formatSourceLine(observation: RadiationObservation): string {
  const uniqueSources = [...new Set(observation.contributingSources)];
  if (uniqueSources.length <= 1) return observation.source;
  return uniqueSources.join(' + ');
}

function formatConfidence(value: RadiationObservation['confidence']): string {
  switch (value) {
    case 'high':
      return t('components.radiationWatch.confidence.high');
    case 'medium':
      return t('components.radiationWatch.confidence.medium');
    default:
      return t('components.radiationWatch.confidence.low');
  }
}
