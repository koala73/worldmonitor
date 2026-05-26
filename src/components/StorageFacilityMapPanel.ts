import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { attributionFooterHtml, ATTRIBUTION_FOOTER_CSS } from '@/utils/attribution-footer';
import { SupplyChainServiceClient } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type {
  ListStorageFacilitiesResponse,
  StorageFacilityEntry,
  GetStorageFacilityDetailResponse,
  ListEnergyDisruptionsResponse,
  EnergyDisruptionEntry,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { formatEventWindow, formatCapacityOffline } from '@/shared/disruption-timeline';
import { deriveStoragePublicBadge } from '@/shared/storage-evidence';
import {
  getCachedStorageFacilityRegistry,
  setCachedStorageFacilityRegistry,
  type RawStorageFacilityRegistry,
} from '@/shared/storage-facility-registry-store';

const client = new SupplyChainServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

const BADGE_COLOR: Record<string, string> = {
  operational: '#2ecc71',
  reduced:     '#f39c12',
  offline:     '#e74c3c',
  disputed:    '#9b59b6',
};

// Short glyph per facility type. Used in the table and drawer header so
// the eye can sort by category without reading the full type name.
const TYPE_GLYPH: Record<string, string> = {
  ugs:             '🟢', // gas storage
  spr:             '🛢️', // crude SPR
  lng_export:      '🚢', // export terminal
  lng_import:      '⚓', // import terminal
  crude_tank_farm: '🟡', // commercial crude hub
};

const TYPE_LABEL: Record<string, string> = {
  ugs:             'UGS',
  spr:             'SPR',
  lng_export:      'LNG export',
  lng_import:      'LNG import',
  crude_tank_farm: 'Crude hub',
};

function badgeLabel(badge: string): string {
  return badge.charAt(0).toUpperCase() + badge.slice(1);
}

function badgeChip(badge: string | undefined): string {
  const safe = badge && BADGE_COLOR[badge] ? badge : 'disputed';
  const color = BADGE_COLOR[safe] ?? '#7f8c8d';
  return `<span class="sf-badge" style="background:${color}">${escapeHtml(badgeLabel(safe))}</span>`;
}

function capacityLabel(f: StorageFacilityEntry): string {
  if (f.facilityType === 'ugs' && typeof f.capacityTwh === 'number' && f.capacityTwh > 0) {
    return `${f.capacityTwh.toFixed(1)} TWh`;
  }
  if ((f.facilityType === 'lng_export' || f.facilityType === 'lng_import')
      && typeof f.capacityMtpa === 'number' && f.capacityMtpa > 0) {
    return `${f.capacityMtpa.toFixed(1)} Mtpa`;
  }
  if ((f.facilityType === 'spr' || f.facilityType === 'crude_tank_farm')
      && typeof f.capacityMb === 'number' && f.capacityMb > 0) {
    return `${f.capacityMb.toLocaleString()} Mb`;
  }
  return '—';
}

// Project one raw bootstrap entry into the wire-format StorageFacilityEntry
// the renderer expects. Mirrors projectStorageFacility() in the server
// handler so pre- and post-RPC renders produce identical badges.
function projectRawFacility(raw: unknown): StorageFacilityEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;

  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);

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
        fillDisclosed: bool(evRaw.fillDisclosed),
        fillSource: str(evRaw.fillSource),
        lastEvidenceUpdate: str(evRaw.lastEvidenceUpdate),
        classifierVersion: str(evRaw.classifierVersion, 'v1'),
        classifierConfidence: num(evRaw.classifierConfidence, 0),
      }
    : undefined;

  const publicBadge = deriveStoragePublicBadge(ev);

  return {
    id,
    name: str(r.name),
    operator: str(r.operator),
    facilityType: str(r.facilityType),
    country: str(r.country),
    location: latLon(r.location),
    capacityTwh: num(r.capacityTwh),
    capacityMb: num(r.capacityMb),
    capacityMtpa: num(r.capacityMtpa),
    workingCapacityUnit: str(r.workingCapacityUnit),
    inService: num(r.inService),
    evidence: ev,
    publicBadge,
  };
}

function buildBootstrapResponse(
  registry: RawStorageFacilityRegistry | undefined,
): ListStorageFacilitiesResponse | null {
  if (!registry?.facilities) return null;
  const facilities: StorageFacilityEntry[] = [];
  for (const raw of Object.values(registry.facilities)) {
    const projected = projectRawFacility(raw);
    if (projected) facilities.push(projected);
  }
  if (facilities.length === 0) return null;
  return {
    facilities,
    fetchedAt: registry.updatedAt ?? '',
    classifierVersion: registry.classifierVersion ?? 'v1',
    upstreamUnavailable: false,
  };
}

export class StorageFacilityMapPanel extends Panel {
  private data: ListStorageFacilitiesResponse | null = null;
  private selectedId: string | null = null;
  private detail: GetStorageFacilityDetailResponse | null = null;
  private detailLoading = false;
  private detailEvents: EnergyDisruptionEntry[] | undefined = undefined;
  private openDetailHandler = (ev: Event): void => {
    const id = (ev as CustomEvent<{ facilityId?: string }>).detail?.facilityId;
    if (!id || !this.element?.isConnected) return;
    void this.loadDetail(id);
  };

  constructor() {
    super({
      id: 'storage-facility-map',
      title: 'Strategic Storage Atlas',
      defaultRowSpan: 2,
      infoTooltip:
        'Curated registry of strategic storage assets — underground gas storage, strategic ' +
        'petroleum reserves, LNG terminals, crude tank farms. Public badge is derived from ' +
        'evidence (operator statements, sanction refs, commercial state, physical signals) — ' +
        'see /docs/methodology/storage for the classifier spec.',
    });
    // Loose coupling with DeckGLMap: map clicks on a storage dot dispatch
    // 'energy:open-storage-facility-detail' with the id, and this panel
    // opens its drawer. No-op if the panel isn't mounted.
    if (typeof window !== 'undefined') {
      window.addEventListener('energy:open-storage-facility-detail', this.openDetailHandler);
    }
  }

  public destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('energy:open-storage-facility-detail', this.openDetailHandler);
    }
    super.destroy?.();
  }

  public async fetchData(): Promise<void> {
    try {
      // Bootstrap lane via the shared store. Reads once across both
      // consumers (this panel + DeckGLMap storage layer); returns the
      // cached value on subsequent calls instead of draining bootstrap.
      const { registry } = getCachedStorageFacilityRegistry();
      const hydrated = buildBootstrapResponse(registry);
      if (hydrated) {
        this.data = hydrated;
        this.render();
        // Background RPC refresh for post-deploy classifier-version bumps.
        // When it lands, mirror the fresh shape into the store so the
        // map's next re-render uses the newer stamps too.
        void client.listStorageFacilities({ facilityType: '' }).then(live => {
          if (!this.element?.isConnected || !live?.facilities?.length) return;
          this.data = live;
          this.render();
          const facilitiesRecord: Record<string, StorageFacilityEntry> =
            Object.fromEntries(live.facilities.map(f => [f.id, f]));
          setCachedStorageFacilityRegistry({
            facilities: facilitiesRecord,
            classifierVersion: live.classifierVersion,
            updatedAt: live.fetchedAt,
          });
        }).catch(() => {});
        return;
      }

      const live = await client.listStorageFacilities({ facilityType: '' });
      if (!this.element?.isConnected) return;
      if (live.upstreamUnavailable || !live.facilities?.length) {
        this.showError('Storage registry unavailable', () => void this.fetchData());
        return;
      }
      this.data = live;
      this.render();
      const facilitiesRecord: Record<string, StorageFacilityEntry> =
        Object.fromEntries(live.facilities.map(f => [f.id, f]));
      setCachedStorageFacilityRegistry({
        facilities: facilitiesRecord,
        classifierVersion: live.classifierVersion,
        updatedAt: live.fetchedAt,
      });
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError('Storage registry error', () => void this.fetchData());
    }
  }

  private async loadDetail(facilityId: string): Promise<void> {
    this.selectedId = facilityId;
    this.detailLoading = true;
    this.detailEvents = undefined;
    this.render();
    try {
      const [d, events] = await Promise.all([
        client.getStorageFacilityDetail({ facilityId }),
        client.listEnergyDisruptions({ assetId: facilityId, assetType: 'storage', ongoingOnly: false }),
      ]);
      if (!this.element?.isConnected || this.selectedId !== facilityId) return;
      this.detail = d;
      this.detailEvents = (events as ListEnergyDisruptionsResponse)?.events ?? [];
      this.detailLoading = false;
      this.render();
    } catch {
      if (!this.element?.isConnected) return;
      // Mirror the stale-response guard on the failure path: if the user
      // has clicked a different facility while this request was in flight,
      // the newer request owns detailLoading / detail state.
      if (this.selectedId !== facilityId) return;
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
      return `<div class="sf-evidence">
        <div class="sf-sub" style="margin-bottom:6px">Disruption timeline</div>
        <div class="sf-ev-item sf-sub">No disruption events on file for this asset.</div>
      </div>`;
    }
    const items = this.detailEvents.map(ev => {
      const window = escapeHtml(formatEventWindow(ev.startAt, ev.endAt));
      const cap = formatCapacityOffline(ev.capacityOfflineBcmYr, ev.capacityOfflineMbd);
      const capLine = cap ? ` · ${escapeHtml(cap)} offline` : '';
      const causes = (ev.causeChain && ev.causeChain.length > 0)
        ? ` · ${escapeHtml(ev.causeChain.join(' → '))}`
        : '';
      return `<div class="sf-ev-item">
        <strong>${escapeHtml(ev.eventType || 'event')}</strong> · ${window}${capLine}${causes}
        <div class="sf-sub" style="margin-top:2px">${escapeHtml(ev.shortDescription || '')}</div>
      </div>`;
    }).join('');
    return `<div class="sf-evidence">
      <div class="sf-sub" style="margin-bottom:6px">Disruption timeline (${this.detailEvents.length})</div>
      ${items}
    </div>`;
  }

  private render(): void {
    if (!this.data) return;

    const rows = [...this.data.facilities]
      // Non-operational first (what an atlas reader cares about), then by
      // facility type + name for a stable tie-breaker.
      .sort((a, b) => {
        const aOp = a.publicBadge === 'operational' ? 1 : 0;
        const bOp = b.publicBadge === 'operational' ? 1 : 0;
        if (aOp !== bOp) return aOp - bOp;
        if (a.facilityType !== b.facilityType) return a.facilityType.localeCompare(b.facilityType);
        return a.name.localeCompare(b.name);
      })
      .map(f => this.renderRow(f))
      .join('');

    const attribution = attributionFooterHtml({
      sourceType: 'classifier',
      method: 'evidence → badge (deterministic)',
      sampleSize: this.data.facilities.length,
      sampleLabel: 'facilities',
      updatedAt: this.data.fetchedAt,
      classifierVersion: this.data.classifierVersion,
      creditName: 'Global Energy Monitor (CC-BY 4.0) / GIE AGSI+ / EIA',
      creditUrl: 'https://globalenergymonitor.org/',
    });

    const drawer = this.selectedId ? this.renderDrawer() : '';

    this.setContent(`
      <div class="sf-wrap">
        <table class="sf-table">
          <thead>
            <tr>
              <th>Facility</th>
              <th>Country · Type</th>
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
        .sf-wrap { position: relative; font-size: 11px; }
        .sf-table { width: 100%; border-collapse: collapse; }
        .sf-table th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim, #888); padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .sf-table td { padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.04); }
        .sf-table tr.sf-row { cursor: pointer; }
        .sf-table tr.sf-row:hover td { background: rgba(255,255,255,0.03); }
        .sf-name { font-weight: 600; color: var(--text, #eee); }
        .sf-sub  { font-size: 9px; color: var(--text-dim, #888); text-transform: uppercase; letter-spacing: 0.04em; }
        .sf-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9px; font-weight: 700; color: #fff; text-transform: uppercase; letter-spacing: 0.04em; }
        .sf-drawer { position: absolute; inset: 0; background: var(--panel-bg, #0f1218); padding: 12px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; }
        .sf-drawer-close { position: absolute; top: 8px; right: 10px; background: transparent; border: 0; color: var(--text-dim, #888); cursor: pointer; font-size: 14px; }
        .sf-drawer h3 { margin: 0 0 6px 0; font-size: 13px; color: var(--text, #eee); }
        .sf-drawer .sf-kv { display: grid; grid-template-columns: 120px 1fr; gap: 4px 10px; font-size: 10px; margin-bottom: 10px; }
        .sf-drawer .sf-kv-key { color: var(--text-dim, #888); text-transform: uppercase; letter-spacing: 0.04em; font-size: 9px; padding-top: 2px; }
        .sf-evidence { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06); }
        .sf-ev-item { font-size: 10px; color: var(--text, #eee); margin-bottom: 6px; }
        .sf-ev-item a { color: #4ade80; text-decoration: none; }
        .sf-ev-item a:hover { text-decoration: underline; }
      </style>
    `);

    const table = this.element?.querySelector('.sf-table') as HTMLTableElement | null;
    table?.querySelectorAll<HTMLTableRowElement>('tr.sf-row').forEach(tr => {
      const id = tr.dataset.facilityId;
      if (!id) return;
      tr.addEventListener('click', () => void this.loadDetail(id));
    });
    const closeBtn = this.element?.querySelector<HTMLButtonElement>('.sf-drawer-close');
    closeBtn?.addEventListener('click', () => this.closeDetail());
  }

  private renderRow(f: StorageFacilityEntry): string {
    const glyph = TYPE_GLYPH[f.facilityType] ?? '🔹';
    const typeLabel = TYPE_LABEL[f.facilityType] ?? f.facilityType;
    return `
      <tr class="sf-row" data-facility-id="${escapeHtml(f.id)}">
        <td>
          <div class="sf-name">${glyph} ${escapeHtml(f.name)}</div>
          <div class="sf-sub">${escapeHtml(f.operator || '')}</div>
        </td>
        <td>${escapeHtml(f.country)} · ${escapeHtml(typeLabel)}</td>
        <td>${escapeHtml(capacityLabel(f))}</td>
        <td>${badgeChip(f.publicBadge)}</td>
      </tr>`;
  }

  private renderDrawer(): string {
    if (this.detailLoading) {
      return `<div class="sf-drawer"><button class="sf-drawer-close" aria-label="Close">✕</button>Loading…</div>`;
    }
    const f = this.detail?.facility;
    if (!f) {
      return `<div class="sf-drawer"><button class="sf-drawer-close" aria-label="Close">✕</button>Facility detail unavailable.</div>`;
    }

    const ev = f.evidence;
    // sanitizeUrl drops disallowed schemes (javascript:, data:, etc.) and
    // returns '' for invalid URLs; we suppress the <a> when sanitize rejects.
    const sanctionItems = (ev?.sanctionRefs ?? []).map(s => {
      const safeUrl = sanitizeUrl(s.url || '');
      const linkLabel = escapeHtml(s.date || 'source');
      const dateLink = safeUrl
        ? `<a href="${safeUrl}" target="_blank" rel="noopener">${linkLabel}</a>`
        : linkLabel;
      return `
      <div class="sf-ev-item">
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
          return `<div class="sf-ev-item"><strong>Operator:</strong> ${escapeHtml(ev.operatorStatement.text)}
           ${dateLink}
         </div>`;
        })()
      : '';

    const fillLine = ev?.fillDisclosed
      ? `<div class="sf-ev-item"><strong>Fill levels:</strong> disclosed via ${escapeHtml(ev.fillSource || '—')}</div>`
      : `<div class="sf-ev-item"><strong>Fill levels:</strong> not publicly disclosed</div>`;

    const typeLabel = TYPE_LABEL[f.facilityType] ?? f.facilityType;

    return `
      <div class="sf-drawer">
        <button class="sf-drawer-close" aria-label="Close">✕</button>
        <h3>${escapeHtml(f.name)} ${badgeChip(f.publicBadge)}</h3>
        <div class="sf-kv">
          <div class="sf-kv-key">Operator</div>   <div>${escapeHtml(f.operator)}</div>
          <div class="sf-kv-key">Type</div>       <div>${escapeHtml(typeLabel)}</div>
          <div class="sf-kv-key">Country</div>    <div>${escapeHtml(f.country)}</div>
          <div class="sf-kv-key">Capacity</div>   <div>${escapeHtml(capacityLabel(f))}</div>
          <div class="sf-kv-key">Location</div>   <div>${(f.location?.lat ?? 0).toFixed(3)}°, ${(f.location?.lon ?? 0).toFixed(3)}°</div>
          <div class="sf-kv-key">In service</div> <div>${f.inService > 0 ? escapeHtml(String(f.inService)) : '—'}</div>
        </div>
        <div class="sf-evidence">
          <div class="sf-sub" style="margin-bottom:6px">Evidence</div>
          <div class="sf-ev-item">
            <strong>Physical state:</strong> ${escapeHtml(ev?.physicalState || 'unknown')}
            (source: ${escapeHtml(ev?.physicalStateSource || 'unknown')})
          </div>
          <div class="sf-ev-item"><strong>Commercial:</strong> ${escapeHtml(ev?.commercialState || 'unknown')}</div>
          ${fillLine}
          ${operatorStatement}
          ${sanctionItems}
          ${ev?.classifierVersion ? `<div class="sf-ev-item sf-sub">Classifier ${escapeHtml(ev.classifierVersion)} · confidence ${Math.round((ev.classifierConfidence ?? 0) * 100)}%</div>` : ''}
        </div>
        ${this.renderDisruptionTimeline()}
      </div>`;
  }
}
