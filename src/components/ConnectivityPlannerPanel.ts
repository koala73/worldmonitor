/**
 * ConnectivityPlannerPanel
 * ISP vs Starlink comparison panel with cost curves and power overhead display.
 */

interface ConnectivityState {
  lat: number | null;
  lon: number | null;
  country: string;
  objective: 'cost' | 'latency' | 'reliability';
  starlinkCostOverride: number | null;
  ispCostOverride: number | null;
  loading: boolean;
  error: string | null;
  data: Record<string, unknown> | null;
}

export class ConnectivityPlannerPanel {
  private el: HTMLElement;
  private state: ConnectivityState = {
    lat: null, lon: null, country: 'US', objective: 'cost',
    starlinkCostOverride: null, ispCostOverride: null,
    loading: false, error: null, data: null,
  };

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.classList.add('opensens-panel', 'connectivity-planner-panel');
    this.render();
  }

  async load(lat: number, lon: number, country: string): Promise<void> {
    this.state = { ...this.state, lat, lon, country, loading: true, error: null };
    this.render();
    try {
      const params = new URLSearchParams({
        lat: lat.toString(), lon: lon.toString(),
        country, objective: this.state.objective,
        ...(this.state.starlinkCostOverride != null && { starlink_cost: String(this.state.starlinkCostOverride) }),
        ...(this.state.ispCostOverride != null && { isp_cost: String(this.state.ispCostOverride) }),
      });
      const res = await fetch(`/api/opensens/connectivity?${params}`);
      const data = await res.json();
      this.state = { ...this.state, data, loading: false };
    } catch (err) {
      this.state = { ...this.state, loading: false, error: (err as Error).message };
    }
    this.render();
  }

  private render(): void {
    const { loading, error, data, objective } = this.state;
    if (loading) { this.el.innerHTML = '<div class="panel-loading">Fetching connectivity data…</div>'; return; }
    if (error) { this.el.innerHTML = `<div class="panel-error">${error}</div>`; return; }
    if (!data) {
      this.el.innerHTML = '<div class="panel-placeholder">Select a location to compare connectivity options.</div>';
      return;
    }

    const { options, recommendation, meta } = data as {
      options: Array<{ provider: string; label: string; monthlyCostUsd: number; downloadMbps: number; latencyMs: number; powerOverheadW: number; reliability: number; notes: string[] }>;
      recommendation: { provider: string; reason: string };
      meta: { source: string; confidence: string; warnings: string[]; cachedAt: string };
    };

    const optRows = options.map((o) => {
      const isBest = o.provider === recommendation?.provider;
      return `
        <tr class="${isBest ? 'best-option' : ''}">
          <td>${o.label} ${isBest ? '★' : ''}</td>
          <td>$${o.monthlyCostUsd}/mo</td>
          <td>${o.downloadMbps} Mbps</td>
          <td>${o.latencyMs} ms</td>
          <td>${o.powerOverheadW} W</td>
          <td>${(o.reliability * 100).toFixed(0)}%</td>
        </tr>`;
    }).join('');

    this.el.innerHTML = `
      <div class="panel-header">
        <h3>Connectivity Planner</h3>
        <span class="confidence-badge confidence-${meta?.confidence}">${meta?.confidence} confidence</span>
      </div>

      <div class="objective-selector">
        Optimise for:
        ${(['cost','latency','reliability'] as const).map((obj) =>
          `<button class="obj-btn ${objective === obj ? 'active' : ''}" data-obj="${obj}">${obj}</button>`
        ).join('')}
      </div>

      <table class="connectivity-table">
        <thead>
          <tr><th>Provider</th><th>Cost</th><th>Speed</th><th>Latency</th><th>Power</th><th>Reliability</th></tr>
        </thead>
        <tbody>${optRows}</tbody>
      </table>

      ${recommendation ? `<div class="recommendation">★ ${recommendation.reason}</div>` : ''}

      <div class="data-source-footer">
        <span>Source: ${meta?.source}</span>
        <span>Updated: ${meta?.cachedAt ? new Date(meta.cachedAt).toLocaleString() : '—'}</span>
        ${meta?.warnings?.length ? `<p class="warning">${meta.warnings.join(' | ')}</p>` : ''}
      </div>`;

    this.el.querySelectorAll<HTMLButtonElement>('.obj-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.objective = btn.dataset.obj as 'cost' | 'latency' | 'reliability';
        if (this.state.lat && this.state.lon) this.load(this.state.lat, this.state.lon, this.state.country);
      });
    });
  }

  destroy(): void { this.el.innerHTML = ''; }
}
