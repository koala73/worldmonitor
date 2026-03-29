import { Panel } from './Panel';
import type { DiseaseOutbreak } from '@/services/disease-outbreak';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export class DiseaseOutbreakPanel extends Panel {
  private outbreaks: DiseaseOutbreak[] = [];
  private lastUpdated: Date | null = null;

  constructor() {
    super({
      id: 'disease-outbreaks',
      title: t('panels.diseaseOutbreaks'),
      showCount: true,
      trackActivity: true,
      infoTooltip: 'WHO Disease Outbreak News + ReliefWeb health situation reports. Updated every 15 minutes.',
    });
    this.showLoading('Fetching WHO outbreak data...');
  }

  public update(outbreaks: DiseaseOutbreak[]): void {
    this.outbreaks = outbreaks;
    this.lastUpdated = new Date();
    this.setCount(outbreaks.length);
    this.render();
  }

  private render(): void {
    if (this.outbreaks.length === 0) {
      this.setContent('<div class="panel-empty">No active outbreaks reported.</div>');
      return;
    }

    const rows = this.outbreaks.slice(0, 50).map(o => {
      const sevClass = sevRowClass(o.severity);
      // Validate scheme before using URL in href — prevents javascript:/data: injection
      const safeUrl = o.url?.startsWith('https://') ? o.url : null;
      const link = safeUrl
        ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" class="do-link">${escapeHtml(o.disease)}</a>`
        : escapeHtml(o.disease);
      return `<tr class="${sevClass}">
        <td class="do-sev">${sevBadge(o.severity)}</td>
        <td class="do-disease">${link}</td>
        <td class="do-country">${escapeHtml(o.country)}</td>
        <td class="do-source">${escapeHtml(o.source)}</td>
        <td class="do-age">${timeAgo(o.date)}</td>
      </tr>`;
    }).join('');

    const updatedStr = this.lastUpdated ? timeAgo(this.lastUpdated) : 'never';

    this.setContent(`
      <div class="do-panel-content">
        <table class="eq-table">
          <thead>
            <tr>
              <th>Sev</th>
              <th>Disease</th>
              <th>Country</th>
              <th>Source</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">WHO · ReliefWeb · ${this.outbreaks.length} reports</span>
          <span class="fires-updated">Updated ${updatedStr}</span>
        </div>
      </div>
    `);
  }
}

function sevRowClass(sev: DiseaseOutbreak['severity']): string {
  if (sev === 'critical') return 'eq-row eq-major';
  if (sev === 'high') return 'eq-row eq-strong';
  if (sev === 'medium') return 'eq-row eq-moderate';
  return 'eq-row';
}

function sevBadge(sev: DiseaseOutbreak['severity']): string {
  const labels: Record<string, string> = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW' };
  return labels[sev] ?? sev;
}

function timeAgo(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
