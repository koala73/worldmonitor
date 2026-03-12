import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { EarningsReport } from '@/generated/server/worldmonitor/market/v1/service_server';
import { getChangeClass } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';

export class EarningsPanel extends Panel {
    constructor(id: string, titleKey: string) {
        super({ id, title: t(titleKey) });
    }

    public renderEarnings(reports: EarningsReport[], skipReason?: string): void {
        if (skipReason) {
            this.showRetrying(skipReason);
            return;
        }

        if (!reports || reports.length === 0) {
            this.showRetrying(t('common.noEarningsData') as string || 'No earnings data found.');
            return;
        }

        const html = reports
            .map((report) => {
                let surpriseHtml = '';
                if (report.epsSurprisePercent !== undefined && report.epsSurprisePercent !== 0) {
                    const isBeat = report.epsSurprisePercent > 0;
                    const displayVal = (isBeat ? '+' : '') + report.epsSurprisePercent.toFixed(1) + '%';
                    surpriseHtml = `<span class="earnings-surprise ${getChangeClass(report.epsSurprisePercent)}">${displayVal}</span>`;
                }

                const estStr = report.epsEstimate !== undefined ? report.epsEstimate.toFixed(2) : '-';
                const actStr = report.epsActual !== undefined ? report.epsActual.toFixed(2) : '-';

                return `
      <div class="market-item">
        <div class="market-info">
          <span class="market-symbol">${escapeHtml(report.symbol)}</span>
          <span class="market-date" style="font-size: 0.85em; color: var(--text-dim);">${escapeHtml(report.reportDate)}</span>
        </div>
        <div class="market-data" style="text-align: right; flex-direction: column; align-items: flex-end; gap: 2px;">
          <div style="font-size: 0.9em;">
             <span style="color: var(--text-dim);">Est: </span>${estStr}
             <span style="color: var(--text-dim); margin-left: 6px;">Act: </span>${actStr}
          </div>
          ${surpriseHtml}
        </div>
      </div>
    `;
            })
            .join('');

        this.setContent(html);
    }
}
