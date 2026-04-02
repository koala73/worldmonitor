import { Panel } from './Panel';
import type { ThermalEscalationCluster, ThermalEscalationWatch } from '@/services/thermal-escalation';
import { escapeHtml } from '@/utils/sanitize';

// P1: allowlists prevent unescaped API values from injecting into class attribute context
const STATUS_CLASS: Record<string, string> = {
  spike: 'spike', persistent: 'persistent', elevated: 'elevated', normal: 'normal',
};

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
      const row = (e.target as HTMLElement).closest<HTMLElement>('.te-card');
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

    const footer = this.fetchedAt && this.fetchedAt.getTime() > 0
      ? `Updated ${this.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

    this.setContent(`
      <div class="te-panel">
        ${this.renderSummary()}
        <div class="te-list">
          ${this.clusters.map(c => this.renderCard(c)).join('')}
        </div>
        ${footer ? `<div class="te-footer">${escapeHtml(footer)}</div>` : ''}
      </div>
    `);
  }

  private renderSummary(): string {
    const { clusterCount, elevatedCount, spikeCount, persistentCount, conflictAdjacentCount, highRelevanceCount } = this.summary;
    // Only show non-zero sub-stats to reduce visual noise
    const stats = [
      { val: elevatedCount, label: 'Elevated', cls: 'te-stat-elevated' },
      { val: spikeCount, label: 'Spikes', cls: 'te-stat-spike' },
      { val: persistentCount, label: 'Persist', cls: 'te-stat-persistent' },
      { val: conflictAdjacentCount, label: 'Conflict', cls: 'te-stat-conflict' },
      { val: highRelevanceCount, label: 'Strategic', cls: 'te-stat-strategic' },
    ].filter(s => s.val > 0);
    return `
      <div class="te-summary">
        <div class="te-stat">
          <span class="te-stat-val">${clusterCount}</span>
          <span class="te-stat-label">Total</span>
        </div>
        ${stats.map(s => `
        <div class="te-stat ${s.cls}">
          <span class="te-stat-val">${s.val}</span>
          <span class="te-stat-label">${s.label}</span>
        </div>`).join('')}
      </div>
    `;
  }

  private renderCard(c: ThermalEscalationCluster): string {
    // P1: use allowlisted class names, never raw API strings in attributes
    const statusClass = STATUS_CLASS[c.status] ?? 'normal';

    const persistence = c.persistenceHours >= 24
      ? `${Math.round(c.persistenceHours / 24)}d`
      : `${Math.round(c.persistenceHours)}h`;
    const frpDisplay = c.totalFrp >= 1000 ? `${(c.totalFrp / 1000).toFixed(1)}k` : c.totalFrp.toFixed(0);
    const deltaSign = c.countDelta > 0 ? '+' : '';
    const deltaClass = c.countDelta > 0 ? 'pos' : c.countDelta < 0 ? 'neg' : '';

    // Status badge + at most one context badge (conflict > energy > industrial) + strategic if high
    const contextBadge =
      c.context === 'conflict_adjacent' ? '<span class="te-badge te-badge-conflict">conflict-adj</span>' :
      c.context === 'energy_adjacent' ? '<span class="te-badge te-badge-energy">energy-adj</span>' :
      c.context === 'industrial' ? '<span class="te-badge te-badge-industrial">industrial</span>' : '';
    const badges = [
      `<span class="te-badge te-badge-${statusClass}">${escapeHtml(c.status)}</span>`,
      contextBadge,
      c.strategicRelevance === 'high' ? '<span class="te-badge te-badge-strategic">strategic</span>' : '',
    ].filter(Boolean).join('');

    const age = formatAge(c.lastDetectedAt);

    return `
      <div class="te-card te-card-${statusClass}" data-lat="${c.lat}" data-lon="${c.lon}">
        <div class="te-card-accent"></div>
        <div class="te-card-body">
          <div class="te-region">${escapeHtml(c.regionLabel)}</div>
          <div class="te-meta">${c.observationCount} obs · ${c.uniqueSourceCount} src</div>
          <div class="te-badges">${badges}</div>
        </div>
        <div class="te-metrics">
          <div class="te-frp">${escapeHtml(frpDisplay)} <span class="te-frp-unit">MW</span></div>
          <div class="te-delta ${deltaClass}">${escapeHtml(`${deltaSign}${Math.round(c.countDelta)}`)} · z${c.zScore.toFixed(1)}</div>
          <div class="te-persist">${escapeHtml(persistence)}</div>
          <div class="te-last">${escapeHtml(age)}</div>
        </div>
      </div>
    `;
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
