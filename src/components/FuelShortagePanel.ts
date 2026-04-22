import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { attributionFooterHtml, ATTRIBUTION_FOOTER_CSS } from '@/utils/attribution-footer';
import { SupplyChainServiceClient } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type {
  ListFuelShortagesResponse,
  FuelShortageEntry,
  GetFuelShortageDetailResponse,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import {
  deriveShortageEvidenceQuality,
  countEvidenceSources,
  type EvidenceQuality,
} from '@/shared/shortage-evidence';
import {
  getCachedFuelShortageRegistry,
  setCachedFuelShortageRegistry,
  type RawFuelShortageRegistry,
} from '@/shared/fuel-shortage-registry-store';

const client = new SupplyChainServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

const SEVERITY_COLOR: Record<string, string> = {
  confirmed: '#e74c3c',
  watch:     '#f39c12',
};

// Single unicode glyph per product. Used in the table row so readers can
// scan by product type without the column having to widen.
const PRODUCT_GLYPH: Record<string, string> = {
  petrol:      '⛽',
  diesel:      '🛢️',
  jet:         '✈️',
  heating_oil: '🔥',
};

const QUALITY_DOT: Record<EvidenceQuality, string> = {
  strong:   '●●●',
  moderate: '●●○',
  thin:     '●○○',
};

function severityChip(severity: string): string {
  const color = SEVERITY_COLOR[severity] ?? '#7f8c8d';
  const label = severity.charAt(0).toUpperCase() + severity.slice(1);
  return `<span class="fs-badge" style="background:${color}">${escapeHtml(label)}</span>`;
}

function projectRawShortage(raw: unknown): FuelShortageEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;

  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  const ev = (r.evidence ?? null) as Record<string, unknown> | null;
  const evidenceSources = Array.isArray(ev?.evidenceSources)
    ? (ev.evidenceSources as unknown[]).map(s => {
        const o = (s ?? {}) as Record<string, unknown>;
        return {
          authority: str(o.authority),
          title: str(o.title),
          url: str(o.url),
          date: str(o.date),
          sourceType: str(o.sourceType),
        };
      })
    : [];

  const evidence = ev
    ? {
        evidenceSources,
        firstRegulatorConfirmation: str(ev.firstRegulatorConfirmation),
        classifierVersion: str(ev.classifierVersion, 'v1'),
        classifierConfidence: num(ev.classifierConfidence, 0),
        lastEvidenceUpdate: str(ev.lastEvidenceUpdate),
      }
    : undefined;

  return {
    id,
    country: str(r.country),
    product: str(r.product),
    severity: str(r.severity, 'watch'),
    firstSeen: str(r.firstSeen),
    lastConfirmed: str(r.lastConfirmed),
    // `resolvedAt: null` in seed → empty string in proto. Handle both.
    resolvedAt: typeof r.resolvedAt === 'string' ? r.resolvedAt : '',
    impactTypes: Array.isArray(r.impactTypes)
      ? (r.impactTypes as unknown[]).map(t => str(t)).filter(s => s.length > 0)
      : [],
    causeChain: Array.isArray(r.causeChain)
      ? (r.causeChain as unknown[]).map(t => str(t)).filter(s => s.length > 0)
      : [],
    shortDescription: str(r.shortDescription),
    evidence,
  };
}

function buildBootstrapResponse(
  registry: RawFuelShortageRegistry | undefined,
): ListFuelShortagesResponse | null {
  if (!registry?.shortages) return null;
  const shortages: FuelShortageEntry[] = [];
  for (const raw of Object.values(registry.shortages)) {
    const projected = projectRawShortage(raw);
    if (projected) shortages.push(projected);
  }
  if (shortages.length === 0) return null;
  return {
    shortages,
    fetchedAt: registry.updatedAt ?? '',
    classifierVersion: registry.classifierVersion ?? 'v1',
    upstreamUnavailable: false,
  };
}

export class FuelShortagePanel extends Panel {
  private data: ListFuelShortagesResponse | null = null;
  private selectedId: string | null = null;
  private detail: GetFuelShortageDetailResponse | null = null;
  private detailLoading = false;
  private openDetailHandler = (ev: Event): void => {
    const id = (ev as CustomEvent<{ shortageId?: string }>).detail?.shortageId;
    if (!id || !this.element?.isConnected) return;
    void this.loadDetail(id);
  };

  constructor() {
    super({
      id: 'fuel-shortages',
      title: 'Global Fuel Shortage Registry',
      defaultRowSpan: 2,
      infoTooltip:
        'Global fuel-shortage alert registry (petrol, diesel, jet, heating oil). Severity ' +
        '(confirmed / watch) is a classifier output, not a client derivation. Every row ' +
        'carries the full evidence source list — see /docs/methodology/shortages for the ' +
        'threshold spec + classifier version.',
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('energy:open-fuel-shortage-detail', this.openDetailHandler);
    }
  }

  public destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('energy:open-fuel-shortage-detail', this.openDetailHandler);
    }
    super.destroy?.();
  }

  public async fetchData(): Promise<void> {
    try {
      const { registry } = getCachedFuelShortageRegistry();
      const hydrated = buildBootstrapResponse(registry);
      if (hydrated) {
        this.data = hydrated;
        this.render();
        void client.listFuelShortages({ country: '', product: '', severity: '' }).then(live => {
          if (!this.element?.isConnected || !live?.shortages?.length) return;
          this.data = live;
          this.render();
          const shortagesRecord: Record<string, FuelShortageEntry> =
            Object.fromEntries(live.shortages.map(s => [s.id, s]));
          setCachedFuelShortageRegistry({
            shortages: shortagesRecord,
            classifierVersion: live.classifierVersion,
            updatedAt: live.fetchedAt,
          });
        }).catch(() => {});
        return;
      }

      const live = await client.listFuelShortages({ country: '', product: '', severity: '' });
      if (!this.element?.isConnected) return;
      if (live.upstreamUnavailable || !live.shortages?.length) {
        this.showError('Fuel shortage registry unavailable', () => void this.fetchData());
        return;
      }
      this.data = live;
      this.render();
      const shortagesRecord: Record<string, FuelShortageEntry> =
        Object.fromEntries(live.shortages.map(s => [s.id, s]));
      setCachedFuelShortageRegistry({
        shortages: shortagesRecord,
        classifierVersion: live.classifierVersion,
        updatedAt: live.fetchedAt,
      });
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError('Fuel shortage registry error', () => void this.fetchData());
    }
  }

  private async loadDetail(shortageId: string): Promise<void> {
    this.selectedId = shortageId;
    this.detailLoading = true;
    this.render();
    try {
      const d = await client.getFuelShortageDetail({ shortageId });
      if (!this.element?.isConnected || this.selectedId !== shortageId) return;
      this.detail = d;
      this.detailLoading = false;
      this.render();
    } catch {
      if (!this.element?.isConnected) return;
      if (this.selectedId !== shortageId) return;
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

    // Sort confirmed before watch; within each tier, strongest evidence first,
    // then most recently confirmed. Readers scan high-impact + high-trust rows
    // first — the classifier's confidence ordering is the tie-breaker.
    const rows = [...this.data.shortages]
      .sort((a, b) => {
        const aConf = a.severity === 'confirmed' ? 0 : 1;
        const bConf = b.severity === 'confirmed' ? 0 : 1;
        if (aConf !== bConf) return aConf - bConf;
        const aQ = deriveShortageEvidenceQuality(a.evidence);
        const bQ = deriveShortageEvidenceQuality(b.evidence);
        const qualityRank: Record<EvidenceQuality, number> = { strong: 0, moderate: 1, thin: 2 };
        if (qualityRank[aQ] !== qualityRank[bQ]) return qualityRank[aQ] - qualityRank[bQ];
        return b.lastConfirmed.localeCompare(a.lastConfirmed);
      })
      .map(s => this.renderRow(s))
      .join('');

    const confirmed = this.data.shortages.filter(s => s.severity === 'confirmed').length;
    const watch = this.data.shortages.filter(s => s.severity === 'watch').length;
    const summary = `${confirmed} confirmed · ${watch} watch`;

    const attribution = attributionFooterHtml({
      sourceType: 'classifier',
      method: 'evidence-threshold + LLM double-check',
      sampleSize: this.data.shortages.length,
      sampleLabel: 'active shortages',
      updatedAt: this.data.fetchedAt,
      classifierVersion: this.data.classifierVersion,
      creditName: 'Regulator advisories + IEA + major wire',
      creditUrl: '/docs/methodology/shortages',
    });

    const drawer = this.selectedId ? this.renderDrawer() : '';

    this.setContent(`
      <div class="fs-wrap">
        <div class="fs-summary">${escapeHtml(summary)}</div>
        <table class="fs-table">
          <thead>
            <tr>
              <th>Country · Product</th>
              <th>Since</th>
              <th>Evidence</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${attribution}
        ${drawer}
      </div>
      ${ATTRIBUTION_FOOTER_CSS}
      <style>
        .fs-wrap { position: relative; font-size: 11px; }
        .fs-summary { font-size: 10px; color: var(--text-dim, #888); text-transform: uppercase; letter-spacing: 0.04em; margin: 4px 0 6px 0; }
        .fs-table { width: 100%; border-collapse: collapse; }
        .fs-table th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim, #888); padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .fs-table td { padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.04); }
        .fs-table tr.fs-row { cursor: pointer; }
        .fs-table tr.fs-row:hover td { background: rgba(255,255,255,0.03); }
        .fs-name { font-weight: 600; color: var(--text, #eee); }
        .fs-sub  { font-size: 9px; color: var(--text-dim, #888); text-transform: uppercase; letter-spacing: 0.04em; }
        .fs-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9px; font-weight: 700; color: #fff; text-transform: uppercase; letter-spacing: 0.04em; }
        .fs-quality { font-family: monospace; font-size: 10px; color: var(--text-dim, #888); }
        .fs-drawer { position: absolute; inset: 0; background: var(--panel-bg, #0f1218); padding: 12px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; }
        .fs-drawer-close { position: absolute; top: 8px; right: 10px; background: transparent; border: 0; color: var(--text-dim, #888); cursor: pointer; font-size: 14px; }
        .fs-drawer h3 { margin: 0 0 6px 0; font-size: 13px; color: var(--text, #eee); }
        .fs-drawer .fs-kv { display: grid; grid-template-columns: 120px 1fr; gap: 4px 10px; font-size: 10px; margin-bottom: 10px; }
        .fs-drawer .fs-kv-key { color: var(--text-dim, #888); text-transform: uppercase; letter-spacing: 0.04em; font-size: 9px; padding-top: 2px; }
        .fs-source-list { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06); }
        .fs-src-item { font-size: 10px; color: var(--text, #eee); margin-bottom: 6px; }
        .fs-src-item a { color: #4ade80; text-decoration: none; }
        .fs-src-item a:hover { text-decoration: underline; }
        .fs-src-type { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; background: rgba(255,255,255,0.08); color: var(--text-dim, #aaa); margin-right: 4px; }
        .fs-src-type-regulator { background: #2980b9; color: #fff; }
        .fs-src-type-operator { background: #27ae60; color: #fff; }
        .fs-src-type-press { background: #555; color: #ccc; }
      </style>
    `);

    const table = this.element?.querySelector('.fs-table') as HTMLTableElement | null;
    table?.querySelectorAll<HTMLTableRowElement>('tr.fs-row').forEach(tr => {
      const id = tr.dataset.shortageId;
      if (!id) return;
      tr.addEventListener('click', () => void this.loadDetail(id));
    });
    const closeBtn = this.element?.querySelector<HTMLButtonElement>('.fs-drawer-close');
    closeBtn?.addEventListener('click', () => this.closeDetail());
  }

  private renderRow(s: FuelShortageEntry): string {
    const glyph = PRODUCT_GLYPH[s.product] ?? '•';
    const quality = deriveShortageEvidenceQuality(s.evidence);
    return `
      <tr class="fs-row" data-shortage-id="${escapeHtml(s.id)}">
        <td>
          <div class="fs-name">${glyph} ${escapeHtml(s.country)} · ${escapeHtml(s.product)}</div>
          <div class="fs-sub">${escapeHtml(s.causeChain.join(' · ') || '—')}</div>
        </td>
        <td>${escapeHtml(s.firstSeen.slice(0, 10))}</td>
        <td><span class="fs-quality" title="Evidence quality: ${escapeHtml(quality)}">${QUALITY_DOT[quality]}</span></td>
        <td>${severityChip(s.severity)}</td>
      </tr>`;
  }

  private renderDrawer(): string {
    if (this.detailLoading) {
      return `<div class="fs-drawer"><button class="fs-drawer-close" aria-label="Close">✕</button>Loading…</div>`;
    }
    const s = this.detail?.shortage;
    if (!s) {
      return `<div class="fs-drawer"><button class="fs-drawer-close" aria-label="Close">✕</button>Shortage detail unavailable.</div>`;
    }

    const ev = s.evidence;
    const counts = countEvidenceSources(ev?.evidenceSources);
    const quality = deriveShortageEvidenceQuality(ev);
    const sources = (ev?.evidenceSources ?? []).map(src => {
      const safeUrl = sanitizeUrl(src.url || '');
      const linkText = escapeHtml(src.title || src.authority || 'source');
      const link = safeUrl
        ? `<a href="${safeUrl}" target="_blank" rel="noopener">${linkText}</a>`
        : linkText;
      const typeClass = `fs-src-type-${escapeHtml(src.sourceType || 'other')}`;
      return `
      <div class="fs-src-item">
        <span class="fs-src-type ${typeClass}">${escapeHtml(src.sourceType || 'other')}</span>
        <strong>${escapeHtml(src.authority || '')}</strong> · ${link} · ${escapeHtml(src.date.slice(0, 10))}
      </div>`;
    }).join('');

    return `
      <div class="fs-drawer">
        <button class="fs-drawer-close" aria-label="Close">✕</button>
        <h3>${escapeHtml(s.country)} · ${escapeHtml(s.product)} ${severityChip(s.severity)}</h3>
        <div class="fs-kv">
          <div class="fs-kv-key">Description</div>  <div>${escapeHtml(s.shortDescription)}</div>
          <div class="fs-kv-key">First seen</div>   <div>${escapeHtml(s.firstSeen.slice(0, 10))}</div>
          <div class="fs-kv-key">Last confirmed</div><div>${escapeHtml(s.lastConfirmed.slice(0, 10))}</div>
          <div class="fs-kv-key">Resolved</div>     <div>${s.resolvedAt ? escapeHtml(s.resolvedAt.slice(0, 10)) : 'Active'}</div>
          <div class="fs-kv-key">Impact</div>       <div>${escapeHtml(s.impactTypes.join(', ') || '—')}</div>
          <div class="fs-kv-key">Cause chain</div>  <div>${escapeHtml(s.causeChain.join(' → ') || '—')}</div>
          <div class="fs-kv-key">Evidence</div>     <div>${counts.authoritative} regulator/operator · ${counts.press} press · quality: ${escapeHtml(quality)}</div>
          ${ev?.classifierVersion ? `<div class="fs-kv-key">Classifier</div><div>${escapeHtml(ev.classifierVersion)} · confidence ${Math.round((ev.classifierConfidence ?? 0) * 100)}%</div>` : ''}
        </div>
        <div class="fs-source-list">
          <div class="fs-sub" style="margin-bottom:6px">Evidence sources (${(ev?.evidenceSources ?? []).length})</div>
          ${sources || '<div class="fs-src-item">No sources on file.</div>'}
        </div>
      </div>`;
  }
}
