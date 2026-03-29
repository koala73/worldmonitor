import { Panel } from './Panel';
import { renderStatusCard } from './StatusCard';
import type { CommsHealthData } from '@/services/comms-health';
import { tryInvokeTauri } from '@/services/tauri-bridge';
import { isGhostMode } from '@/services/mode-manager';

export class CommsHealthPanel extends Panel {
  private _previousOverall = 'normal';

  constructor() {
    super({ id: 'comms-health', title: 'Communications Health' });
    this.showLoading('Fetching communications data...');
  }

  update(data: CommsHealthData | null): void {
    if (!data) {
      this._renderError();
      return;
    }
    void this._checkNotification(data.overall);
    this._render(data);
  }

  private async _checkNotification(overall: string): Promise<void> {
    if (isGhostMode()) return;
    const prev = this._previousOverall;
    if ((prev === 'normal') && (overall === 'warning' || overall === 'critical')) {
      await tryInvokeTauri<void>('send_notification', {
        title: 'Communications Health',
        body: `Status changed to ${overall.toUpperCase()}`,
        sound: 'Ping',
      });
    } else if (prev === 'warning' && overall === 'critical') {
      await tryInvokeTauri<void>('send_notification', {
        title: 'Communications Health',
        body: 'Status escalated to CRITICAL',
        sound: 'Basso',
      });
    }
    this._previousOverall = overall;
  }

  private _render(data: CommsHealthData): void {
    const el = this.getContentElement();
    const { overall, bgp, ixp, ddos, cables } = data;

    const BANNER_BG: Record<string, string> = {
      normal: 'rgba(34,197,94,', warning: 'rgba(234,179,8,', critical: 'rgba(239,68,68,',
    };
    const TEXT_C: Record<string, string> = {
      normal: '#22c55e', warning: '#eab308', critical: '#ef4444',
    };
    const bc = BANNER_BG[overall] ?? BANNER_BG.warning;
    const tc = TEXT_C[overall] ?? TEXT_C.warning;
    const label = overall === 'normal' ? 'NORMAL' : (overall === 'warning' ? 'DEGRADED' : 'CRITICAL');

    const summaryParts: string[] = [];
    if (bgp.hijacks > 0) summaryParts.push(`${bgp.hijacks} BGP hijacks`);
    if (bgp.leaks > 0) summaryParts.push(`${bgp.leaks} leaks`);
    if (cables.degraded.length > 0) summaryParts.push(`${cables.degraded.length} cable degraded`);
    const summary = summaryParts.join(' · ') || 'All systems normal';

    const bgpHijackCard = renderStatusCard({
      label: 'BGP Hijacks', value: bgp.hijacks, severity: bgp.severity,
      sublabel: bgp.hijacks > 0 ? 'Active events' : 'None detected',
    });
    const bgpLeakCard = renderStatusCard({
      label: 'BGP Leaks', value: bgp.leaks,
      severity: bgp.leaks > 0 ? 'warning' : 'normal',
      sublabel: bgp.leaks > 0 ? 'Active now' : 'Clear',
    });
    const ixpCard = renderStatusCard({
      label: 'IXP Status',
      value: ixp.status === 'normal' ? 'NORMAL' : 'DEGRADED',
      severity: ixp.status,
      sublabel: ixp.degraded.length > 0 ? ixp.degraded[0] : 'All regions',
    });
    const ddosSev: 'normal' | 'warning' | 'critical' | 'unknown' = ddos.cloudflareKeyMissing ? 'unknown'
      : ddos.l7 === 'critical' ? 'critical'
      : ddos.l7 === 'elevated' ? 'warning' : 'normal';
    const ddosCard = renderStatusCard({
      label: 'DDoS L7',
      value: ddos.cloudflareKeyMissing ? 'UNKNOWN' : ddos.l7.toUpperCase(),
      severity: ddosSev,
      inlineNote: ddos.cloudflareKeyMissing ? 'Cloudflare token required' : undefined,
    });

    const allCables = [...cables.degraded, ...cables.normal];
    const cableBadges = allCables.map(c => {
      const isDeg = cables.degraded.includes(c);
      const color = isDeg ? '#eab308' : '#22c55e';
      const bg = isDeg ? 'rgba(234,179,8,0.15)' : 'rgba(34,197,94,0.12)';
      return `<span style="font-size:0.7rem;padding:0.15rem 0.4rem;border-radius:3px;background:${bg};color:${color};">${c} ${isDeg ? 'DEGRADED' : 'OK'}</span>`;
    }).join('');

    const cableCard = renderStatusCard({
      label: 'Submarine Cables',
      value: cables.degraded.length > 0 ? `${cables.degraded.length} degraded` : 'All normal',
      severity: cables.degraded.length > 1 ? 'critical' : (cables.degraded.length === 1 ? 'warning' : 'normal'),
      wide: true,
    });

    const ts = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dot = `<div style="width:9px;height:9px;border-radius:50%;background:${tc};box-shadow:0 0 5px ${tc};flex-shrink:0;"></div>`;

    el.innerHTML = `
<div style="padding:0.8rem;display:flex;flex-direction:column;gap:0.7rem;">
  <div style="display:flex;align-items:center;gap:0.55rem;padding:0.55rem 0.7rem;background:${bc}0.08);border:1px solid ${bc}0.28);border-radius:6px;">
    ${dot}
    <div style="flex:1;">
      <div style="font-size:0.8rem;font-weight:600;color:${tc};">${label}</div>
      <div style="font-size:0.68rem;opacity:0.55;">${summary} · ${ts}</div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.42rem;">
    ${bgpHijackCard}${bgpLeakCard}${ixpCard}${ddosCard}
    <div style="grid-column:1/-1;">
      ${cableCard}
      ${allCables.length > 0 ? `<div style="display:flex;gap:0.35rem;flex-wrap:wrap;margin-top:0.35rem;">${cableBadges}</div>` : ''}
    </div>
  </div>
</div>`;
  }

  private _renderError(): void {
    const el = this.getContentElement();
    el.innerHTML = `<div style="padding:1rem;">${renderStatusCard({ label: 'Communications Health', value: 'Data unavailable', severity: 'unknown', wide: true })}</div>`;
  }
}
