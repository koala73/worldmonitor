import { Panel } from './Panel';
import type { CyberThreat, CyberThreatSeverity } from '@/types';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { lookupVtIndicator } from '@/services/cyber-extra';

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
    this.threats = [...threats].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    this.lastUpdated = new Date();
    this.setCount(this.threats.length);
    this.render();
  }

  private render(): void {
    if (this.threats.length === 0) {
      this.setContent('<div class="panel-empty">No threat indicators in the current dataset.</div>');
      return;
    }

    const rows = this.threats.slice(0, 100).map(threat => {
      const rowClass = severityClass(threat.severity);
      const indicator = threat.indicator.length > 40 ? threat.indicator.slice(0, 38) + '…' : threat.indicator;
      const country = threat.country ? escapeHtml(threat.country) : '—';
      const typeLbl = typeLabel(threat.type);
      const sourceLbl = sourceLabel(threat.source);
      const age = threat.lastSeen ? timeAgo(threat.lastSeen) : '—';
      const itype = threat.indicatorType === 'ip' ? 'ip' : threat.indicatorType === 'url' ? 'url' : 'domain';
      return `<tr class="${rowClass} ct-clickable" data-indicator="${escapeHtml(threat.indicator)}" data-itype="${itype}" title="Click for VirusTotal lookup">
        <td class="ct-sev">${escapeHtml(threat.severity)}</td>
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
        <div class="ct-vt-tooltip" style="display:none"></div>
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

    this.getContentElement().querySelector('tbody')?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('tr[data-indicator]') as HTMLElement | null;
      if (!row) return;
      const indicator = row.dataset.indicator ?? '';
      const itype = (row.dataset.itype ?? 'domain') as 'ip' | 'domain' | 'url';
      if (!indicator) return;
      void this.showVtTooltip(row, indicator, itype);
    });
  }

  private async showVtTooltip(row: HTMLElement, indicator: string, itype: 'ip' | 'domain' | 'url'): Promise<void> {
    const tooltip = this.getContentElement().querySelector('.ct-vt-tooltip') as HTMLElement | null;
    if (!tooltip) return;

    // Position near the row
    const rect = row.getBoundingClientRect();
    const panelRect = this.getContentElement().getBoundingClientRect();
    tooltip.style.top = `${rect.bottom - panelRect.top + 4}px`;
    tooltip.style.display = 'block';
    tooltip.innerHTML = '<span class="ct-vt-loading">Checking VirusTotal…</span>';

    const rep = await lookupVtIndicator(indicator, itype);
    if (!rep) {
      tooltip.innerHTML = '<span class="ct-vt-na">VirusTotal: no key configured</span>';
      setTimeout(() => { tooltip.style.display = 'none'; }, 3000);
      return;
    }

    const badge = rep.malicious >= 5 ? '🔴' : rep.malicious >= 1 ? '🟠' : rep.suspicious >= 3 ? '🟡' : '🟢';
    tooltip.innerHTML = `
      <div class="ct-vt-result">
        <strong>${badge} ${escapeHtml(indicator.length > 40 ? indicator.slice(0, 38) + '…' : indicator)}</strong>
        <span>Malicious: ${rep.malicious} · Suspicious: ${rep.suspicious} · Harmless: ${rep.harmless}</span>
        <a href="https://www.virustotal.com/gui/${itype === 'ip' ? 'ip-address' : itype}/${encodeURIComponent(indicator)}" target="_blank" rel="noopener">View on VT →</a>
        <button class="ct-vt-close">✕</button>
      </div>`;
    tooltip.querySelector('.ct-vt-close')?.addEventListener('click', () => { tooltip.style.display = 'none'; });
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
