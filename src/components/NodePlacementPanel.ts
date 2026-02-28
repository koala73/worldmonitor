/**
 * NodePlacementPanel
 * Select a Starlink hub, find candidate sites within radius,
 * display fiber length estimates and site rankings.
 */

interface PlacementState {
  hubLat: number | null;
  hubLon: number | null;
  radiusKm: number;
  slack: number;
  costPerMeter: number;
  loading: boolean;
  error: string | null;
  data: Record<string, unknown> | null;
}

export class NodePlacementPanel {
  private el: HTMLElement;
  private state: PlacementState = {
    hubLat: null, hubLon: null, radiusKm: 3,
    slack: 1.1, costPerMeter: 15,
    loading: false, error: null, data: null,
  };

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.classList.add('opensens-panel', 'node-placement-panel');
    this.render();
  }

  async loadRoutes(
    hubLat: number, hubLon: number,
    sites: Array<{ id: string; lat: number; lon: number }>
  ): Promise<void> {
    this.state = { ...this.state, hubLat, hubLon, loading: true, error: null };
    this.render();
    try {
      const params = new URLSearchParams({
        hub_lat: hubLat.toString(),
        hub_lon: hubLon.toString(),
        sites: JSON.stringify(sites),
        slack: this.state.slack.toString(),
        cost_per_meter: this.state.costPerMeter.toString(),
        max_km: this.state.radiusKm.toString(),
      });
      const res = await fetch(`/api/opensens/routing?${params}`);
      const data = await res.json();
      this.state = { ...this.state, data, loading: false };
    } catch (err) {
      this.state = { ...this.state, loading: false, error: (err as Error).message };
    }
    this.render();
  }

  private render(): void {
    const { loading, error, data, radiusKm, slack, costPerMeter } = this.state;

    if (loading) { this.el.innerHTML = '<div class="panel-loading">Computing fiber routes…</div>'; return; }
    if (error) { this.el.innerHTML = `<div class="panel-error">${error}</div>`; return; }

    const { sites, meta } = (data ?? {}) as {
      sites?: Array<{ siteId: string; rank: number; estimatedFiberM: number; fiberCapexUsd: number; routingSource: string }>;
      meta?: { confidence: string; warnings: string[]; cachedAt: string };
    };

    const hubDisplay = this.state.hubLat
      ? `${this.state.hubLat.toFixed(4)}°, ${this.state.hubLon!.toFixed(4)}°`
      : 'Not set';

    const siteRows = (sites ?? []).map((s) => `
      <tr>
        <td>#${s.rank}</td>
        <td>${s.siteId}</td>
        <td>${(s.estimatedFiberM / 1000).toFixed(2)} km</td>
        <td>$${s.fiberCapexUsd.toLocaleString()}</td>
        <td>${s.routingSource === 'haversine-fallback' ? '⚠ est.' : '✓'}</td>
      </tr>`).join('');

    this.el.innerHTML = `
      <div class="panel-header">
        <h3>Node Placement</h3>
        ${meta ? `<span class="confidence-badge confidence-${meta.confidence}">${meta.confidence}</span>` : ''}
      </div>

      <div class="hub-info">
        <strong>Starlink Hub:</strong> ${hubDisplay}
        <button id="set-hub-btn">Set from map click</button>
      </div>

      <div class="controls">
        <label>Radius: <strong>${radiusKm} km</strong>
          <input type="range" min="0.5" max="10" step="0.5" value="${radiusKm}" id="radius-slider">
        </label>
        <label>Slack factor: <strong>${slack}</strong>
          <input type="range" min="1.0" max="2.0" step="0.05" value="${slack}" id="slack-slider">
        </label>
        <label>Fiber cost: <strong>$${costPerMeter}/m</strong>
          <input type="range" min="5" max="100" step="5" value="${costPerMeter}" id="cost-slider">
        </label>
      </div>

      ${sites?.length ? `
        <table class="sites-table">
          <thead><tr><th>Rank</th><th>Site ID</th><th>Fiber Length</th><th>Capex</th><th>Route</th></tr></thead>
          <tbody>${siteRows}</tbody>
        </table>
      ` : '<div class="panel-placeholder">Click "Set from map click" to place a Starlink hub, then select candidate sites.</div>'}

      ${meta?.warnings?.length ? `<div class="warnings">${meta.warnings.map((w) => `<p class="warning">⚠ ${w}</p>`).join('')}</div>` : ''}`;

    this.attachListeners();
  }

  private attachListeners(): void {
    this.el.querySelector('#radius-slider')?.addEventListener('input', (e) => {
      this.state.radiusKm = parseFloat((e.target as HTMLInputElement).value);
      this.render();
    });
    this.el.querySelector('#slack-slider')?.addEventListener('input', (e) => {
      this.state.slack = parseFloat((e.target as HTMLInputElement).value);
      this.render();
    });
    this.el.querySelector('#cost-slider')?.addEventListener('input', (e) => {
      this.state.costPerMeter = parseFloat((e.target as HTMLInputElement).value);
      this.render();
    });
  }

  destroy(): void { this.el.innerHTML = ''; }
}
