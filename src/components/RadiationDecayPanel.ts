/**
 * Radiation Decay Calculator Panel
 *
 * Fully offline — zero API dependencies.
 * Uses the "Rule of 7" approximation for fallout decay:
 *   dose_rate(t) = dose_t1 × (t / 1)^(-1.2)
 * where t is hours after the detonation and dose_t1 is the measured
 * dose rate at t=1 hour.
 *
 * Shelter reduction factors per FEMA guidance:
 *  - Open:        ×1.0 (no protection)
 *  - Car:         ×0.5 (50% reduction)
 *  - Wood frame:  ×0.3 (70% reduction)
 *  - Brick/block: ×0.1 (90% reduction)
 *  - Basement:    ×0.05 (95% reduction)
 *  - Underground: ×0.01 (99% reduction)
 */

import { Panel } from '@/components/Panel';

const SHELTER_FACTORS: Record<string, { label: string; factor: number }> = {
  open:        { label: 'Open — No shelter',            factor: 1.0  },
  car:         { label: 'Car interior',                 factor: 0.5  },
  wood:        { label: 'Wood frame house',             factor: 0.3  },
  brick:       { label: 'Brick / masonry building',     factor: 0.1  },
  basement:    { label: 'Basement (above ground)',      factor: 0.05 },
  underground: { label: 'Underground / deep shelter',   factor: 0.01 },
};

/**
 * Rule of 7 decay formula.
 * @param doseAt1h  Dose rate (any unit) at t = 1 hour after detonation.
 * @param hoursNow  Hours elapsed since detonation.
 * @returns Estimated dose rate at hoursNow.
 */
function decayRate(doseAt1h: number, hoursNow: number): number {
  if (hoursNow <= 0) return doseAt1h;
  return doseAt1h * Math.pow(hoursNow, -1.2);
}

/**
 * Cumulative dose from t=hoursStart to t=hoursEnd via numerical integration.
 */
function cumulativeDose(doseAt1h: number, hoursStart: number, hoursEnd: number): number {
  const steps = 120;
  const dt = (hoursEnd - hoursStart) / steps;
  let total = 0;
  for (let i = 0; i < steps; i++) {
    const t = hoursStart + (i + 0.5) * dt;
    total += decayRate(doseAt1h, t) * dt;
  }
  return total;
}

export class RadiationDecayPanel extends Panel {
  private _doseAt1h = 100;   // R/hr default (Chernobyl-scale scenario)
  private _hoursElapsed = 1;
  private _shelterKey = 'basement';
  private _shelterHours = 48;

  constructor() {
    super({
      id: 'radiation-decay',
      title: '☢ Radiation Decay Calculator',
      infoTooltip: 'Offline fallout decay estimator using the Rule of 7 approximation. Enter the dose rate measured at H+1 (1 hour after detonation) and adjust shelter/time parameters.',
    });
    this._render();
  }

  private _render(): void {
    const shelter = SHELTER_FACTORS[this._shelterKey]!;
    const currentRaw = decayRate(this._doseAt1h, this._hoursElapsed);
    const currentSheltered = currentRaw * shelter.factor;

    // 7-day cumulative dose unsheltered vs sheltered
    const cumUnsheltered = cumulativeDose(this._doseAt1h, this._hoursElapsed, this._hoursElapsed + this._shelterHours);
    const cumSheltered   = cumUnsheltered * shelter.factor;

    // Plain-language risk callout
    const callout = this._riskCallout(cumSheltered);

    // SVG spark-curve (simplified decay curve, 0–168 hours)
    const svgCurve = this._buildDecayCurve();

    const shelterOptions = Object.entries(SHELTER_FACTORS)
      .map(([k, v]) => `<option value="${k}"${k === this._shelterKey ? ' selected' : ''}>${v.label}</option>`)
      .join('');

    const html = `
      <div class="rdp-wrap">
        <div class="rdp-inputs">
          <label class="rdp-label">
            Dose rate at H+1 (R/hr or mSv/h)
            <input class="rdp-input" id="rdpDose" type="number" min="0.01" step="any" value="${this._doseAt1h}">
          </label>
          <label class="rdp-label">
            Hours since detonation
            <input class="rdp-range" id="rdpHours" type="range" min="1" max="168" value="${this._hoursElapsed}">
            <span class="rdp-range-val" id="rdpHoursVal">H+${this._hoursElapsed}h</span>
          </label>
          <label class="rdp-label">
            Shelter type
            <select class="rdp-select" id="rdpShelter">${shelterOptions}</select>
          </label>
          <label class="rdp-label">
            Shelter duration (hours)
            <input class="rdp-range" id="rdpShelterHours" type="range" min="1" max="168" value="${this._shelterHours}">
            <span class="rdp-range-val" id="rdpShelterHoursVal">${this._shelterHours}h</span>
          </label>
        </div>
        <div class="rdp-results">
          <div class="rdp-stat-row">
            <div class="rdp-stat">
              <div class="rdp-stat-val">${currentRaw.toFixed(2)}</div>
              <div class="rdp-stat-lbl">Current rate (unsheltered)</div>
            </div>
            <div class="rdp-stat">
              <div class="rdp-stat-val rdp-sheltered">${currentSheltered.toFixed(3)}</div>
              <div class="rdp-stat-lbl">Current rate (sheltered)</div>
            </div>
          </div>
          <div class="rdp-stat-row">
            <div class="rdp-stat">
              <div class="rdp-stat-val">${cumUnsheltered.toFixed(1)}</div>
              <div class="rdp-stat-lbl">Cumulative ${this._shelterHours}h unsheltered</div>
            </div>
            <div class="rdp-stat">
              <div class="rdp-stat-val rdp-sheltered">${cumSheltered.toFixed(2)}</div>
              <div class="rdp-stat-lbl">Cumulative ${this._shelterHours}h sheltered</div>
            </div>
          </div>
          <div class="rdp-callout ${callout.cls}">${callout.text}</div>
        </div>
        <div class="rdp-curve-wrap">
          ${svgCurve}
        </div>
      </div>
    `;
    this.setContent(html);
    this._attachListeners();
  }

  private _riskCallout(cumulativeSheltered: number): { text: string; cls: string } {
    if (cumulativeSheltered < 0.01)
      return { text: 'Negligible exposure — current shelter is highly effective.', cls: 'rdp-callout-ok' };
    if (cumulativeSheltered < 1)
      return { text: 'Low exposure — maintain shelter, stay hydrated.', cls: 'rdp-callout-ok' };
    if (cumulativeSheltered < 10)
      return { text: 'Moderate exposure — shelter-in-place; seek medical guidance if symptomatic.', cls: 'rdp-callout-warn' };
    if (cumulativeSheltered < 100)
      return { text: 'High exposure — radiation sickness likely; decontaminate and seek medical care.', cls: 'rdp-callout-high' };
    return { text: 'Extreme exposure — immediately seek deep underground shelter or evacuate the area.', cls: 'rdp-callout-critical' };
  }

  private _buildDecayCurve(): string {
    const W = 260; const H = 80;
    const maxH = 168;
    const maxRate = this._doseAt1h; // at t=1

    const pts: string[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = 1 + (i / 60) * (maxH - 1);
      const r = decayRate(this._doseAt1h, t);
      const x = (i / 60) * W;
      const y = H - (r / maxRate) * H * 0.9;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }

    // Current position marker
    const tNow = Math.max(1, Math.min(this._hoursElapsed, maxH));
    const xNow = ((tNow - 1) / (maxH - 1)) * W;
    const rNow = decayRate(this._doseAt1h, tNow);
    const yNow = H - (rNow / maxRate) * H * 0.9;

    return `
      <svg class="rdp-curve" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <polyline points="${pts.join(' ')}" fill="none" stroke="#ff6b6b" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="${xNow.toFixed(1)}" cy="${yNow.toFixed(1)}" r="3" fill="#ff6b6b"/>
        <text x="2" y="10" fill="var(--text-dim,#888)" font-size="8">H+1h</text>
        <text x="${W - 20}" y="10" fill="var(--text-dim,#888)" font-size="8">H+168h</text>
        <text x="${xNow.toFixed(1)}" y="${Math.max(16, yNow - 5).toFixed(1)}" fill="#ff6b6b" font-size="8" text-anchor="middle">▲ now</text>
      </svg>
    `;
  }

  private _attachListeners(): void {
    const el = this.getContentElement();
    if (!el) return;

    el.querySelector<HTMLInputElement>('#rdpDose')?.addEventListener('change', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (v > 0) { this._doseAt1h = v; this._render(); }
    });

    el.querySelector<HTMLInputElement>('#rdpHours')?.addEventListener('input', (e) => {
      this._hoursElapsed = parseInt((e.target as HTMLInputElement).value, 10);
      const label = el.querySelector<HTMLElement>('#rdpHoursVal');
      if (label) label.textContent = `H+${this._hoursElapsed}h`;
      this._render();
    });

    el.querySelector<HTMLSelectElement>('#rdpShelter')?.addEventListener('change', (e) => {
      this._shelterKey = (e.target as HTMLSelectElement).value;
      this._render();
    });

    el.querySelector<HTMLInputElement>('#rdpShelterHours')?.addEventListener('input', (e) => {
      this._shelterHours = parseInt((e.target as HTMLInputElement).value, 10);
      const label = el.querySelector<HTMLElement>('#rdpShelterHoursVal');
      if (label) label.textContent = `${this._shelterHours}h`;
      this._render();
    });
  }
}
