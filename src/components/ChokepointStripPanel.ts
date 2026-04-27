import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';
import { fetchChokepointStatus } from '@/services/supply-chain';
import { attributionFooterHtml, ATTRIBUTION_FOOTER_CSS } from '@/utils/attribution-footer';
import type { GetChokepointStatusResponse, ChokepointInfo } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

// Ordering for the atlas strip: highest-volume chokepoints first.
// Matches scripts/seed-chokepoint-baselines.mjs ordering.
const STRIP_ORDER = [
  'hormuz_strait',
  'malacca_strait',
  'suez',
  'bab_el_mandeb',
  'bosphorus',
  'dover_strait',
  'panama',
];

const SHORT_NAME: Record<string, string> = {
  hormuz_strait: 'Hormuz',
  malacca_strait: 'Malacca',
  suez: 'Suez',
  bab_el_mandeb: 'Bab el-Mandeb',
  bosphorus: 'Turkish Straits',
  dover_strait: 'Danish Straits',
  panama: 'Panama',
};

function statusColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (s.includes('closed') || s.includes('critical')) return '#e74c3c';
  if (s.includes('disrupted') || s.includes('high')) return '#e67e22';
  if (s.includes('restricted') || s.includes('elevated') || s.includes('medium')) return '#f39c12';
  return '#2ecc71';
}

function formatFlow(cp: ChokepointInfo): string {
  const est = cp.flowEstimate;
  if (!est || typeof est.currentMbd !== 'number' || typeof est.baselineMbd !== 'number') return '—';
  const pct = est.baselineMbd > 0 ? Math.round((est.currentMbd / est.baselineMbd) * 100) : null;
  if (pct == null) return `${est.currentMbd.toFixed(1)} mb/d`;
  return `${pct}% of baseline`;
}

export class ChokepointStripPanel extends Panel {
  private data: GetChokepointStatusResponse | null = null;

  constructor() {
    super({
      id: 'chokepoint-strip',
      title: 'Chokepoint Status',
      infoTooltip:
        'Live status for the seven global oil & gas shipping chokepoints. ' +
        'Flow estimates calibrated from Portwatch DWT + AIS observations. ' +
        'See /docs/methodology/chokepoints for methodology.',
    });
  }

  public async fetchData(): Promise<void> {
    try {
      const hydrated = getHydratedData('chokepoints') as GetChokepointStatusResponse | undefined;
      if (hydrated?.chokepoints?.length) {
        this.data = hydrated;
        this.render();
        void fetchChokepointStatus().then(fresh => {
          if (!this.element?.isConnected || !fresh?.chokepoints?.length) return;
          this.data = fresh;
          this.render();
        }).catch(() => {});
        return;
      }
      const fresh = await fetchChokepointStatus();
      if (!this.element?.isConnected) return;
      this.data = fresh;
      this.render();
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError('Chokepoint status unavailable', () => void this.fetchData());
    }
  }

  private render(): void {
    if (!this.data?.chokepoints?.length) {
      this.showError('No chokepoint data yet', () => void this.fetchData());
      return;
    }

    const byId = new Map(this.data.chokepoints.map(cp => [cp.id, cp]));
    const ordered = STRIP_ORDER
      .map(id => byId.get(id))
      .filter((cp): cp is ChokepointInfo => !!cp);

    const chips = ordered.map(cp => {
      const color = statusColor(cp.status);
      const short = SHORT_NAME[cp.id] || cp.name;
      const flow = formatFlow(cp);
      const warnings = cp.activeWarnings > 0
        ? `<span class="cp-chip-warn">${cp.activeWarnings}</span>`
        : '';
      return `
        <div class="cp-chip" data-cp="${escapeHtml(cp.id)}" title="${escapeHtml(cp.name)} — ${escapeHtml(cp.status || 'unknown')}">
          <div class="cp-chip-dot" style="background:${color}"></div>
          <div class="cp-chip-body">
            <div class="cp-chip-name">${escapeHtml(short)}${warnings}</div>
            <div class="cp-chip-flow">${escapeHtml(flow)}</div>
          </div>
        </div>`;
    }).join('');

    const nAis = ordered.reduce((sum, cp) => sum + (cp.aisDisruptions ?? 0), 0);
    const footer = attributionFooterHtml({
      sourceType: 'ais',
      method: 'Portwatch DWT + AIS calibration',
      sampleSize: nAis || undefined,
      sampleLabel: 'AIS disruption signals',
      updatedAt: this.data.fetchedAt,
      creditName: 'EIA World Oil Transit Chokepoints',
    });

    this.setContent(`
      <div class="cp-strip-wrap">
        <div class="cp-strip">${chips}</div>
        ${footer}
      </div>
      ${ATTRIBUTION_FOOTER_CSS}
      <style>
        .cp-strip-wrap { padding: 4px 0; }
        .cp-strip { display: flex; flex-wrap: wrap; gap: 8px; }
        .cp-chip {
          display: flex; align-items: center; gap: 6px;
          padding: 6px 10px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 8px;
          min-width: 120px;
          font-size: 11px;
          cursor: default;
        }
        .cp-chip-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
        .cp-chip-body { display: flex; flex-direction: column; line-height: 1.2; }
        .cp-chip-name { font-weight: 600; color: var(--text, #eee); display: flex; align-items: center; gap: 4px; }
        .cp-chip-warn { background:#e74c3c;color:#fff;border-radius:9px;padding:0 5px;font-size:9px;font-weight:700; }
        .cp-chip-flow { color: var(--text-dim, #888); font-size: 10px; }
      </style>
    `);
  }
}
