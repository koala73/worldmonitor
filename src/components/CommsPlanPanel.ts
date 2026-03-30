import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { getPrimarySavedPlace, getSavedPlace, getSavedPlaces, subscribeSavedPlaces } from '@/services/saved-places';
import {
  buildCommsMessage,
  COMMS_STATUS_LABELS,
  COMMS_STATUS_ORDER,
  getCommsPlan,
  getResolvedCommsPlan,
  subscribeCommsPlans,
  type CommsStatus,
} from '@/services/comms-plan';
import { getCommsDirectoryLinks } from '@/services/comms-directory';
import { buildCommsFieldCard } from '@/services/comms-export';
import { exportCommsPlanCSV, exportCommsPlanJSON } from '@/utils/export';

function formatUpdatedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard API unavailable');
  }
  await navigator.clipboard.writeText(text);
}

export class CommsPlanPanel extends Panel {
  private activePlaceId: string | null = null;
  private feedback: string | null = null;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeSavedPlaces: (() => void) | null = null;
  private unsubscribeCommsPlans: (() => void) | null = null;

  constructor() {
    super({
      id: 'comms-plan',
      title: 'Tactical Comms',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Place-aware check-in templates, fallback ladder, and degraded-network comms guidance for saved places.',
    });

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const exportButton = target?.closest<HTMLElement>('[data-comms-export]');
      const exportFormat = exportButton?.dataset.commsExport;
      if (exportFormat === 'csv' || exportFormat === 'json') {
        this.exportFieldCard(exportFormat);
        return;
      }

      const statusButton = target?.closest<HTMLElement>('[data-comms-status]');
      const status = statusButton?.dataset.commsStatus as CommsStatus | undefined;
      if (status) {
        void this.copyStatus(status);
      }
    });

    this.unsubscribeSavedPlaces = subscribeSavedPlaces(() => this.refresh());
    this.unsubscribeCommsPlans = subscribeCommsPlans(() => this.refresh());
    this.refresh();
  }

  override destroy(): void {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.unsubscribeSavedPlaces?.();
    this.unsubscribeCommsPlans?.();
    this.unsubscribeSavedPlaces = null;
    this.unsubscribeCommsPlans = null;
    super.destroy();
  }

  public setPlaceId(placeId: string | null): void {
    this.activePlaceId = placeId;
    this.refresh();
  }

  public refresh(): void {
    const place = this.resolvePlace();
    if (!place) {
      this.setCount(0);
      this.setContent('<div class="panel-empty">Save a place to build a comms plan and copy place-aware check-ins.</div>');
      return;
    }

    const plan = getResolvedCommsPlan(place, getCommsPlan(place.id));
    const references = getCommsDirectoryLinks(place, plan);
    this.setCount(plan.fallbackSteps.length);

    const templatesHtml = COMMS_STATUS_ORDER.map((status) => `
      <button
        class="sa-filter"
        data-comms-status="${escapeHtml(status)}"
        type="button"
      >${escapeHtml(COMMS_STATUS_LABELS[status])}</button>
    `).join('');

    const exportHtml = `
      <div class="sa-filters" style="margin-top:10px;">
        <button class="sa-filter" data-comms-export="json" type="button">Export JSON</button>
        <button class="sa-filter" data-comms-export="csv" type="button">Export CSV</button>
      </div>
    `;

    const fallbackHtml = plan.fallbackSteps.map((step) => `
      <div class="watchlist-card">
        <div class="watchlist-card-top">
          <div>
            <div class="watchlist-country">${escapeHtml(step.label)}</div>
            <div class="watchlist-scenario">${escapeHtml(step.kind.toUpperCase())}</div>
          </div>
        </div>
        <div class="watchlist-summary">${escapeHtml(step.instruction)}</div>
      </div>
    `).join('');

    const windowsHtml = plan.checkInWindows.map((window) => `
      <span class="watchlist-panel-chip">${escapeHtml(window.label)}</span>
    `).join('');

    const referencesHtml = references.map((reference) => `
      <a class="watchlist-card" href="${sanitizeUrl(reference.url)}" target="_blank" rel="noopener">
        <div class="watchlist-card-top">
          <div>
            <div class="watchlist-country">${escapeHtml(reference.label)}</div>
            <div class="watchlist-scenario">${escapeHtml(reference.provider)} • ${escapeHtml(reference.kind.toUpperCase())}</div>
          </div>
        </div>
        <div class="watchlist-summary">${escapeHtml(reference.note)}</div>
      </a>
    `).join('');

    this.setContent(`
      <div class="sa-panel-content">
        <div class="watchlist-card-top" style="margin-bottom:10px;">
          <div>
            <div class="watchlist-country">${escapeHtml(place.name)}</div>
            <div class="watchlist-scenario">Updated ${escapeHtml(formatUpdatedAt(plan.updatedAt))}</div>
          </div>
        </div>
        ${this.feedback ? `<div class="panel-empty" style="margin-bottom:10px;">${escapeHtml(this.feedback)}</div>` : ''}
        <div class="sa-filters">${templatesHtml}</div>
        ${exportHtml}
        <div class="watchlist-summary" style="margin:10px 0;">One-tap check-ins use this place and the fallback ladder below.</div>
        <div class="watchlist-panels" style="margin-bottom:10px;">${windowsHtml}</div>
        <div class="watchlist-list">${fallbackHtml}</div>
        <div class="watchlist-summary" style="margin:12px 0 10px;">References</div>
        <div class="watchlist-list">${referencesHtml}</div>
        ${plan.notes ? `<div class="watchlist-scenario" style="margin-top:10px;">${escapeHtml(plan.notes)}</div>` : ''}
      </div>
    `);
  }

  private resolvePlace() {
    if (this.activePlaceId) {
      const active = getSavedPlace(this.activePlaceId);
      if (active) return active;
    }
    return getPrimarySavedPlace() ?? getSavedPlaces()[0] ?? null;
  }

  private async copyStatus(status: CommsStatus): Promise<void> {
    const place = this.resolvePlace();
    if (!place) return;
    try {
      const message = buildCommsMessage({
        status,
        place,
        plan: getCommsPlan(place.id),
      });
      await copyText(message);
      this.feedback = `${COMMS_STATUS_LABELS[status]} update copied`;
    } catch {
      this.feedback = 'Clipboard unavailable';
    }
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => {
      this.feedback = null;
      this.refresh();
    }, 2000);
    this.refresh();
  }

  private exportFieldCard(format: 'csv' | 'json'): void {
    const place = this.resolvePlace();
    if (!place) return;
    const plan = getResolvedCommsPlan(place, getCommsPlan(place.id));
    const card = buildCommsFieldCard({
      place,
      plan,
      references: getCommsDirectoryLinks(place, plan),
    });
    if (format === 'json') exportCommsPlanJSON(card);
    else exportCommsPlanCSV(card);
    this.feedback = `Field card ${format.toUpperCase()} exported`;
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => {
      this.feedback = null;
      this.refresh();
    }, 2000);
    this.refresh();
  }
}
