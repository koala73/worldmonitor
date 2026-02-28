/**
 * ROIDashboardPanel
 * Scenario sliders, payback display, and per-site ROI report card.
 */

interface RoiState {
  lat: number | null;
  lon: number | null;
  templateId: string;
  pvKwp: number;
  bessKwh: number;
  connectivityCost: number;
  revenuePerNode: number;
  popDensity: number;
  loading: boolean;
  error: string | null;
  data: Record<string, unknown> | null;
}

export class ROIDashboardPanel {
  private el: HTMLElement;
  private state: RoiState = {
    lat: null, lon: null, templateId: 'standard-mac-mini-m4',
    pvKwp: 3, bessKwh: 20, connectivityCost: 65, revenuePerNode: 150,
    popDensity: 1000, loading: false, error: null, data: null,
  };

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.classList.add('opensens-panel', 'roi-dashboard-panel');
    this.render();
  }

  async load(lat: number, lon: number): Promise<void> {
    this.state = { ...this.state, lat, lon, loading: true, error: null };
    this.render();
    try {
      const p = new URLSearchParams({
        lat: lat.toString(), lon: lon.toString(),
        template_id: this.state.templateId,
        pv_kwp: this.state.pvKwp.toString(),
        bess_kwh: this.state.bessKwh.toString(),
        connectivity_cost: this.state.connectivityCost.toString(),
        revenue_per_node: this.state.revenuePerNode.toString(),
        pop_density: this.state.popDensity.toString(),
      });
      const res = await fetch(`/api/opensens/roi?${p}`);
      const data = await res.json();
      this.state = { ...this.state, data, loading: false };
    } catch (err) {
      this.state = { ...this.state, loading: false, error: (err as Error).message };
    }
    this.render();
  }

  private render(): void {
    const { loading, error, data } = this.state;
    if (loading) { this.el.innerHTML = '<div class="panel-loading">Computing ROI scenarios…</div>'; return; }
    if (error) { this.el.innerHTML = `<div class="panel-error">${error}</div>`; return; }
    if (!data) {
      this.el.innerHTML = '<div class="panel-placeholder">Select a location to compute ROI scenarios.</div>';
      return;
    }

    const { scenarios, autonomy, demandScore, completeness, meta } = data as {
      scenarios: Array<{ label: string; paybackYears: number; npv5y: number; irr: number | null; annualRevenueUsd: number; annualOpexUsd: number; totalCapexUsd: number; confidence: number; dataCompletenessFlags: string[] }>;
      autonomy: { fullAutonomyH: number; autonomyDodHours: number };
      demandScore: number;
      completeness: number;
      meta: { confidence: string; warnings: string[]; cachedAt: string };
    };

    const scenarioCards = (scenarios ?? []).map((s) => {
      const paybackStr = isFinite(s.paybackYears) ? `${s.paybackYears.toFixed(1)} yrs` : '∞';
      const npvColor = s.npv5y > 0 ? 'text-green' : 'text-red';
      return `
        <div class="scenario-card scenario-${s.label}">
          <div class="scenario-label">${s.label.toUpperCase()}</div>
          <div class="scenario-metric">Revenue: $${(s.annualRevenueUsd / 1000).toFixed(0)}k/yr</div>
          <div class="scenario-metric">Opex: $${(s.annualOpexUsd / 1000).toFixed(0)}k/yr</div>
          <div class="scenario-metric">Capex: $${(s.totalCapexUsd / 1000).toFixed(0)}k</div>
          <div class="scenario-metric"><strong>Payback: ${paybackStr}</strong></div>
          <div class="scenario-metric ${npvColor}">NPV 5yr: $${(s.npv5y / 1000).toFixed(0)}k</div>
          <div class="scenario-metric">IRR: ${s.irr != null ? `${s.irr}%` : 'N/A'}</div>
          <div class="confidence-badge">Confidence: ${(s.confidence * 100).toFixed(0)}%</div>
          ${s.dataCompletenessFlags.length ? `<div class="flags">⚠ ${s.dataCompletenessFlags.join(', ')}</div>` : ''}
        </div>`;
    }).join('');

    this.el.innerHTML = `
      <div class="panel-header">
        <h3>ROI Dashboard</h3>
        <span class="confidence-badge confidence-${meta?.confidence}">${meta?.confidence} confidence</span>
      </div>

      <div class="summary-row">
        <div>Demand Score: <strong>${demandScore?.toFixed(0) ?? '—'}/100</strong></div>
        <div>Data Completeness: <strong>${completeness != null ? (completeness * 100).toFixed(0) + '%' : '—'}</strong></div>
        <div>Autonomy: <strong>${autonomy?.fullAutonomyH ?? '—'} h full / ${autonomy?.autonomyDodHours ?? '—'} h (80% DoD)</strong></div>
      </div>

      <div class="sliders">
        <label>PV: <strong>${this.state.pvKwp} kWp</strong>
          <input type="range" min="1" max="20" step="0.5" value="${this.state.pvKwp}" data-key="pvKwp">
        </label>
        <label>BESS: <strong>${this.state.bessKwh} kWh</strong>
          <input type="range" min="5" max="200" step="5" value="${this.state.bessKwh}" data-key="bessKwh">
        </label>
        <label>Connectivity: <strong>$${this.state.connectivityCost}/mo</strong>
          <input type="range" min="0" max="500" step="5" value="${this.state.connectivityCost}" data-key="connectivityCost">
        </label>
        <label>Revenue/node: <strong>$${this.state.revenuePerNode}/mo</strong>
          <input type="range" min="0" max="2000" step="50" value="${this.state.revenuePerNode}" data-key="revenuePerNode">
        </label>
      </div>

      <div class="scenario-grid">${scenarioCards}</div>

      ${meta?.warnings?.length ? `
        <div class="warnings">
          ${meta.warnings.map((w) => `<p class="warning">⚠ ${w}</p>`).join('')}
        </div>` : ''}

      <div class="data-source-footer">
        <span>Last computed: ${meta?.cachedAt ? new Date(meta.cachedAt).toLocaleString() : '—'}</span>
      </div>`;

    this.el.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((slider) => {
      slider.addEventListener('input', () => {
        const key = slider.dataset.key as keyof RoiState;
        (this.state as Record<string, unknown>)[key] = parseFloat(slider.value);
        if (this.state.lat && this.state.lon) this.load(this.state.lat, this.state.lon);
      });
    });
  }

  destroy(): void { this.el.innerHTML = ''; }
}
