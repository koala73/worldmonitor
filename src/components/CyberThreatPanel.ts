import { Panel } from './Panel';
import type { CyberThreat, CyberThreatSeverity } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export class CyberThreatPanel extends Panel {
  private threats: CyberThreat[] = [];
  private lastUpdated: Date | null = null;

  constructor() {
    super({
      id: 'cyber-threats',
      title: t('panels.cyberThreats'),
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Live IOC feed from Feodo, URLhaus, C2Intel, OTX, AbuseIPDB, ThreatFox, OpenPhish, Spamhaus DROP, and CISA KEV — updated every 15 minutes.',
    });
    this.showLoading('Loading threat intelligence...');
  }

  public update(threats: CyberThreat[]): void {
    this.threats = threats.slice().sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    this.lastUpdated = new Date();
    this.setCount(this.threats.length);
    this.render();
  }

  private render(): void {
    if (this.threats.length === 0) {
      this.setContent('<div class="panel-empty">No threat indicators in the current dataset.</div>');
      return;
    }

    const rows = this.threats.slice(0, 100).map(t => {
      const rowClass = severityClass(t.severity);
      const indicator = t.indicator.length > 40 ? t.indicator.slice(0, 38) + '…' : t.indicator;
      const country = t.country ? escapeHtml(t.country) : '—';
      const typeLbl = typeLabel(t.type);
      const sourceLbl = sourceLabel(t.source);
      const age = t.lastSeen ? timeAgo(t.lastSeen) : '—';
      return `<tr class="${rowClass}">
        <td class="ct-sev">${escapeHtml(t.severity)}</td>
        <td class="ct-type">${typeLbl}</td>
        <td class="ct-country">${country}</td>
        <td class="ct-indicator">${escapeHtml(indicator)}</td>
        <td class="ct-source">${sourceLbl}</td>
        <td class="ct-age">${age}</td>
      </tr>`;
    }).join('');

    const ago = this.lastUpdated ? timeAgo(this.lastUpdated.toISOString()) : 'never';

    this.setContent(`
      <div class="ct-panel-content">
        <table class="eq-table ct-table">
          <thead>
            <tr>
              <th>Sev</th>
              <th>Type</th>
              <th>Country</th>
              <th>Indicator</th>
              <th>Source</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">Feodo · URLhaus · C2Intel · OTX · AbuseIPDB · ThreatFox · OpenPhish · Spamhaus DROP · CISA KEV</span>
          <span class="fires-updated">Updated ${ago}</span>
        </div>
      </div>
    `);
  }
}

function severityRank(s: CyberThreatSeverity): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s] ?? 0;
}

function severityClass(s: CyberThreatSeverity): string {
  return { critical: 'eq-row eq-major', high: 'eq-row eq-strong', medium: 'eq-row eq-moderate', low: 'eq-row' }[s] ?? 'eq-row';
}

function typeLabel(t: string): string {
  return {
    c2_server: 'C2', malware_host: 'Malware', phishing: 'Phish', malicious_url: 'URL',
    malicious_ip_range: 'IP Range', exploited_vulnerability: 'CVE',
  }[t] ?? t;
}

function sourceLabel(s: string): string {
  return {
    feodo: 'Feodo', urlhaus: 'URLhaus', c2intel: 'C2Intel', otx: 'OTX', abuseipdb: 'AbuseIPDB',
    threatfox: 'ThreatFox', openphish: 'OpenPhish', spamhaus: 'Spamhaus', cisa_kev: 'CISA KEV',
  }[s] ?? s;
}

function timeAgo(isoOrDate: string): string {
  try {
    const secs = Math.floor((Date.now() - new Date(isoOrDate).getTime()) / 1000);
    if (secs < 0) return 'now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return '—';
  }
}
