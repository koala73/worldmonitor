/**
 * AutonomySimulatorPanel
 * Given BESS config and node template IT load, computes:
 *   - Hours/days of full autonomy
 *   - Days of throttled autonomy
 *   - Recommended throttle schedule
 * Sliders for BESS size, Li-ion split, and node template selection.
 */

import NODE_TEMPLATES from '../data/opensens-node-templates.json';

interface AutonomyState {
  templateId: string;
  bessKwh: number;
  bessLiKwh: number;
  pue: number;
  pvKwhPerDay: number;
}

export class AutonomySimulatorPanel {
  private el: HTMLElement;
  private state: AutonomyState = {
    templateId: 'standard-mac-mini-m4',
    bessKwh: 20,
    bessLiKwh: 10,
    pue: 1.25,
    pvKwhPerDay: 10,
  };

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.classList.add('opensens-panel', 'autonomy-simulator-panel');
    this.render();
  }

  private getTemplate() {
    return (NODE_TEMPLATES as typeof NODE_TEMPLATES).find((t) => t.id === this.state.templateId)
      ?? NODE_TEMPLATES[0];
  }

  private computeAutonomy() {
    const tmpl = this.getTemplate();
    const { bessKwh, bessLiKwh, pue, pvKwhPerDay } = this.state;
    const itLoadW = tmpl.typical_w;
    const effectiveW = itLoadW * pue;
    const effectiveKwhPerDay = (effectiveW / 1000) * 24;

    const availableBessKwh = bessKwh * 0.80; // 80% DoD
    const netDailyKwh = pvKwhPerDay - effectiveKwhPerDay;

    const fullAutonomyH = (availableBessKwh / (effectiveW / 1000));
    const fullAutonomyDays = fullAutonomyH / 24;

    // Throttled: run at 50% load
    const throttledW = itLoadW * 0.5 * pue;
    const throttledKwhPerDay = (throttledW / 1000) * 24;
    const netThrottledDaily = pvKwhPerDay - throttledKwhPerDay;
    let throttledDays: number;
    if (netThrottledDaily >= 0) {
      throttledDays = Infinity;
    } else {
      throttledDays = availableBessKwh / Math.abs(netThrottledDaily);
    }

    return {
      effectiveW, effectiveKwhPerDay, availableBessKwh, netDailyKwh,
      fullAutonomyH: parseFloat(fullAutonomyH.toFixed(1)),
      fullAutonomyDays: parseFloat(fullAutonomyDays.toFixed(1)),
      throttledDays: isFinite(throttledDays) ? parseFloat(throttledDays.toFixed(1)) : null,
      bessLiKwh, bessFlowKwh: bessKwh - bessLiKwh,
    };
  }

  private render(): void {
    const tmpl = this.getTemplate();
    const a = this.computeAutonomy();

    const autonomyBar = Math.min(100, (a.fullAutonomyDays / 7) * 100).toFixed(0);
    const statusColor = a.fullAutonomyDays >= 3 ? '#22c55e' : a.fullAutonomyDays >= 1 ? '#f59e0b' : '#ef4444';

    this.el.innerHTML = `
      <div class="panel-header">
        <h3>Autonomy Simulator</h3>
      </div>

      <div class="controls">
        <label>Node Template
          <select id="tmpl-select">
            ${(NODE_TEMPLATES as typeof NODE_TEMPLATES).map((t) =>
              `<option value="${t.id}" ${t.id === this.state.templateId ? 'selected' : ''}>${t.name}</option>`
            ).join('')}
          </select>
        </label>

        <label>BESS Total: <strong>${this.state.bessKwh} kWh</strong>
          <input type="range" min="2" max="200" step="1" value="${this.state.bessKwh}" id="bess-slider">
        </label>

        <label>Li-ion: <strong>${this.state.bessLiKwh} kWh</strong> / Flow: <strong>${this.state.bessKwh - this.state.bessLiKwh} kWh</strong>
          <input type="range" min="0" max="${this.state.bessKwh}" step="1" value="${this.state.bessLiKwh}" id="li-slider">
        </label>

        <label>PUE: <strong>${this.state.pue}</strong>
          <input type="range" min="1.0" max="2.0" step="0.05" value="${this.state.pue}" id="pue-slider">
        </label>

        <label>PV yield: <strong>${this.state.pvKwhPerDay} kWh/day</strong>
          <input type="range" min="0" max="80" step="0.5" value="${this.state.pvKwhPerDay}" id="pv-slider">
        </label>
      </div>

      <div class="results">
        <div class="metric-row">
          <span>IT Load (typical)</span>
          <span>${tmpl.typical_w} W → <strong>${a.effectiveW.toFixed(0)} W</strong> effective (×PUE)</span>
        </div>
        <div class="metric-row">
          <span>BESS Available (80% DoD)</span>
          <span><strong>${a.availableBessKwh.toFixed(1)} kWh</strong></span>
        </div>
        <div class="metric-row">
          <span>Full Autonomy</span>
          <span style="color:${statusColor}"><strong>${a.fullAutonomyH} h</strong> (${a.fullAutonomyDays} days)</span>
        </div>
        <div class="autonomy-bar">
          <div class="bar-fill" style="width:${autonomyBar}%; background:${statusColor}"></div>
        </div>
        <div class="metric-row">
          <span>Throttled Autonomy (50% load)</span>
          <span><strong>${a.throttledDays === null ? '∞ (solar covers load)' : a.throttledDays + ' days'}</strong></span>
        </div>
        <div class="metric-row">
          <span>Net Daily Energy</span>
          <span class="${a.netDailyKwh >= 0 ? 'text-green' : 'text-red'}">
            ${a.netDailyKwh >= 0 ? '+' : ''}${a.netDailyKwh.toFixed(2)} kWh/day
          </span>
        </div>
      </div>

      <div class="template-notes">
        <strong>Assumptions (${tmpl.name}):</strong>
        <ul>${tmpl.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
      </div>`;

    this.attachListeners();
  }

  private attachListeners(): void {
    const tmplSel = this.el.querySelector<HTMLSelectElement>('#tmpl-select');
    const bessSlider = this.el.querySelector<HTMLInputElement>('#bess-slider');
    const liSlider = this.el.querySelector<HTMLInputElement>('#li-slider');
    const pueSlider = this.el.querySelector<HTMLInputElement>('#pue-slider');
    const pvSlider = this.el.querySelector<HTMLInputElement>('#pv-slider');

    tmplSel?.addEventListener('change', () => {
      this.state.templateId = tmplSel.value;
      this.render();
    });
    bessSlider?.addEventListener('input', () => {
      this.state.bessKwh = parseFloat(bessSlider.value);
      this.state.bessLiKwh = Math.min(this.state.bessLiKwh, this.state.bessKwh);
      this.render();
    });
    liSlider?.addEventListener('input', () => {
      this.state.bessLiKwh = parseFloat(liSlider.value);
      this.render();
    });
    pueSlider?.addEventListener('input', () => {
      this.state.pue = parseFloat(pueSlider.value);
      this.render();
    });
    pvSlider?.addEventListener('input', () => {
      this.state.pvKwhPerDay = parseFloat(pvSlider.value);
      this.render();
    });
  }

  destroy(): void { this.el.innerHTML = ''; }
}
