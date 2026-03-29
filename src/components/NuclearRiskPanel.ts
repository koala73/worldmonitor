/**
 * Nuclear Risk Panel
 *
 * Displays the Doomsday Clock position, a synthesized risk gauge, key nuclear
 * treaty statuses, and alert indicators derived from the current app mode.
 */

import { Panel } from './Panel';
import { getNuclearRiskData } from '@/services/nuclear-risk';
import type { NuclearRiskData } from '@/services/nuclear-risk';
import { escapeHtml } from '@/utils/sanitize';

const RISK_COLORS: Record<NuclearRiskData['riskLevel'], string> = {
  low: '#4caf50',
  elevated: '#ff9800',
  high: '#f44336',
  critical: '#b71c1c',
};

const RISK_LABELS: Record<NuclearRiskData['riskLevel'], string> = {
  low: 'LOW',
  elevated: 'ELEVATED',
  high: 'HIGH',
  critical: 'CRITICAL',
};

const STATUS_COLORS: Record<NuclearRiskData['treatyStatus'][number]['status'], string> = {
  active: '#4caf50',
  suspended: '#ff9800',
  withdrawn: '#f44336',
};

export class NuclearRiskPanel extends Panel {
  private modeChangedHandler: (() => void) | null = null;

  constructor(id: string, name: string) {
    super({
      id,
      title: name,
      showCount: false,
      trackActivity: true,
      infoTooltip:
        'Doomsday Clock data from the Bulletin of Atomic Scientists (January 2025). ' +
        'Risk level and alert indicators are derived from the current app mode.',
    });

    this.render();

    this.modeChangedHandler = () => { this.render(); };
    window.addEventListener('wm:mode-changed', this.modeChangedHandler);
  }

  override destroy(): void {
    if (this.modeChangedHandler) {
      window.removeEventListener('wm:mode-changed', this.modeChangedHandler);
      this.modeChangedHandler = null;
    }
    super.destroy();
  }

  private render(): void {
    const data = getNuclearRiskData();
    const { doomsdayClock, riskLevel, treatyStatus, alertIndicators } = data;

    const riskColor = RISK_COLORS[riskLevel];
    const riskLabel = RISK_LABELS[riskLevel];

    const treatyRows = treatyStatus.map(treaty => {
      const dotColor = STATUS_COLORS[treaty.status];
      const statusLabel = treaty.status.toUpperCase();
      return `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.07);">
          <td style="padding: 5px 4px; vertical-align: top;">
            <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${dotColor}; margin-right:6px; flex-shrink:0; position:relative; top:1px;"></span>
            <span style="font-size:12px; color:#e0e0e0;">${escapeHtml(treaty.name)}</span>
          </td>
          <td style="padding: 5px 4px; vertical-align: top; white-space:nowrap;">
            <span style="font-size:11px; font-weight:600; color:${dotColor};">${statusLabel}</span>
          </td>
          <td style="padding: 5px 4px; vertical-align: top;">
            <span style="font-size:11px; color:#9e9e9e;">${escapeHtml(treaty.notes)}</span>
          </td>
        </tr>`;
    }).join('');

    const indicatorItems = alertIndicators.map(ind =>
      `<li style="padding: 3px 0; font-size:12px; color:#cfd8dc;">
        <span style="color:${riskColor}; margin-right:6px;">▸</span>${escapeHtml(ind)}
      </li>`
    ).join('');

    this.setContent(`
      <div style="padding: 10px 12px; font-family: inherit;">

        <!-- Doomsday Clock -->
        <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:12px 14px; margin-bottom:10px; text-align:center;">
          <div style="font-size:42px; font-weight:700; letter-spacing:-1px; color:#ef5350; line-height:1;">
            89s
          </div>
          <div style="font-size:13px; color:#9e9e9e; margin-top:2px;">to midnight</div>
          <div style="font-size:11px; color:#616161; margin-top:6px;">
            Updated ${escapeHtml(doomsdayClock.lastUpdated)} — Bulletin of Atomic Scientists
          </div>
        </div>

        <!-- Risk Gauge -->
        <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:10px 14px; margin-bottom:10px; display:flex; align-items:center; gap:12px;">
          <div style="flex-shrink:0; width:48px; height:48px; border-radius:50%; border:3px solid ${riskColor}; display:flex; align-items:center; justify-content:center;">
            <span style="font-size:10px; font-weight:700; color:${riskColor}; text-align:center; line-height:1.2;">${riskLabel}</span>
          </div>
          <div>
            <div style="font-size:13px; font-weight:600; color:#e0e0e0;">Nuclear Risk Level</div>
            <div style="font-size:11px; color:#9e9e9e; margin-top:2px;">Synthesized from current app mode</div>
          </div>
        </div>

        <!-- Alert Indicators -->
        <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:10px 14px; margin-bottom:10px;">
          <div style="font-size:11px; font-weight:600; color:#9e9e9e; text-transform:uppercase; letter-spacing:0.6px; margin-bottom:6px;">
            Alert Indicators
          </div>
          <ul style="margin:0; padding:0; list-style:none;">
            ${indicatorItems}
          </ul>
        </div>

        <!-- Treaty Status -->
        <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:10px 14px;">
          <div style="font-size:11px; font-weight:600; color:#9e9e9e; text-transform:uppercase; letter-spacing:0.6px; margin-bottom:6px;">
            Key Nuclear Treaties
          </div>
          <table style="width:100%; border-collapse:collapse;">
            <tbody>
              ${treatyRows}
            </tbody>
          </table>
        </div>

      </div>
    `);
  }
}
