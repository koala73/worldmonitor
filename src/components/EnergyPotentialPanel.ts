/**
 * EnergyPotentialPanel
 * Shows PV kWh/day forecast, seasonal range, and wind contribution with confidence bands.
 *
 * Data: /api/opensens/pv + /api/opensens/wind + /api/opensens/weather
 */

interface EnergyPanelState {
  lat: number | null;
  lon: number | null;
  pvKwp: number;
  loading: boolean;
  error: string | null;
  pvData: Record<string, unknown> | null;
  windData: Record<string, unknown> | null;
}

export class EnergyPotentialPanel {
  private el: HTMLElement;
  private state: EnergyPanelState = {
    lat: null, lon: null, pvKwp: 3,
    loading: false, error: null, pvData: null, windData: null,
  };

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.classList.add('opensens-panel', 'energy-potential-panel');
    this.render();
  }

  async load(lat: number, lon: number, pvKwp = 3): Promise<void> {
    this.state = { ...this.state, lat, lon, pvKwp, loading: true, error: null };
    this.render();

    try {
      const [pvRes, windRes] = await Promise.all([
        fetch(`/api/opensens/pv?lat=${lat}&lon=${lon}&kwp=${pvKwp}`),
        fetch(`/api/opensens/wind?lat=${lat}&lon=${lon}`),
      ]);
      const [pvData, windData] = await Promise.all([pvRes.json(), windRes.json()]);
      this.state = { ...this.state, pvData, windData, loading: false };
    } catch (err) {
      this.state = { ...this.state, loading: false, error: (err as Error).message };
    }
    this.render();
  }

  private render(): void {
    const { loading, error, pvData, windData, pvKwp } = this.state;

    if (loading) {
      this.el.innerHTML = `<div class="panel-loading">Fetching energy data…</div>`;
      return;
    }
    if (error) {
      this.el.innerHTML = `<div class="panel-error">${error}</div>`;
      return;
    }
    if (!pvData) {
      this.el.innerHTML = `
        <div class="panel-placeholder">
          <p>Click a location on the map to assess energy potential.</p>
        </div>`;
      return;
    }

    const { kwhPerDay, monthly, meta } = pvData as {
      kwhPerDay: { p10: number; p50: number; p90: number };
      monthly: { month: number; kwhEstimate: number }[];
      meta: { source: string; confidence: string; warnings: string[]; cachedAt: string };
    };
    const wind = windData as {
      viabilityScore: number;
      avgOutputW: { p50: number };
      disclaimer: string;
      meta: { confidence: string };
    };

    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const barMax = Math.max(...(monthly?.map((m) => m.kwhEstimate) ?? [1]));

    const monthBars = (monthly ?? []).map((m) => {
      const pct = ((m.kwhEstimate / barMax) * 100).toFixed(1);
      return `
        <div class="bar-group" title="${monthNames[m.month - 1]}: ${m.kwhEstimate.toFixed(1)} kWh/day">
          <div class="bar" style="height:${pct}%"></div>
          <span class="bar-label">${monthNames[m.month - 1].slice(0, 1)}</span>
        </div>`;
    }).join('');

    const windPct = wind?.viabilityScore ?? 0;
    const windAvgW = wind?.avgOutputW?.p50 ?? 0;
    const windKwh = ((windAvgW / 1000) * 24).toFixed(2);

    this.el.innerHTML = `
      <div class="panel-header">
        <h3>Energy Potential</h3>
        <span class="confidence-badge confidence-${meta?.confidence ?? 'low'}">${meta?.confidence ?? '?'} confidence</span>
      </div>

      <div class="pv-summary">
        <div class="metric-row">
          <span class="metric-label">PV Yield (${pvKwp} kWp)</span>
          <span class="metric-value">${kwhPerDay?.p50 ?? '—'} kWh/day</span>
        </div>
        <div class="confidence-range">
          <span>P10: ${kwhPerDay?.p10 ?? '—'}</span>
          <span class="range-bar"></span>
          <span>P90: ${kwhPerDay?.p90 ?? '—'}</span>
        </div>
      </div>

      <div class="monthly-chart" aria-label="Monthly PV yield chart">
        ${monthBars}
      </div>

      <div class="wind-section">
        <div class="metric-row">
          <span class="metric-label">Wind Viability</span>
          <span class="metric-value ${windPct < 30 ? 'text-red' : windPct < 60 ? 'text-amber' : 'text-green'}">
            ${windPct.toFixed(0)}%
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Est. Wind Contribution</span>
          <span class="metric-value">${windKwh} kWh/day</span>
        </div>
        ${wind?.disclaimer ? `<p class="disclaimer small">${wind.disclaimer}</p>` : ''}
      </div>

      <div class="data-source-footer">
        <span>Source: ${meta?.source ?? 'Unknown'}</span>
        <span>Updated: ${meta?.cachedAt ? new Date(meta.cachedAt).toLocaleString() : '—'}</span>
        ${(meta?.warnings ?? []).length ? `<details><summary>${meta.warnings.length} warning(s)</summary><ul>${meta.warnings.map((w) => `<li>${w}</li>`).join('')}</ul></details>` : ''}
      </div>`;
  }

  destroy(): void {
    this.el.innerHTML = '';
  }
}
