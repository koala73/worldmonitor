/**
 * AssumptionsPanel
 * Transparent display of all data sources, update times, confidence scores,
 * and editable global assumptions for the OpenSens DAMD platform.
 */

export const OPENSENS_DATA_SOURCES = [
  {
    id: 'open-meteo',
    name: 'Open-Meteo',
    url: 'https://open-meteo.com',
    license: 'CC-BY 4.0',
    description: 'Hourly weather: temperature, humidity, wind, solar radiation (GHI/DNI/DHI).',
    ttlSeconds: 1800,
    confidence: 'high',
  },
  {
    id: 'pvgis',
    name: 'PVGIS v5.2 (EU JRC)',
    url: 'https://re.jrc.ec.europa.eu/pvg_tools/en/',
    license: 'EUPL — free for research; must cite JRC',
    description: 'Monthly/annual PV yield calculation for fixed-tilt systems.',
    ttlSeconds: 86400,
    confidence: 'high',
  },
  {
    id: 'openaq',
    name: 'OpenAQ v3',
    url: 'https://openaq.org',
    license: 'CC-BY 4.0',
    description: 'PM2.5, PM10, NO2, AQI from official monitoring networks. Soiling risk proxy.',
    ttlSeconds: 900,
    confidence: 'medium',
  },
  {
    id: 'osrm',
    name: 'OSRM (project-osrm.org)',
    url: 'https://project-osrm.org',
    license: 'BSD-2 (engine); OpenStreetMap data: ODbL',
    description: 'Road-network routing as fiber trench proxy. Fallback to haversine × slack.',
    ttlSeconds: 86400,
    confidence: 'medium',
  },
  {
    id: 'gdelt',
    name: 'GDELT Project',
    url: 'https://www.gdeltproject.org',
    license: 'Free for non-commercial research',
    description: 'OSINT energy/infrastructure event signals. Aggregated counts only.',
    ttlSeconds: 3600,
    confidence: 'medium',
  },
  {
    id: 'isp-priors',
    name: 'ISP Country Priors',
    url: 'https://www.speedtest.net/global-index',
    license: 'Indicative — publicly reported averages',
    description: 'Country-level ISP pricing and speed from Speedtest Global Index + ITU data.',
    ttlSeconds: 2592000,
    confidence: 'low',
  },
  {
    id: 'starlink',
    name: 'Starlink (SpaceX)',
    url: 'https://www.starlink.com',
    license: 'Public pricing — $120/mo Residential as of 2025',
    description: 'Connectivity option. Power overhead: 75–100 W dish average. User-overridable.',
    ttlSeconds: 2592000,
    confidence: 'medium',
  },
] as const;

export const DEFAULT_ASSUMPTIONS = {
  pv_system_kwp: 3,
  bess_kwh: 20,
  bess_li_kwh: 10,
  bess_dod: 0.80,
  pue: 1.25,
  starlink_power_w: 85,
  fiber_slack_factor: 1.1,
  fiber_cost_per_meter_usd: 15,
  candidate_radius_km: 3,
  pv_capex_per_kwp_usd: 1200,
  bess_capex_per_kwh_usd: 400,
  install_overhead_pct: 15,
  discount_rate_pct: 10,
  analysis_years: 5,
  node_duty_cycle: 0.60,
  wind_urban_derate: 0.60,
  wind_hellmann_alpha: 0.25,
} as const;

export class AssumptionsPanel {
  private el: HTMLElement;

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.classList.add('opensens-panel', 'assumptions-panel');
    this.render();
  }

  private render(): void {
    const sourceRows = OPENSENS_DATA_SOURCES.map((s) => `
      <tr>
        <td><a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.name}</a></td>
        <td>${s.description}</td>
        <td>${s.license}</td>
        <td>${s.ttlSeconds >= 86400 ? `${s.ttlSeconds / 86400}d` : `${s.ttlSeconds / 60}min`}</td>
        <td><span class="confidence-badge confidence-${s.confidence}">${s.confidence}</span></td>
      </tr>`).join('');

    const assumptionRows = Object.entries(DEFAULT_ASSUMPTIONS).map(([k, v]) => `
      <tr>
        <td><code>${k}</code></td>
        <td>${v}</td>
        <td><input type="number" value="${v}" step="any" data-key="${k}" class="assumption-input"></td>
      </tr>`).join('');

    this.el.innerHTML = `
      <div class="panel-header">
        <h3>Assumptions & Data Sources</h3>
      </div>

      <h4>Data Sources</h4>
      <table class="sources-table">
        <thead>
          <tr><th>Source</th><th>Description</th><th>License</th><th>TTL</th><th>Confidence</th></tr>
        </thead>
        <tbody>${sourceRows}</tbody>
      </table>

      <h4>Global Assumptions</h4>
      <p class="notice">These values are defaults used across all OpenSens calculations.
        Changes apply immediately and override defaults for this session.</p>
      <table class="assumptions-table">
        <thead><tr><th>Parameter</th><th>Default</th><th>Override</th></tr></thead>
        <tbody>${assumptionRows}</tbody>
      </table>

      <div class="compliance-notice">
        <strong>Legal / Compliance:</strong>
        This platform uses only public APIs and open datasets. No personal data is collected
        or stored. OSINT signals are aggregated — no individual post content is persisted.
        See <a href="/docs/OPENSENS_COMPLIANCE.md">compliance checklist</a> for full details.
        This software is licensed under <strong>AGPL-3.0</strong>: if you deploy it as a
        network service, you must provide access to the complete corresponding source code.
      </div>`;
  }

  destroy(): void { this.el.innerHTML = ''; }
}
