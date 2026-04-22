import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { attributionFooterHtml, ATTRIBUTION_FOOTER_CSS } from '@/utils/attribution-footer';
import { SupplyChainServiceClient } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type {
  ListPipelinesResponse,
  PipelineEntry,
  GetPipelineDetailResponse,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

const client = new SupplyChainServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

// Shape of the raw Redis registry hydrated by bootstrap. Narrowed to
// ListPipelinesResponse at the seam below.
interface BootstrapRegistry {
  pipelines?: Record<string, PipelineEntry>;
  classifierVersion?: string;
  updatedAt?: string;
}

const BADGE_COLOR: Record<string, string> = {
  flowing:  '#2ecc71',
  reduced:  '#f39c12',
  offline:  '#e74c3c',
  disputed: '#9b59b6',
};

function badgeLabel(badge: string): string {
  return badge.charAt(0).toUpperCase() + badge.slice(1);
}

function capacityLabel(p: PipelineEntry): string {
  if (p.commodityType === 'gas' && typeof p.capacityBcmYr === 'number' && p.capacityBcmYr > 0) {
    return `${p.capacityBcmYr.toFixed(1)} bcm/yr`;
  }
  if (p.commodityType === 'oil' && typeof p.capacityMbd === 'number' && p.capacityMbd > 0) {
    return `${p.capacityMbd.toFixed(2)} mb/d`;
  }
  return '—';
}

function badgeChip(badge: string): string {
  const color = BADGE_COLOR[badge] ?? '#7f8c8d';
  return `<span class="pp-badge" style="background:${color}">${escapeHtml(badgeLabel(badge))}</span>`;
}

function buildBootstrapResponse(
  gas: BootstrapRegistry | undefined,
  oil: BootstrapRegistry | undefined,
): ListPipelinesResponse | null {
  const pipelines: PipelineEntry[] = [];
  if (gas?.pipelines) pipelines.push(...Object.values(gas.pipelines));
  if (oil?.pipelines) pipelines.push(...Object.values(oil.pipelines));
  if (pipelines.length === 0) return null;
  return {
    pipelines,
    fetchedAt: gas?.updatedAt || oil?.updatedAt || '',
    classifierVersion: gas?.classifierVersion || oil?.classifierVersion || 'v1',
    upstreamUnavailable: false,
  };
}

export class PipelineStatusPanel extends Panel {
  private data: ListPipelinesResponse | null = null;
  private selectedId: string | null = null;
  private detail: GetPipelineDetailResponse | null = null;
  private detailLoading = false;

  constructor() {
    super({
      id: 'pipeline-status',
      title: 'Oil & Gas Pipeline Status',
      defaultRowSpan: 2,
      infoTooltip:
        'Curated registry of critical oil and gas pipelines. Public badge is derived from ' +
        'evidence (operator statements, sanction refs, commercial state, physical signals) — ' +
        'see /docs/methodology/pipelines for the classifier spec.',
    });
  }

  public async fetchData(): Promise<void> {
    try {
      // Bootstrap hydration lane — instant render on first paint from the two
      // registries published by scripts/seed-pipelines-{gas,oil}.mjs.
      const gas = getHydratedData('pipelinesGas') as BootstrapRegistry | undefined;
      const oil = getHydratedData('pipelinesOil') as BootstrapRegistry | undefined;
      const hydrated = buildBootstrapResponse(gas, oil);
      if (hydrated) {
        this.data = hydrated;
        this.render();
        // Kick a fresh RPC in the background for any post-deploy badge
        // re-derivation (classifier-version bumps, evidence changes since
        // bootstrap was stamped).
        void client.listPipelines({ commodityType: '' }).then(live => {
          if (!this.element?.isConnected || !live?.pipelines?.length) return;
          this.data = live;
          this.render();
        }).catch(() => {});
        return;
      }

      const live = await client.listPipelines({ commodityType: '' });
      if (!this.element?.isConnected) return;
      if (live.upstreamUnavailable || !live.pipelines?.length) {
        this.showError('Pipeline registry unavailable', () => void this.fetchData());
        return;
      }
      this.data = live;
      this.render();
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError('Pipeline registry error', () => void this.fetchData());
    }
  }

  private async loadDetail(pipelineId: string): Promise<void> {
    this.selectedId = pipelineId;
    this.detailLoading = true;
    this.render();
    try {
      const d = await client.getPipelineDetail({ pipelineId });
      if (!this.element?.isConnected || this.selectedId !== pipelineId) return;
      this.detail = d;
      this.detailLoading = false;
      this.render();
    } catch {
      if (!this.element?.isConnected) return;
      this.detailLoading = false;
      this.detail = null;
      this.render();
    }
  }

  private closeDetail(): void {
    this.selectedId = null;
    this.detail = null;
    this.render();
  }

  private render(): void {
    if (!this.data) return;

    const rows = [...this.data.pipelines]
      // Stable order: non-flowing first (what an atlas reader cares about),
      // then by commodity + name.
      .sort((a, b) => {
        const aFlow = a.publicBadge === 'flowing' ? 1 : 0;
        const bFlow = b.publicBadge === 'flowing' ? 1 : 0;
        if (aFlow !== bFlow) return aFlow - bFlow;
        if (a.commodityType !== b.commodityType) return a.commodityType.localeCompare(b.commodityType);
        return a.name.localeCompare(b.name);
      })
      .map(p => this.renderRow(p))
      .join('');

    const attribution = attributionFooterHtml({
      sourceType: 'classifier',
      method: 'evidence → badge (deterministic)',
      sampleSize: this.data.pipelines.length,
      sampleLabel: 'pipelines',
      updatedAt: this.data.fetchedAt,
      classifierVersion: this.data.classifierVersion,
      creditName: 'Global Energy Monitor (CC-BY 4.0)',
      creditUrl: 'https://globalenergymonitor.org/',
    });

    const drawer = this.selectedId ? this.renderDrawer() : '';

    this.setContent(`
      <div class="pp-wrap">
        <table class="pp-table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>From → To</th>
              <th>Capacity</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${attribution}
        ${drawer}
      </div>
      ${ATTRIBUTION_FOOTER_CSS}
      <style>
        .pp-wrap { position: relative; font-size: 11px; }
        .pp-table { width: 100%; border-collapse: collapse; }
        .pp-table th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim, #888); padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .pp-table td { padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.04); }
        .pp-table tr.pp-row { cursor: pointer; }
        .pp-table tr.pp-row:hover td { background: rgba(255,255,255,0.03); }
        .pp-name { font-weight: 600; color: var(--text, #eee); }
        .pp-sub  { font-size: 9px; color: var(--text-dim, #888); text-transform: uppercase; letter-spacing: 0.04em; }
        .pp-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9px; font-weight: 700; color: #fff; text-transform: uppercase; letter-spacing: 0.04em; }
        .pp-drawer { position: absolute; inset: 0; background: var(--panel-bg, #0f1218); padding: 12px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; }
        .pp-drawer-close { position: absolute; top: 8px; right: 10px; background: transparent; border: 0; color: var(--text-dim, #888); cursor: pointer; font-size: 14px; }
        .pp-drawer h3 { margin: 0 0 6px 0; font-size: 13px; color: var(--text, #eee); }
        .pp-drawer .pp-kv { display: grid; grid-template-columns: 120px 1fr; gap: 4px 10px; font-size: 10px; margin-bottom: 10px; }
        .pp-drawer .pp-kv-key { color: var(--text-dim, #888); text-transform: uppercase; letter-spacing: 0.04em; font-size: 9px; padding-top: 2px; }
        .pp-evidence { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06); }
        .pp-ev-item { font-size: 10px; color: var(--text, #eee); margin-bottom: 6px; }
        .pp-ev-item a { color: #4ade80; text-decoration: none; }
        .pp-ev-item a:hover { text-decoration: underline; }
      </style>
    `);

    const table = this.element?.querySelector('.pp-table') as HTMLTableElement | null;
    table?.querySelectorAll<HTMLTableRowElement>('tr.pp-row').forEach(tr => {
      const id = tr.dataset.pipelineId;
      if (!id) return;
      tr.addEventListener('click', () => void this.loadDetail(id));
    });
    const closeBtn = this.element?.querySelector<HTMLButtonElement>('.pp-drawer-close');
    closeBtn?.addEventListener('click', () => this.closeDetail());
  }

  private renderRow(p: PipelineEntry): string {
    const commodity = p.commodityType === 'gas' ? '⛽' : '🛢️';
    const route = `${escapeHtml(p.fromCountry)} → ${escapeHtml(p.toCountry)}`;
    return `
      <tr class="pp-row" data-pipeline-id="${escapeHtml(p.id)}">
        <td>
          <div class="pp-name">${commodity} ${escapeHtml(p.name)}</div>
          <div class="pp-sub">${escapeHtml(p.operator || '')}</div>
        </td>
        <td>${route}</td>
        <td>${escapeHtml(capacityLabel(p))}</td>
        <td>${badgeChip(p.publicBadge)}</td>
      </tr>`;
  }

  private renderDrawer(): string {
    if (this.detailLoading) {
      return `<div class="pp-drawer"><button class="pp-drawer-close" aria-label="Close">✕</button>Loading…</div>`;
    }
    const p = this.detail?.pipeline;
    if (!p) {
      return `<div class="pp-drawer"><button class="pp-drawer-close" aria-label="Close">✕</button>Pipeline detail unavailable.</div>`;
    }

    const ev = p.evidence;
    const sanctionItems = (ev?.sanctionRefs ?? []).map(s => `
      <div class="pp-ev-item">
        <strong>${escapeHtml(s.authority)}</strong> ${escapeHtml(s.listId || '')} ·
        <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.date || 'source')}</a>
      </div>`).join('');
    const operatorStatement = ev?.operatorStatement?.text
      ? `<div class="pp-ev-item"><strong>Operator:</strong> ${escapeHtml(ev.operatorStatement.text)}
           ${ev.operatorStatement.url ? `· <a href="${escapeHtml(ev.operatorStatement.url)}" target="_blank" rel="noopener">${escapeHtml(ev.operatorStatement.date || 'source')}</a>` : ''}
         </div>`
      : '';

    const transit = p.transitCountries.length > 0
      ? ` via ${p.transitCountries.map(c => escapeHtml(c)).join(', ')}`
      : '';

    return `
      <div class="pp-drawer">
        <button class="pp-drawer-close" aria-label="Close">✕</button>
        <h3>${escapeHtml(p.name)} ${badgeChip(p.publicBadge)}</h3>
        <div class="pp-kv">
          <div class="pp-kv-key">Operator</div>   <div>${escapeHtml(p.operator)}</div>
          <div class="pp-kv-key">Commodity</div>  <div>${escapeHtml(p.commodityType)}</div>
          <div class="pp-kv-key">Route</div>      <div>${escapeHtml(p.fromCountry)} → ${escapeHtml(p.toCountry)}${transit}</div>
          <div class="pp-kv-key">Capacity</div>   <div>${escapeHtml(capacityLabel(p))}</div>
          <div class="pp-kv-key">Length</div>     <div>${p.lengthKm > 0 ? `${p.lengthKm.toLocaleString()} km` : '—'}</div>
          <div class="pp-kv-key">In service</div> <div>${p.inService > 0 ? escapeHtml(String(p.inService)) : '—'}</div>
        </div>
        <div class="pp-evidence">
          <div class="pp-sub" style="margin-bottom:6px">Evidence</div>
          <div class="pp-ev-item">
            <strong>Physical state:</strong> ${escapeHtml(ev?.physicalState || 'unknown')}
            (source: ${escapeHtml(ev?.physicalStateSource || 'unknown')})
          </div>
          <div class="pp-ev-item"><strong>Commercial:</strong> ${escapeHtml(ev?.commercialState || 'unknown')}</div>
          ${operatorStatement}
          ${sanctionItems}
          ${ev?.classifierVersion ? `<div class="pp-ev-item pp-sub">Classifier ${escapeHtml(ev.classifierVersion)} · confidence ${Math.round((ev.classifierConfidence ?? 0) * 100)}%</div>` : ''}
        </div>
      </div>`;
  }
}
