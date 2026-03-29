import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';
import { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { GetEconomicStressResponse, EconomicStressComponent } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';

const economicClient = new EconomicServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

const NOTIFICATION_KEY = 'wm:economic-stress:last-notified-level';

function scoreColor(score: number): string {
  if (score < 20) return '#27ae60';
  if (score < 40) return '#f1c40f';
  if (score < 60) return '#e67e22';
  if (score < 80) return '#e74c3c';
  return '#8e44ad';
}

function formatRaw(id: string, raw: number): string {
  if (id === 'ICSA') return raw >= 1000 ? (raw / 1000).toFixed(0) + 'K' : raw.toFixed(0);
  if (id === 'VIXCLS') return raw.toFixed(2);
  if (id === 'STLFSI4' || id === 'GSCPI') return raw.toFixed(3);
  return raw.toFixed(2);
}

function notifyIfCrossed(score: number): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const level = score >= 85 ? 2 : score >= 70 ? 1 : 0;
  if (level === 0) return;

  try {
    const stored = sessionStorage.getItem(NOTIFICATION_KEY);
    const lastLevel = stored ? parseInt(stored, 10) : 0;
    if (level <= lastLevel) return;

    sessionStorage.setItem(NOTIFICATION_KEY, String(level));
    const label = score >= 85 ? 'Critical' : 'Severe';
    new Notification('Economic Stress Alert', {
      body: `Composite stress index reached ${score.toFixed(1)} (${label})`,
      icon: '/favico/favicon-32x32.png',
      tag: 'economic-stress',
    });
  } catch {
    // Notification API can throw in some environments
  }
}

function componentCard(c: EconomicStressComponent): string {
  if (c.missing) {
    return `<div style="background:rgba(255,255,255,0.02);border-radius:6px;padding:8px 10px;border:1px solid rgba(255,255,255,0.05)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span style="font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(c.label)}</span>
      <span style="font-size:10px;color:#888">N/A</span>
    </div>
    <div style="font-size:9px;color:#666;font-style:italic">Data unavailable</div>
  </div>`;
  }
  const color = scoreColor(c.score);
  const barWidth = Math.min(100, Math.max(0, c.score)).toFixed(1);
  const rawDisplay = formatRaw(c.id, c.rawValue);
  return `<div style="background:rgba(255,255,255,0.04);border-radius:6px;padding:8px 10px;border:1px solid rgba(255,255,255,0.07)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span style="font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(c.label)}</span>
      <span style="font-size:10px;color:var(--text-dim)">${escapeHtml(rawDisplay)}</span>
    </div>
    <div style="display:flex;align-items:center;gap:6px">
      <div style="flex:1;background:rgba(255,255,255,0.07);border-radius:3px;height:5px;overflow:hidden">
        <div style="height:100%;width:${barWidth}%;background:${color};border-radius:3px;transition:width 0.3s"></div>
      </div>
      <span style="font-size:10px;font-weight:600;color:${color};min-width:28px;text-align:right">${c.score.toFixed(0)}</span>
    </div>
  </div>`;
}

export class EconomicStressPanel extends Panel {
  private _hasData = false;

  constructor() {
    super({ id: 'economic-stress', title: 'Economic Stress Index', showCount: false });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    try {
      let resp: GetEconomicStressResponse | null = null;

      const hydrated = getHydratedData('economicStress') as GetEconomicStressResponse | undefined;
      if (hydrated && !hydrated.unavailable && Number.isFinite(hydrated.compositeScore)) {
        resp = hydrated;
      } else {
        const rpcResp = await economicClient.getEconomicStress({});
        if (!rpcResp.unavailable && Number.isFinite(rpcResp.compositeScore)) {
          resp = rpcResp;
        }
      }

      if (!resp) {
        if (!this._hasData) this.showError('Economic stress data unavailable', () => void this.fetchData());
        return false;
      }

      notifyIfCrossed(resp.compositeScore);

      this._hasData = true;
      this.render(resp);
      return true;
    } catch (e) {
      if (!this._hasData) this.showError(e instanceof Error ? e.message : 'Failed to load', () => void this.fetchData());
      return false;
    }
  }

  private render(resp: GetEconomicStressResponse): void {
    const { compositeScore, label, components } = resp;
    const color = scoreColor(compositeScore);
    const needlePct = Math.min(100, Math.max(0, compositeScore));

    const componentCards = components.length > 0
      ? components.map((c) => componentCard(c)).join('')
      : '';

    const seededNote = resp.seededAt
      ? `<div style="font-size:9px;color:var(--text-dim);text-align:right;margin-top:8px">Updated ${new Date(resp.seededAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>`
      : '';

    const html = `<div style="padding:12px 14px">
      <div style="text-align:center;margin-bottom:12px">
        <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Composite Score</div>
        <div style="font-size:38px;font-weight:700;color:${color};line-height:1">${compositeScore.toFixed(1)}</div>
        <div style="display:inline-block;margin-top:6px;padding:3px 10px;border-radius:12px;background:${color}22;border:1px solid ${color}66;font-size:12px;font-weight:600;color:${color}">${escapeHtml(label)}</div>
      </div>

      <div style="margin-bottom:16px">
        <div style="position:relative;height:12px;border-radius:6px;overflow:visible;background:linear-gradient(to right, #27ae60 0%, #f1c40f 20%, #e67e22 40%, #e74c3c 60%, #8e44ad 80%, #8e44ad 100%);margin-bottom:4px">
          <div style="position:absolute;top:-4px;left:calc(${needlePct.toFixed(1)}% - 2px);width:4px;height:20px;background:#fff;border-radius:2px;box-shadow:0 0 4px rgba(0,0,0,0.6)"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim)">
          <span>Low</span><span>Moderate</span><span>Elevated</span><span>Severe</span><span>Critical</span>
        </div>
      </div>

      ${componentCards ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">${componentCards}</div>` : ''}
      ${seededNote}
    </div>`;

    this.setContent(html);
  }
}
