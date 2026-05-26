import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { attributionFooterHtml, ATTRIBUTION_FOOTER_CSS } from '@/utils/attribution-footer';
import { SupplyChainServiceClient } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type {
  ListPipelinesResponse,
  PipelineEntry,
  GetPipelineDetailResponse,
  ListEnergyDisruptionsResponse,
  EnergyDisruptionEntry,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { formatEventWindow, formatCapacityOffline } from '@/shared/disruption-timeline';
import {
  derivePipelinePublicBadge,
  pickNewerClassifierVersion,
  pickNewerIsoTimestamp,
} from '@/shared/pipeline-evidence';
import {
  getCachedPipelineRegistries,
  setCachedPipelineRegistries,
  type RawPipelineRegistry,
} from '@/shared/pipeline-registry-store';

const client = new SupplyChainServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

// Shape of the raw Redis registry hydrated by bootstrap. This mirrors
// scripts/data/pipelines-{gas,oil}.json verbatim — the seeder does NOT
// transform to wire format. So bootstrap entries are raw objects with
// no publicBadge field; we derive client-side (same function as server)
// to match what the RPC will later return on background re-fetch.
// Alias for the shared store's raw-registry type. Kept as a local alias so
// existing inline call sites read cleanly. Both the panel and DeckGLMap go
// through the same shared store (pipeline-registry-store.ts) because
// getHydratedData is single-use and would drain on whichever consumer read
// first, forcing the other off its hydration path.
type RawBootstrapRegistry = RawPipelineRegistry;

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

function badgeChip(badge: string | undefined): string {
  const safe = badge && BADGE_COLOR[badge] ? badge : 'disputed';
  const color = BADGE_COLOR[safe] ?? '#7f8c8d';
  return `<span class="pp-badge" style="background:${color}">${escapeHtml(badgeLabel(safe))}</span>`;
}

// Project one raw bootstrap entry into the wire-format PipelineEntry the
// renderer expects. Defensively coerces every field because Upstash returns
// `unknown` and the source JSON can drift. Mirrors the server-side
// projectPipeline() in server/worldmonitor/supply-chain/v1/list-pipelines.ts
// so pre- and post-RPC renders produce the same badges.
function projectRawPipeline(raw: unknown): PipelineEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;

  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  const latLon = (v: unknown): { lat: number; lon: number } => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return { lat: num(o.lat), lon: num(o.lon) };
    }
    return { lat: 0, lon: 0 };
  };

  const evRaw = r.evidence as Record<string, unknown> | undefined;
  const operatorStatement =
    evRaw && typeof evRaw.operatorStatement === 'object' && evRaw.operatorStatement
      ? {
          text: str((evRaw.operatorStatement as Record<string, unknown>).text),
          url: str((evRaw.operatorStatement as Record<string, unknown>).url),
          date: str((evRaw.operatorStatement as Record<string, unknown>).date),
        }
      : undefined;
  const sanctionRefs = Array.isArray(evRaw?.sanctionRefs)
    ? (evRaw.sanctionRefs as unknown[]).map(s => {
        const o = (s ?? {}) as Record<string, unknown>;
        return { authority: str(o.authority), listId: str(o.listId), date: str(o.date), url: str(o.url) };
      })
    : [];

  const ev = evRaw
    ? {
        physicalState: str(evRaw.physicalState, 'unknown'),
        physicalStateSource: str(evRaw.physicalStateSource, 'operator'),
        operatorStatement,
        commercialState: str(evRaw.commercialState, 'unknown'),
        sanctionRefs,
        lastEvidenceUpdate: str(evRaw.lastEvidenceUpdate),
        classifierVersion: str(evRaw.classifierVersion, 'v1'),
        classifierConfidence: num(evRaw.classifierConfidence, 0),
      }
    : undefined;

  // Derive the public badge client-side so bootstrap first-paint matches
  // what the RPC will return on background refresh. Same deterministic
  // function; identical inputs produce identical outputs.
  const publicBadge = derivePipelinePublicBadge(ev);

  return {
    id,
    name: str(r.name),
    operator: str(r.operator),
    commodityType: str(r.commodityType),
    fromCountry: str(r.fromCountry),
    toCountry: str(r.toCountry),
    transitCountries: Array.isArray(r.transitCountries)
      ? (r.transitCountries as unknown[]).map(t => str(t))
      : [],
    capacityBcmYr: num(r.capacityBcmYr),
    capacityMbd: num(r.capacityMbd),
    lengthKm: num(r.lengthKm),
    inService: num(r.inService),
    startPoint: latLon(r.startPoint),
    endPoint: latLon(r.endPoint),
    waypoints: Array.isArray(r.waypoints) ? (r.waypoints as unknown[]).map(latLon) : [],
    evidence: ev,
    publicBadge,
  };
}

function buildBootstrapResponse(
  gas: RawBootstrapRegistry | undefined,
  oil: RawBootstrapRegistry | undefined,
): ListPipelinesResponse | null {
  const pipelines: PipelineEntry[] = [];
  for (const reg of [gas, oil]) {
    if (!reg?.pipelines) continue;
    for (const raw of Object.values(reg.pipelines)) {
      const projected = projectRawPipeline(raw);
      if (projected) pipelines.push(projected);
    }
  }
  if (pipelines.length === 0) return null;
  // Gas + oil seeders cron independently now — mixed-version / mixed-
  // timestamp windows are a real rollout state. Actually compare instead
  // of always preferring gas, matching the server-side aggregation.
  return {
    pipelines,
    fetchedAt: pickNewerIsoTimestamp(gas?.updatedAt, oil?.updatedAt),
    classifierVersion: pickNewerClassifierVersion(gas?.classifierVersion, oil?.classifierVersion),
    upstreamUnavailable: false,
  };
}

export class PipelineStatusPanel extends Panel {
  private data: ListPipelinesResponse | null = null;
  private selectedId: string | null = null;
  private detail: GetPipelineDetailResponse | null = null;
  private detailLoading = false;
  // Disruption events for the currently-open pipeline. Fetched lazily
  // alongside getPipelineDetail. undefined = not yet fetched;
  // empty array = fetched and no events on file.
  private detailEvents: EnergyDisruptionEntry[] | undefined = undefined;
  private openDetailHandler = (ev: Event): void => {
    const id = (ev as CustomEvent<{ pipelineId?: string }>).detail?.pipelineId;
    if (!id || !this.element?.isConnected) return;
    void this.loadDetail(id);
  };

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
    // Listen for DeckGLMap pipeline clicks. Loose coupling via window event
    // keeps the map and the panel decoupled — if the panel isn't mounted, the
    // event is a no-op. If both exist, a map click opens this drawer on the
    // same pipeline id.
    if (typeof window !== 'undefined') {
      window.addEventListener('energy:open-pipeline-detail', this.openDetailHandler);
    }
  }

  public destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('energy:open-pipeline-detail', this.openDetailHandler);
    }
    super.destroy?.();
  }

  public async fetchData(): Promise<void> {
    try {
      // Bootstrap hydration lane via the shared store. Reads once across all
      // consumers (this panel + DeckGLMap energy pipeline layer); returns the
      // cached values on subsequent calls instead of draining bootstrap data.
      const { gas, oil } = getCachedPipelineRegistries();
      const hydrated = buildBootstrapResponse(gas, oil);
      if (hydrated) {
        this.data = hydrated;
        this.render();
        // Kick a fresh RPC in the background for any post-deploy badge
        // re-derivation (classifier-version bumps, evidence changes since
        // bootstrap was stamped). When the RPC lands, mirror the fresh
        // classifierVersion + updatedAt into the shared store so the map's
        // next re-render uses the newer stamps too — prevents map/panel
        // drift during rollouts.
        void client.listPipelines({ commodityType: '' }).then(live => {
          if (!this.element?.isConnected || !live?.pipelines?.length) return;
          this.data = live;
          this.render();
          // Back-propagate RPC freshness into the store so map layers see
          // the same data. We keep the raw-JSON shape (`pipelines` as a
          // Record<id, PipelineEntry>) so the projection logic downstream
          // doesn't care whether it came from bootstrap or RPC.
          const toRecord = (filterCommodity: string): Record<string, PipelineEntry> =>
            Object.fromEntries(live.pipelines.filter(p => p.commodityType === filterCommodity).map(p => [p.id, p]));
          setCachedPipelineRegistries({
            gas: { pipelines: toRecord('gas'), classifierVersion: live.classifierVersion, updatedAt: live.fetchedAt },
            oil: { pipelines: toRecord('oil'), classifierVersion: live.classifierVersion, updatedAt: live.fetchedAt },
          });
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
      // Same store back-propagation as the bootstrap lane — prime the cache
      // so the DeckGLMap energy layer has registry data on the cold path.
      const toRecord = (filterCommodity: string): Record<string, PipelineEntry> =>
        Object.fromEntries(live.pipelines.filter(p => p.commodityType === filterCommodity).map(p => [p.id, p]));
      setCachedPipelineRegistries({
        gas: { pipelines: toRecord('gas'), classifierVersion: live.classifierVersion, updatedAt: live.fetchedAt },
        oil: { pipelines: toRecord('oil'), classifierVersion: live.classifierVersion, updatedAt: live.fetchedAt },
      });
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError('Pipeline registry error', () => void this.fetchData());
    }
  }

  private async loadDetail(pipelineId: string): Promise<void> {
    this.selectedId = pipelineId;
    this.detailLoading = true;
    this.detailEvents = undefined;
    this.render();
    try {
      const [d, events] = await Promise.all([
        client.getPipelineDetail({ pipelineId }),
        client.listEnergyDisruptions({ assetId: pipelineId, assetType: 'pipeline', ongoingOnly: false }),
      ]);
      if (!this.element?.isConnected || this.selectedId !== pipelineId) return;
      this.detail = d;
      this.detailEvents = (events as ListEnergyDisruptionsResponse)?.events ?? [];
      this.detailLoading = false;
      this.render();
    } catch {
      if (!this.element?.isConnected) return;
      // Mirror the same stale-response guard the success path uses: if the
      // user has already clicked a different pipeline while this one was
      // in flight, the newer request owns detailLoading / detail state.
      // Without this guard, a failed A + in-flight B briefly shows
      // "unavailable" for B's drawer even though B is still loading.
      if (this.selectedId !== pipelineId) return;
      this.detailLoading = false;
      this.detail = null;
      this.render();
    }
  }

  private closeDetail(): void {
    this.selectedId = null;
    this.detail = null;
    this.detailEvents = undefined;
    this.render();
  }

  private renderDisruptionTimeline(): string {
    if (this.detailEvents === undefined) return '';
    if (this.detailEvents.length === 0) {
      return `<div class="pp-evidence">
        <div class="pp-sub" style="margin-bottom:6px">Disruption timeline</div>
        <div class="pp-ev-item pp-sub">No disruption events on file for this asset.</div>
      </div>`;
    }
    const items = this.detailEvents.map(ev => {
      const window = escapeHtml(formatEventWindow(ev.startAt, ev.endAt));
      const cap = formatCapacityOffline(ev.capacityOfflineBcmYr, ev.capacityOfflineMbd);
      const capLine = cap ? ` · ${escapeHtml(cap)} offline` : '';
      const causes = (ev.causeChain && ev.causeChain.length > 0)
        ? ` · ${escapeHtml(ev.causeChain.join(' → '))}`
        : '';
      return `<div class="pp-ev-item">
        <strong>${escapeHtml(ev.eventType || 'event')}</strong> · ${window}${capLine}${causes}
        <div class="pp-sub" style="margin-top:2px">${escapeHtml(ev.shortDescription || '')}</div>
      </div>`;
    }).join('');
    return `<div class="pp-evidence">
      <div class="pp-sub" style="margin-bottom:6px">Disruption timeline (${this.detailEvents.length})</div>
      ${items}
    </div>`;
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
    // sanitizeUrl drops disallowed schemes (javascript:, data:, etc.) and
    // returns '' for invalid URLs; we suppress the <a> entirely when sanitize
    // rejects, so a bad URL in seeded data can't render an executable link.
    const sanctionItems = (ev?.sanctionRefs ?? []).map(s => {
      const safeUrl = sanitizeUrl(s.url || '');
      const linkLabel = escapeHtml(s.date || 'source');
      const dateLink = safeUrl
        ? `<a href="${safeUrl}" target="_blank" rel="noopener">${linkLabel}</a>`
        : linkLabel;
      return `
      <div class="pp-ev-item">
        <strong>${escapeHtml(s.authority)}</strong> ${escapeHtml(s.listId || '')} ·
        ${dateLink}
      </div>`;
    }).join('');
    const operatorStatement = ev?.operatorStatement?.text
      ? (() => {
          const safeUrl = sanitizeUrl(ev.operatorStatement?.url || '');
          const dateLink = safeUrl
            ? `· <a href="${safeUrl}" target="_blank" rel="noopener">${escapeHtml(ev.operatorStatement?.date || 'source')}</a>`
            : '';
          return `<div class="pp-ev-item"><strong>Operator:</strong> ${escapeHtml(ev.operatorStatement.text)}
           ${dateLink}
         </div>`;
        })()
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
        ${this.renderDisruptionTimeline()}
      </div>`;
  }
}
