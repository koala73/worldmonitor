import { Panel } from './Panel';
import {
  fetchChinaCorridorControlTowers,
  type ChinaCorridorCondition,
  type ChinaCorridorControlTower,
  type ChinaCorridorControlTowerResponse,
  type CorridorAvailability,
  type CorridorSourceSignal,
} from '@/services/supply-chain';
import {
  CHINA_CORRIDOR_SIGNAL_FAMILIES,
  type ChinaCorridorSignalFamily,
  type ChinaLogisticsCorridorId,
} from '../../shared/china-logistics-corridors';
import { escapeHtml, sanitizeUrl, unsafeRawHtml } from '@/utils/sanitize';

const FAMILY_LABELS: Record<ChinaCorridorSignalFamily, string> = {
  port: 'Ports',
  aviation: 'Aviation',
  hazard: 'Hazards',
  power_energy: 'Power / energy',
  strategic_industry: 'Strategic industry',
  trade: 'Trade',
};

const AVAILABILITY_LABELS: Record<CorridorAvailability, string> = {
  available: 'Available',
  partial: 'Partial',
  stale: 'Stale',
  unavailable: 'Unavailable',
};
const RENDERER_HINT =
  'The active map renderer centers this corridor but cannot draw its boundary or nodes. Use the WebGL 2D map on a supported device to view the overlay.';

function formatDate(
  value: string | null,
  precision: CorridorSourceSignal['observationTimePrecision'],
): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Time unavailable';
  const date = new Date(value);
  if (precision === 'year') return String(date.getUTCFullYear());
  if (precision === 'month') {
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  if (precision === 'day') {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

function signalHtml(signal: CorridorSourceSignal): string {
  const sourceUrl = signal.sourceUrl ? sanitizeUrl(signal.sourceUrl) : '';
  const publisher = sourceUrl
    ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(signal.publisher.name)}</a>`
    : escapeHtml(signal.publisher.name);
  return `
    <li class="china-corridor-source" data-source-availability="${signal.availability}">
      <div class="china-corridor-source__summary">${escapeHtml(signal.summary)}</div>
      <div class="china-corridor-source__meta">
        <span>${publisher}</span>
        <span>source ${escapeHtml(signal.availability)}</span>
        <span>observed ${escapeHtml(formatDate(signal.observationTime, signal.observationTimePrecision))} (${escapeHtml(signal.observationTimePrecision)})</span>
        <span>released ${escapeHtml(formatDate(signal.releaseTime, signal.releaseTimePrecision))} (${escapeHtml(signal.releaseTimePrecision)})</span>
        <span>retrieved ${escapeHtml(formatDate(signal.retrievalTime, signal.retrievalTimePrecision))} (${escapeHtml(signal.retrievalTimePrecision)})</span>
        <span>transport ${escapeHtml(signal.transportFreshness)}</span>
        <span>content ${escapeHtml(signal.contentFreshness)}</span>
        <span>revision ${escapeHtml(signal.revision?.state ?? 'unknown')}</span>
      </div>
    </li>`;
}

function conditionHtml(condition: ChinaCorridorCondition): string {
  const sourceBody = condition.sourceSignals.length > 0
    ? `<ul class="china-corridor-sources">${condition.sourceSignals.map(signalHtml).join('')}</ul>`
    : `<p class="china-corridor-missing">${escapeHtml(condition.reason ?? 'No reviewed source signal is available.')}</p>`;
  return `
    <article class="china-corridor-condition" data-family="${condition.family}" data-availability="${condition.availability}">
      <header>
        <h4>${escapeHtml(FAMILY_LABELS[condition.family])}</h4>
        <span class="china-corridor-status china-corridor-status--${condition.availability}">
          ${escapeHtml(AVAILABILITY_LABELS[condition.availability])}
        </span>
      </header>
      <div class="china-corridor-provider">Provider family: ${escapeHtml(condition.providerId)}</div>
      ${sourceBody}
    </article>`;
}

function injectStyles(): void {
  if (document.getElementById('china-corridor-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'china-corridor-panel-styles';
  style.textContent = `
    .china-corridor-panel { display: grid; gap: 12px; min-width: 0; }
    .china-corridor-compare { display: grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap: 8px; }
    .china-corridor-compare button { min-height: 64px; text-align: left; padding: 8px; color: var(--text); background: color-mix(in srgb,var(--panel-bg) 80%,transparent); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
    .china-corridor-compare button[aria-selected="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .china-corridor-compare strong,.china-corridor-compare small { display: block; }
    .china-corridor-compare small { margin-top: 4px; color: var(--text-dim); }
    .china-corridor-filters { display: flex; flex-wrap: wrap; gap: 6px; }
    .china-corridor-filters button { min-height: 36px; padding: 5px 9px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--text-dim); cursor: pointer; }
    .china-corridor-filters button[aria-pressed="true"] { color: var(--text); border-color: var(--accent); background: color-mix(in srgb,var(--accent) 14%,transparent); }
    .china-corridor-detail__heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .china-corridor-detail__heading h3 { margin: 0; font-size: 14px; }
    .china-corridor-description { margin: 4px 0 0; color: var(--text-dim); font-size: 11px; line-height: 1.45; }
    .china-corridor-conditions { display: grid; grid-template-columns: repeat(auto-fit,minmax(210px,1fr)); gap: 8px; margin-top: 10px; }
    .china-corridor-condition { min-width: 0; padding: 9px; border: 1px solid var(--border); border-radius: 6px; }
    .china-corridor-condition header { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .china-corridor-condition h4 { margin: 0; font-size: 12px; }
    .china-corridor-status { font: 700 9px/1 var(--font-mono); letter-spacing: .05em; text-transform: uppercase; }
    .china-corridor-status--available { color: #39c77a; }
    .china-corridor-status--partial,.china-corridor-status--stale { color: #e5a742; }
    .china-corridor-status--unavailable { color: var(--text-dim); }
    .china-corridor-provider { margin-top: 5px; color: var(--text-dim); font-size: 9px; overflow-wrap: anywhere; }
    .china-corridor-sources { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 7px; }
    .china-corridor-source { padding-top: 7px; border-top: 1px solid var(--border); }
    .china-corridor-source__summary { font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
    .china-corridor-source__meta { display: flex; flex-wrap: wrap; gap: 3px 8px; margin-top: 5px; color: var(--text-dim); font-size: 9px; overflow-wrap: anywhere; }
    .china-corridor-source__meta a { color: var(--accent); }
    .china-corridor-missing { margin: 8px 0 0; color: var(--text-dim); font-size: 11px; line-height: 1.4; }
    .china-corridor-renderer-hint { margin: 8px 0 0; color: var(--warning); font-size: 11px; line-height: 1.4; }
    @media (max-width: 520px) {
      .china-corridor-compare { grid-template-columns: 1fr 1fr; }
      .china-corridor-conditions { grid-template-columns: 1fr; }
      .china-corridor-detail__heading { display: block; }
    }
  `;
  document.head.appendChild(style);
}

export class ChinaCorridorPanel extends Panel {
  private response: ChinaCorridorControlTowerResponse = { generatedAt: '', corridors: [] };
  private selectedId: ChinaLogisticsCorridorId | null = null;
  private readonly selectedFamilies = new Set<ChinaCorridorSignalFamily>(CHINA_CORRIDOR_SIGNAL_FAMILIES);
  private onCorridorSelect: ((corridor: ChinaCorridorControlTower) => boolean | void) | null = null;
  private showRendererHint = false;

  constructor() {
    super({
      id: 'china-corridors',
      title: 'China Logistics Corridors',
      className: 'panel-wide',
      defaultRowSpan: 2,
      infoTooltip: 'Transparent control towers for four reviewed China logistics corridors. Each condition retains its own source, time, availability, and freshness; no aggregate risk score is produced.',
    });
    injectStyles();
    this.content.addEventListener('click', (event) => this.handleClick(event));
    this.content.addEventListener('keydown', (event) => this.handleKeydown(event));
  }

  public setOnCorridorSelect(
    callback: (corridor: ChinaCorridorControlTower) => boolean | void,
  ): void {
    this.onCorridorSelect = callback;
  }

  public setRendererSupportsOverlay(supported: boolean): void {
    const showRendererHint = !supported;
    if (showRendererHint === this.showRendererHint) return;
    this.showRendererHint = showRendererHint;
    if (this.selectedId !== null) this.render();
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading();
    const response = await fetchChinaCorridorControlTowers();
    if (response.corridors.length === 0) {
      this.showError('China corridor data unavailable', () => void this.fetchData());
      return false;
    }
    this.setData(response);
    return true;
  }

  public setData(response: ChinaCorridorControlTowerResponse): void {
    this.response = response;
    this.selectedId ??= response.corridors[0]?.id ?? null;
    this.render();
  }

  private selectedCorridor(): ChinaCorridorControlTower | null {
    return this.response.corridors.find((corridor) => corridor.id === this.selectedId) ?? null;
  }

  private selectCorridor(id: string, focus = false): void {
    const corridor = this.response.corridors.find((item) => item.id === id);
    if (!corridor) return;
    this.selectedId = corridor.id;
    const rendererSupportsOverlay = this.onCorridorSelect?.(corridor);
    this.showRendererHint = rendererSupportsOverlay === false;
    this.render(() => {
      if (focus) {
        this.content.querySelector<HTMLElement>(`[role="tab"][data-corridor-id="${corridor.id}"]`)?.focus();
      }
    });
  }

  private handleClick(event: Event): void {
    const target = event.target as HTMLElement;
    const corridorButton = target.closest<HTMLElement>('[data-corridor-id]');
    if (corridorButton?.dataset.corridorId) {
      this.selectCorridor(corridorButton.dataset.corridorId);
      return;
    }
    const familyButton = target.closest<HTMLElement>('[data-family-filter]');
    const family = familyButton?.dataset.familyFilter as ChinaCorridorSignalFamily | undefined;
    if (!family || !CHINA_CORRIDOR_SIGNAL_FAMILIES.includes(family)) return;
    if (this.selectedFamilies.has(family)) this.selectedFamilies.delete(family);
    else this.selectedFamilies.add(family);
    this.render();
  }

  private handleKeydown(event: KeyboardEvent): void {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"][data-corridor-id]');
    if (!tab || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const ids = this.response.corridors.map((corridor) => corridor.id);
    const current = ids.indexOf(tab.dataset.corridorId as ChinaLogisticsCorridorId);
    if (current < 0) return;
    event.preventDefault();
    let next: ChinaLogisticsCorridorId | undefined;
    if (event.key === 'Home') next = ids[0];
    else if (event.key === 'End') next = ids[ids.length - 1];
    else {
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      next = ids[(current + offset + ids.length) % ids.length];
    }
    if (next) this.selectCorridor(next, true);
  }

  private render(afterUpdate?: () => void): void {
    const selected = this.selectedCorridor();
    if (!selected) return;
    const compare = this.response.corridors.map((corridor) => {
      const available = corridor.conditions.filter((condition) => condition.availability === 'available').length;
      return `<button id="china-corridor-tab-${corridor.id}" role="tab" data-corridor-id="${corridor.id}" aria-selected="${corridor.id === selected.id}" aria-controls="china-corridor-tabpanel" tabindex="${corridor.id === selected.id ? '0' : '-1'}">
        <strong>${escapeHtml(corridor.name)}</strong>
        <small>${available}/${corridor.conditions.length} families available · ${escapeHtml(AVAILABILITY_LABELS[corridor.availability])}</small>
      </button>`;
    }).join('');
    const filters = CHINA_CORRIDOR_SIGNAL_FAMILIES.map((family) =>
      `<button type="button" data-family-filter="${family}" aria-pressed="${this.selectedFamilies.has(family)}">${escapeHtml(FAMILY_LABELS[family])}</button>`,
    ).join('');
    const conditions = selected.conditions
      .filter((condition) => this.selectedFamilies.has(condition.family))
      .map(conditionHtml)
      .join('');

    this.setSafeContent(unsafeRawHtml(`
      <div class="china-corridor-panel">
        <div class="china-corridor-compare" role="tablist" aria-label="Compare China logistics corridors">${compare}</div>
        <div class="china-corridor-filters" role="group" aria-label="Signal-family filters">${filters}</div>
        <section id="china-corridor-tabpanel" role="tabpanel" aria-labelledby="china-corridor-tab-${selected.id}">
          <div class="china-corridor-detail__heading">
            <div>
              <h3>${escapeHtml(selected.name)}</h3>
              <p class="china-corridor-description">${escapeHtml(selected.description)}</p>
            </div>
            <span class="china-corridor-status china-corridor-status--${selected.availability}">${escapeHtml(AVAILABILITY_LABELS[selected.availability])}</span>
          </div>
          ${this.showRendererHint
            ? `<p class="china-corridor-renderer-hint" role="status">${escapeHtml(RENDERER_HINT)}</p>`
            : ''}
          <div class="china-corridor-conditions">${conditions || '<p class="china-corridor-missing">Select at least one signal family.</p>'}</div>
        </section>
      </div>
    `, 'China corridor values are escaped before rendering'), afterUpdate);
  }
}
