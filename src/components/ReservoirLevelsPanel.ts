import { Panel } from './Panel';
import { joinSafeHtml, safeHtml, unsafeRawHtml, type SafeHtml } from '@/utils/sanitize';
import { getLocale, t } from '@/services/i18n';
import type { ReservoirLevel, ReservoirLevelsFetchResult } from '@/services/climate';
import {
  RESERVOIR_FILTERS,
  RESERVOIR_PROCESSING_URL,
  RESERVOIR_ATL06_SOURCE_URL,
  RESERVOIR_SOURCE_URL,
  filterReservoirs,
  reservoirDetail,
  reservoirHeadline,
  reservoirPlace,
  reservoirSparkline,
  reservoirTone,
  sortReservoirs,
  statusLabel,
  type ReservoirFilter,
  type ReservoirFormatContext,
} from './reservoir-levels-view';
import '../styles/reservoir-levels.css';

/**
 * Strategic Water Levels: which reservoirs and lakes are abnormal now, in which
 * direction, and how old the satellite pass is. Opt-in; the data loader reads
 * the RPC only while this panel or the map layer is on.
 */
export class ReservoirLevelsPanel extends Panel {
  private reservoirs: ReservoirLevel[] = [];
  private loaded = false;
  private filter: ReservoirFilter = 'all';
  private onSelect?: (reservoir: ReservoirLevel) => void;

  constructor() {
    super({
      id: 'reservoir-levels',
      title: t('panels.reservoirLevels'),
      showCount: true,
      infoTooltip: t('components.reservoirLevels.note'),
    });
    // Delegated on the stable content node: setSafeContent debounces the DOM
    // write, so per-row listeners would bind the loading placeholder.
    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const chip = target?.closest<HTMLButtonElement>('button[data-wl-filter]');
      if (chip && this.content.contains(chip)) {
        this.setFilter(chip.dataset.wlFilter as ReservoirFilter);
        return;
      }
      const row = target?.closest<HTMLButtonElement>('button[data-reservoir-id]');
      if (!row || !this.content.contains(row)) return;
      const reservoir = this.reservoirs.find((r) => r.id === row.dataset.reservoirId);
      if (reservoir) this.onSelect?.(reservoir);
    });
  }

  public setSelectHandler(handler: (reservoir: ReservoirLevel) => void): void {
    this.onSelect = handler;
  }

  public hasData(): boolean {
    return this.loaded && this.reservoirs.length > 0;
  }

  /** A failed request keeps rows already shown; with none, it is an error, not "no readings". */
  public setResult(result: ReservoirLevelsFetchResult): void {
    if (!result.ok && !result.snapshot) {
      if (this.hasData()) return;
      this.showError(t('components.reservoirLevels.unavailable'));
      return;
    }
    this.reservoirs = result.snapshot?.reservoirs ?? [];
    this.loaded = true;
    this.render();
  }

  public setFilter(filter: ReservoirFilter): void {
    if (!RESERVOIR_FILTERS.includes(filter) || filter === this.filter) return;
    this.filter = filter;
    this.render();
  }

  private render(): void {
    if (this.reservoirs.length === 0) {
      this.setCount(0);
      this.setSafeContent(safeHtml`<div class="wl-panel">
        <div class="panel-empty wl-empty">${t('components.reservoirLevels.empty')}</div>
        ${this.footer()}
      </div>`);
      return;
    }

    const ctx: ReservoirFormatContext = { t, locale: getLocale(), nowMs: Date.now() };
    const visible = sortReservoirs(filterReservoirs(this.reservoirs, this.filter));
    this.setCount(visible.length);

    const chips = joinSafeHtml(RESERVOIR_FILTERS.map((filter) => {
      const active = filter === this.filter;
      const count = filterReservoirs(this.reservoirs, filter).length;
      return safeHtml`<button type="button" class="panel-tab wl-filter${active ? ' active' : ''}" data-wl-filter="${filter}" aria-pressed="${active}">${t(`components.reservoirLevels.filter.${filter}`)} <span class="wl-filter-count">${count}</span></button>`;
    }));

    const rows = visible.length
      ? safeHtml`<ul class="wl-list">${joinSafeHtml(visible.map((r) => this.row(r, ctx)))}</ul>`
      : safeHtml`<div class="panel-empty wl-empty">${t('components.reservoirLevels.filterEmpty')}</div>`;

    // The swap replaces the filter buttons; a keyboard user who just activated one
    // would lose focus, so put it back on the active filter once the DOM is written.
    const refocusFilter = this.content.querySelector('.wl-filters')?.contains(document.activeElement) ?? false;
    // Only when the swap itself took focus away: if the user moved on during the debounce,
    // focus sits on a live element and stays there.
    const restoreFocus = refocusFilter
      ? () => {
        const now = document.activeElement;
        if (now && now !== document.body && now.isConnected) return;
        this.content.querySelector<HTMLButtonElement>(`button[data-wl-filter="${this.filter}"]`)?.focus();
      }
      : undefined;

    this.setSafeContent(safeHtml`<div class="wl-panel">
      <div class="panel-tabs wl-filters" role="group" aria-label="${t('components.reservoirLevels.filterLabel')}">${chips}</div>
      ${rows}
      ${this.footer()}
    </div>`, restoreFocus);
  }

  private row(r: ReservoirLevel, ctx: ReservoirFormatContext): SafeHtml {
    const tone = reservoirTone(r.status);
    const spark = reservoirSparkline(r);
    return safeHtml`<li><button type="button" class="wl-row wl-tone-${tone}" data-reservoir-id="${r.id}" data-status="${r.status}">
      <span class="wl-id"><span class="wl-name" title="${r.name}">${r.name}</span><span class="wl-place">${reservoirPlace(r, ctx.locale)}</span></span>
      <span class="wl-chip">${statusLabel(r, t)}</span>
      <span class="wl-headline">${reservoirHeadline(r, ctx)}</span>
      <span class="wl-spark">${unsafeRawHtml(spark, 'miniSparkline builds the SVG from numbers only')}</span>
      <span class="wl-detail">${reservoirDetail(r, ctx)}</span>
    </button></li>`;
  }

  private footer(): SafeHtml {
    return safeHtml`<footer class="wl-footer">
      <p>${t('components.reservoirLevels.note')}</p>
      <p>${t('components.reservoirLevels.source')} <a href="${RESERVOIR_SOURCE_URL}" target="_blank" rel="noopener noreferrer">NASA ICESat-2 ATL13</a> / <a href="${RESERVOIR_ATL06_SOURCE_URL}" target="_blank" rel="noopener noreferrer">ATL06</a> (NSIDC) · ${t('components.reservoirLevels.processedWith')} <a href="${RESERVOIR_PROCESSING_URL}" target="_blank" rel="noopener noreferrer">SlideRule Earth</a></p>
    </footer>`;
  }
}
