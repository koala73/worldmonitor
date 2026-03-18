import { Panel } from './Panel';
import type { ThermalEscalationCluster, ThermalEscalationWatch } from '@/services/thermal-escalation';
import { escapeHtml } from '@/utils/sanitize';

export class ThermalEscalationPanel extends Panel {
  private clusters: ThermalEscalationCluster[] = [];
  private fetchedAt: Date | null = null;
  private summary: ThermalEscalationWatch['summary'] = {
    clusterCount: 0,
    elevatedCount: 0,
    spikeCount: 0,
    persistentCount: 0,
    conflictAdjacentCount: 0,
    highRelevanceCount: 0,
  };
  private onLocationClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'thermal-escalation',
      title: 'Thermal Escalation',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Seeded FIRMS/VIIRS thermal anomaly clusters with baseline comparison, persistence tracking, and strategic context. This panel answers where thermal activity is abnormal and which clusters may signal conflict, industrial disruption, or escalation.',
    });
    this.showLoading('Loading thermal data...');

    this.content.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.thermal-row');
      if (!row) return;
      const lat = Number(row.dataset.lat);
      const lon = Number(row.dataset.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) this.onLocationClick?.(lat, lon);
    });
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public setData(data: ThermalEscalationWatch): void {
    this.clusters = data.clusters;
    this.fetchedAt = data.fetchedAt;
    this.summary = data.summary;
    this.setCount(data.clusters.length);
    this.render();
  }

  private render(): void {
    if (this.clusters.length === 0) {
      this.setContent('<div class="panel-empty">No thermal escalation clusters detected.</div>');
      return;
    }

    const rows = this.clusters.map((c) => {
      const age = formatAge(c.lastDetectedAt);
      const persistence = c.persistenceHours >= 24 ? `${Math.round(c.persistenceHours / 24)}d` : `${Math.round(c.persistenceHours)}h`;
      const frpDisplay = c.totalFrp >= 1000 ? `${(c.totalFrp / 1000).toFixed(1)}k` : c.totalFrp.toFixed(0);
      const deltaSign = c.countDelta > 0 ? '+' : '';
      const flags = [
        `<span class="thermal-badge thermal-status thermal-status-${c.status}">${escapeHtml(c.status)}</span>`,
        `<span class="thermal-badge thermal-confidence thermal-confidence-${c.confidence}">${escapeHtml(c.confidence)}</span>`,
        c.strategicRelevance === 'high' ? '<span class="thermal-badge thermal-flag-strategic">strategic</span>' : '',
        c.context === 'conflict_adjacent' ? '<span class="thermal-badge thermal-flag-conflict">conflict-adjacent</span>' : '',
        c.context === 'energy_adjacent' ? '<span class="thermal-badge thermal-flag-energy">energy-adjacent</span>' : '',
        c.context === 'industrial' ? '<span class="thermal-badge thermal-flag-industrial">industrial</span>' : '',
      ].filter(Boolean).join('');
      const assets = c.nearbyAssets.length > 0
        ? `<div class="thermal-assets">${c.nearbyAssets.slice(0, 3).map(a => escapeHtml(a)).join(' · ')}</div>`
        : '';
      return `
        <tr class="thermal-row" data-lat="${c.lat}" data-lon="${c.lon}">
          <td class="thermal-location">
            <div class="thermal-location-name">${escapeHtml(c.regionLabel)}</div>
            <div class="thermal-location-meta">${escapeHtml(c.countryName)} · ${c.observationCount} obs · ${c.uniqueSourceCount} src</div>
            <div class="thermal-location-flags">${flags}</div>
            ${assets}
          </td>
          <td class="thermal-frp">${escapeHtml(frpDisplay)} MW</td>
          <td class="thermal-delta">${escapeHtml(`${deltaSign}${Math.round(c.countDelta)}`)} · z${c.zScore.toFixed(1)}</td>
          <td class="thermal-persistence">${escapeHtml(persistence)}</td>
          <td class="thermal-observed">${escapeHtml(age)}</td>
        </tr>
      `;
    }).join('');

    const summary = `
      <div class="thermal-summary">
        <div class="thermal-summary-card">
          <span class="thermal-summary-label">Clusters</span>
          <span class="thermal-summary-value">${this.summary.clusterCount}</span>
        </div>
        <div class="thermal-summary-card thermal-summary-card-elevated">
          <span class="thermal-summary-label">Elevated</span>
          <span class="thermal-summary-value">${this.summary.elevatedCount}</span>
        </div>
        <div class="thermal-summary-card thermal-summary-card-spike">
          <span class="thermal-summary-label">Spikes</span>
          <span class="thermal-summary-value">${this.summary.spikeCount}</span>
        </div>
        <div class="thermal-summary-card thermal-summary-card-persistent">
          <span class="thermal-summary-label">Persistent</span>
          <span class="thermal-summary-value">${this.summary.persistentCount}</span>
        </div>
        <div class="thermal-summary-card thermal-summary-card-conflict">
          <span class="thermal-summary-label">Conflict-Adj</span>
          <span class="thermal-summary-value">${this.summary.conflictAdjacentCount}</span>
        </div>
        <div class="thermal-summary-card thermal-summary-card-strategic">
          <span class="thermal-summary-label">High Relevance</span>
          <span class="thermal-summary-value">${this.summary.highRelevanceCount}</span>
        </div>
      </div>
    `;

    const footer = this.fetchedAt && this.fetchedAt.getTime() > 0
      ? `Updated ${this.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    this.setContent(`
      <div class="thermal-panel-content">
        ${summary}
        <table class="thermal-table">
          <thead>
            <tr>
              <th>Cluster</th>
              <th>FRP</th>
              <th>Delta</th>
              <th>Duration</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="thermal-footer">${escapeHtml(footer)}</div>
      </div>
    `);
  }
}

function formatAge(date: Date): string {
  const ageMs = Date.now() - date.getTime();
  if (ageMs < 60 * 60 * 1000) {
    const mins = Math.max(1, Math.floor(ageMs / (60 * 1000)));
    return `${mins}m ago`;
  }
  if (ageMs < 24 * 60 * 60 * 1000) {
    const hours = Math.max(1, Math.floor(ageMs / (60 * 60 * 1000)));
    return `${hours}h ago`;
  }
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}
