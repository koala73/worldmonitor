import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { EarningsReport } from '@/services/earnings';
import { getChangeClass } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';

function formatNumber(value: number | null): string {
  if (value == null) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

function formatRevenue(value: number | null): string {
  if (value == null || value <= 0) return '-';
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${Math.round(value / 1e6)}M`;
  return `$${Math.round(value)}`;
}

function surprisePercent(report: EarningsReport): number | null {
  if (report.epsActual == null || report.epsEstimate == null || report.epsEstimate === 0) return null;
  return ((report.epsActual - report.epsEstimate) / Math.abs(report.epsEstimate)) * 100;
}

function formatDate(report: EarningsReport): string {
  if (!report.date) return '';
  const parsed = new Date(`${report.date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return report.date;
  const dateLabel = parsed.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const hourLabel = report.hour ? ` · ${report.hour.toUpperCase()}` : '';
  return `${dateLabel}${hourLabel}`;
}

export class EarningsPanel extends Panel {
  constructor(id: string, titleKey: string) {
    super({ id, title: t(titleKey), showCount: false });
  }

  public renderEarnings(reports: EarningsReport[], skipReason?: string): void {
    if (skipReason) {
      this.showRetrying(skipReason);
      return;
    }

    if (!reports || reports.length === 0) {
      this.showRetrying((t('common.noEarningsData') as string) || 'No earnings data found.');
      return;
    }

    const html = reports.map((report) => {
      const surprise = surprisePercent(report);
      const surpriseHtml = report.hasActuals && surprise !== null
        ? `<span class="earnings-surprise ${getChangeClass(surprise)}">${report.surpriseDirection === 'beat' ? 'BEAT' : report.surpriseDirection === 'miss' ? 'MISS' : 'INLINE'} ${surprise > 0 ? '+' : ''}${surprise.toFixed(1)}%</span>`
        : '';
      const company = report.company || report.symbol;
      const epsLabel = report.hasActuals
        ? `Act ${formatNumber(report.epsActual)} / Est ${formatNumber(report.epsEstimate)}`
        : `EPS est ${formatNumber(report.epsEstimate)}`;
      const revenueLabel = report.hasActuals ? 'Revenue' : 'Revenue est';
      const revenueValue = report.hasActuals ? report.revenueActual : report.revenueEstimate;

      return `
      <div class="market-item">
        <div class="market-info">
          <span class="market-symbol">${escapeHtml(report.symbol)}</span>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <span style="font-size: 0.95em; color: var(--text);">${escapeHtml(company)}</span>
            <span class="market-date" style="font-size: 0.85em; color: var(--text-dim);">${escapeHtml(formatDate(report))}</span>
          </div>
        </div>
        <div class="market-data" style="text-align: right; flex-direction: column; align-items: flex-end; gap: 2px;">
          <div style="font-size: 0.9em; color: var(--text);">${escapeHtml(epsLabel)}</div>
          <div style="font-size: 0.8em; color: var(--text-dim);">${escapeHtml(revenueLabel)} ${escapeHtml(formatRevenue(revenueValue))}</div>
          ${surpriseHtml}
        </div>
      </div>
    `;
    }).join('');

    this.setContent(html);
  }
}
