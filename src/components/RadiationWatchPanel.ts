import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { RadiationObservation, RadiationWatchResult } from '@/services/radiation';
import { escapeHtml } from '@/utils/sanitize';

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

  constructor() {
    super({
      id: 'radiation-watch',
      title: t('components.radiationWatch.title'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.radiationWatch.infoTooltip'),
    });
    this.showLoading(t('components.radiationWatch.loading'));

    this.content.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.radiation-row');
      if (!row) return;
      const lat = Number(row.dataset.lat);
      const lon = Number(row.dataset.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) this.onLocationClick?.(lat, lon);
    });
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public setData(data: RadiationWatchResult): void {
    this.observations = data.observations;
    this.fetchedAt = data.fetchedAt;
    this.summary = data.summary;
    this.setCount(data.observations.length);
    this.render();
  }

  private render(): void {
    if (this.observations.length === 0) {
      this.setContent(`<div class="panel-empty">${escapeHtml(t('components.radiationWatch.empty'))}</div>`);
      return;
    }

    const rows = this.observations.map((obs) => {
      const observed = formatObservedAt(obs.observedAt);
      const reading = formatReading(obs.value, obs.unit);
      const baseline = formatReading(obs.baselineValue, obs.unit);
      const delta = formatDelta(obs.delta, obs.unit, obs.zScore);
      const sourceLine = formatSourceLine(obs);
      const confidence = formatConfidence(obs.confidence);
      const flags = [
        `<span class="radiation-badge radiation-confidence radiation-confidence-${obs.confidence}">${escapeHtml(confidence)}</span>`,
        obs.corroborated ? `<span class="radiation-badge radiation-flag-confirmed">${escapeHtml(t('components.radiationWatch.flags.confirmed'))}</span>` : '',
        obs.conflictingSources ? `<span class="radiation-badge radiation-flag-conflict">${escapeHtml(t('components.radiationWatch.flags.conflict'))}</span>` : '',
        obs.convertedFromCpm ? `<span class="radiation-badge radiation-flag-converted">${escapeHtml(t('components.radiationWatch.flags.cpmDerived'))}</span>` : '',
        `<span class="radiation-badge radiation-freshness radiation-freshness-${obs.freshness}">${escapeHtml(obs.freshness)}</span>`,
      ].filter(Boolean).join('');
      return `
        <tr class="radiation-row" data-lat="${obs.lat}" data-lon="${obs.lon}">
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
          <span class="radiation-summary-value">${this.summary.anomalyCount}</span>
        </div>
        <div class="radiation-summary-card">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.elevated'))}</span>
          <span class="radiation-summary-value">${this.summary.elevatedCount}</span>
        </div>
        <div class="radiation-summary-card radiation-summary-card-confirmed">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.confirmed'))}</span>
          <span class="radiation-summary-value">${this.summary.corroboratedCount}</span>
        </div>
        <div class="radiation-summary-card radiation-summary-card-low-confidence">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.lowConfidence'))}</span>
          <span class="radiation-summary-value">${this.summary.lowConfidenceCount}</span>
        </div>
        <div class="radiation-summary-card radiation-summary-card-conflict">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.conflicts'))}</span>
          <span class="radiation-summary-value">${this.summary.conflictingCount}</span>
        </div>
        <div class="radiation-summary-card radiation-summary-card-spike">
          <span class="radiation-summary-label">${escapeHtml(t('components.radiationWatch.summary.spikes'))}</span>
          <span class="radiation-summary-value">${this.summary.spikeCount}</span>
        </div>
      </div>
    `;

    const footer = this.fetchedAt
      ? t('components.radiationWatch.footer.updated', { time: this.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
      : '';

    this.setContent(`
      <div class="radiation-panel-content">
        ${summary}
        <table class="radiation-table">
          <thead>
            <tr>
              <th>${escapeHtml(t('components.radiationWatch.headers.station'))}</th>
              <th>${escapeHtml(t('components.radiationWatch.headers.reading'))}</th>
              <th>${escapeHtml(t('components.radiationWatch.headers.delta'))}</th>
              <th>${escapeHtml(t('components.radiationWatch.headers.status'))}</th>
              <th>${escapeHtml(t('components.radiationWatch.headers.observed'))}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="radiation-footer">${escapeHtml(footer)}</div>
      </div>
    `);

  }
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
