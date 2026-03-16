import { Panel } from './Panel';
import type { RadiationObservation, RadiationWatchResult } from '@/services/radiation';
import { escapeHtml } from '@/utils/sanitize';

export class RadiationWatchPanel extends Panel {
  private observations: RadiationObservation[] = [];
  private fetchedAt: Date | null = null;
  private summary: RadiationWatchResult['summary'] = { anomalyCount: 0, elevatedCount: 0, spikeCount: 0 };
  private onLocationClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'radiation-watch',
      title: 'Radiation Watch (US)',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Seeded EPA RadNet readings with rolling-baseline anomaly scoring. This panel answers what is normal, what is elevated, and where readings have spiked.',
    });
    this.showLoading('Loading radiation data...');

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
      this.setContent('<div class="panel-empty">No radiation observations available.</div>');
      return;
    }

    const rows = this.observations.map((obs) => {
      const observed = formatObservedAt(obs.observedAt);
      const reading = formatReading(obs.value, obs.unit);
      const baseline = formatReading(obs.baselineValue, obs.unit);
      const delta = formatDelta(obs.delta, obs.unit, obs.zScore);
      return `
        <tr class="radiation-row" data-lat="${obs.lat}" data-lon="${obs.lon}">
          <td class="radiation-location">
            <div class="radiation-location-name">${escapeHtml(obs.location)}</div>
            <div class="radiation-location-meta">${escapeHtml(obs.source)} · ${escapeHtml(baseline)} baseline</div>
          </td>
          <td class="radiation-reading">${escapeHtml(reading)}</td>
          <td class="radiation-delta">${escapeHtml(delta)}</td>
          <td><span class="radiation-severity radiation-severity-${obs.severity}">${escapeHtml(obs.severity)}</span></td>
          <td><span class="radiation-freshness radiation-freshness-${obs.freshness}">${escapeHtml(obs.freshness)}</span></td>
          <td class="radiation-observed">${escapeHtml(observed)}</td>
        </tr>
      `;
    }).join('');

    const summary = `
      <div class="radiation-summary">
        <div class="radiation-summary-card">
          <span class="radiation-summary-label">Anomalies</span>
          <span class="radiation-summary-value">${this.summary.anomalyCount}</span>
        </div>
        <div class="radiation-summary-card">
          <span class="radiation-summary-label">Elevated</span>
          <span class="radiation-summary-value">${this.summary.elevatedCount}</span>
        </div>
        <div class="radiation-summary-card radiation-summary-card-spike">
          <span class="radiation-summary-label">Spikes</span>
          <span class="radiation-summary-value">${this.summary.spikeCount}</span>
        </div>
      </div>
    `;

    const footer = this.fetchedAt
      ? `Updated ${this.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    this.setContent(`
      <div class="radiation-panel-content">
        ${summary}
        <table class="radiation-table">
          <thead>
            <tr>
              <th>Station</th>
              <th>Reading</th>
              <th>Delta</th>
              <th>Status</th>
              <th>Freshness</th>
              <th>Observed</th>
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
    return `${hours}h ago`;
  }
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}
