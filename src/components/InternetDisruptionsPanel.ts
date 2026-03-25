import { Panel } from './Panel';
import { getApiBaseUrl } from '@/services/runtime';

interface CommsHealthResponse {
  overall: string;
  bgp: {
    hijacks: number;
    leaks: number;
    severity: string;
  };
  ixp: {
    status: string;
    degraded: string[];
  };
  ddos: {
    l7: string;
    l3: string;
    cloudflareKeyMissing: boolean;
  };
  cables: {
    degraded: string[];
    normal: string[];
  };
  updatedAt: string;
}

function dotColor(severity: string): string {
  if (severity === 'critical') return '#ef4444';
  if (severity === 'warning' || severity === 'elevated') return '#f97316';
  return '#22c55e';
}

function dot(severity: string): string {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor(severity)};margin-right:6px;flex-shrink:0;"></span>`;
}

function row(label: string, severity: string, detail: string): string {
  return `
    <div class="disruption-row" style="display:flex;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
      ${dot(severity)}
      <span style="font-weight:500;min-width:110px;font-size:12px;">${label}</span>
      <span style="color:var(--text-muted,#9ca3af);font-size:12px;">${detail}</span>
    </div>`;
}

export class InternetDisruptionsPanel extends Panel {
  private data: CommsHealthResponse | null = null;
  private error: string | null = null;
  private loading = true;

  constructor() {
    super({
      id: 'internet-disruptions',
      title: 'Internet Disruptions',
      showCount: false,
      infoTooltip: 'BGP routing health, DDoS activity, and submarine cable status from Cloudflare Radar and RIPE NCC.',
    });
    void this.fetchData();
  }

  public async fetchData(): Promise<void> {
    this.loading = true;
    this.showLoading('Loading internet disruption data…');
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/comms-health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json() as CommsHealthResponse;
      this.error = null;
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.error = err instanceof Error ? err.message : 'Failed to fetch';
    }
    this.loading = false;
    this.renderPanel();
  }

  private renderPanel(): void {
    if (this.loading) {
      this.showLoading('Loading internet disruption data…');
      return;
    }
    if (this.error || !this.data) {
      this.showError(this.error ?? 'No data');
      return;
    }

    const d = this.data;

    const bgpDetail = `${d.bgp.hijacks} hijacks, ${d.bgp.leaks} leaks`;

    let ddosSeverity = d.ddos.l7 === 'elevated' ? 'elevated' : 'normal';
    let ddosDetail = d.ddos.cloudflareKeyMissing
      ? '<span style="color:var(--text-muted,#9ca3af);font-style:italic;">Add Cloudflare API key for DDoS data</span>'
      : `L7: ${d.ddos.l7}, L3: ${d.ddos.l3}`;
    if (d.ddos.cloudflareKeyMissing) ddosSeverity = 'normal';

    const ixpDegraded = d.ixp.degraded.length;
    const ixpDetail = ixpDegraded > 0 ? `${ixpDegraded} degraded` : 'All clear';

    const cableDegraded = d.cables.degraded.length;
    const cableSeverity = cableDegraded > 0 ? 'warning' : 'normal';
    const cableDetail = cableDegraded > 0 ? `${cableDegraded} degraded cables` : 'All clear';

    const html = `
      <div style="padding:4px 0;">
        ${row('BGP Routing', d.bgp.severity, bgpDetail)}
        ${row('DDoS Activity', ddosSeverity, ddosDetail)}
        ${row('IXP Status', d.ixp.status, ixpDetail)}
        ${row('Cable Health', cableSeverity, cableDetail)}
        <div style="font-size:11px;color:var(--text-muted,#9ca3af);margin-top:8px;text-align:right;">
          Updated ${new Date(d.updatedAt).toLocaleTimeString()}
        </div>
      </div>`;

    this.setContent(html);
  }
}
