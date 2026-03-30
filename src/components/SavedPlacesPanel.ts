import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getSavedPlaces, subscribeSavedPlaces, type SavedPlace, type SavedPlaceTag } from '@/services/saved-places';
import { getSavedPlaceBrief } from '@/services/place-briefs';

interface SavedPlacesPanelOptions {
  focusPlace: (placeId: string) => void;
  editPlace?: (placeId: string) => void;
  createPlace?: () => void;
}

const TAG_LABELS: Record<SavedPlaceTag, string> = {
  home: 'Home',
  work: 'Work',
  family: 'Family',
  bugout: 'Bug-out',
  travel: 'Travel',
  medical: 'Medical',
  supply: 'Supply',
  concern: 'Concern',
  school: 'School',
  shelter: 'Shelter',
  critical: 'Critical',
};

const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

const MAX_PLACES = 20;

export class SavedPlacesPanel extends Panel {
  private options: SavedPlacesPanelOptions;
  private unsubscribeSavedPlaces: (() => void) | null = null;
  private readonly boundRefresh: () => void;
  private places: SavedPlace[] = [];

  constructor(options: SavedPlacesPanelOptions) {
    super({
      id: 'saved-places',
      title: 'Saved Places',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Personal locations prioritized for place-first monitoring, fast map focus, and later place briefs.',
    });
    this.options = options;

    if (options.createPlace) {
      const addBtn = document.createElement('button');
      addBtn.className = 'spm-header-add';
      addBtn.title = 'Add place';
      addBtn.type = 'button';
      addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
      addBtn.addEventListener('click', () => options.createPlace?.());
      this.header.append(addBtn);
    }

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const createButton = target?.closest<HTMLElement>('[data-saved-place-create]');
      if (createButton) {
        this.options.createPlace?.();
        return;
      }

      const editButton = target?.closest<HTMLElement>('[data-saved-place-edit]');
      if (editButton) {
        event.stopPropagation();
        const placeId = editButton.dataset.savedPlaceEdit;
        if (placeId) this.options.editPlace?.(placeId);
        return;
      }

      const placeCard = target?.closest<HTMLElement>('[data-saved-place-id]');
      const placeId = placeCard?.dataset.savedPlaceId;
      if (!placeId) return;
      this.options.focusPlace(placeId);
    });

    this.boundRefresh = () => this.refresh();
    document.addEventListener('wm:breaking-news', this.boundRefresh);
    document.addEventListener('wm:intelligence-updated', this.boundRefresh);
    document.addEventListener('wm:local-logistics-updated', this.boundRefresh);
    document.addEventListener('wm:saved-place-weather-updated', this.boundRefresh);
    document.addEventListener('wm:storm-data-updated', this.boundRefresh);
    this.unsubscribeSavedPlaces = subscribeSavedPlaces(() => this.refresh());
    this.refresh();
  }

  override destroy(): void {
    document.removeEventListener('wm:breaking-news', this.boundRefresh);
    document.removeEventListener('wm:intelligence-updated', this.boundRefresh);
    document.removeEventListener('wm:local-logistics-updated', this.boundRefresh);
    document.removeEventListener('wm:saved-place-weather-updated', this.boundRefresh);
    document.removeEventListener('wm:storm-data-updated', this.boundRefresh);
    this.unsubscribeSavedPlaces?.();
    this.unsubscribeSavedPlaces = null;
    super.destroy();
  }

  public refresh(): void {
    this.places = getSavedPlaces();
    this.setCount(this.places.length);

    if (this.places.length === 0) {
      this.content.innerHTML = `
        <div class="watchlist-empty">
          <div class="watchlist-empty-title">No saved places yet</div>
          <div class="watchlist-empty-copy">Add home, work, family, or bug-out locations so the app can prioritize what matters near you.</div>
          ${this.options.createPlace ? '<button class="watchlist-card" data-saved-place-create="1" type="button">Add your first place</button>' : ''}
        </div>
      `;
      return;
    }

    this.content.innerHTML = `
      <div class="watchlist-list">
        ${this.places.slice(0, MAX_PLACES).map((place) => this.renderCard(place)).join('')}
        ${this.places.length < MAX_PLACES && this.options.createPlace ? `
          <button class="spm-add-inline" data-saved-place-create="1" type="button">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add place
          </button>
        ` : ''}
      </div>
    `;
  }

  private renderCard(place: SavedPlace): string {
    const brief = getSavedPlaceBrief(place.id);
    const hasStormPosture = brief?.items.some((item) => item.kind === 'preparedness');
    const hasForecastRisk = brief?.items.some((item) => item.kind === 'forecast');
    const badges = [
      place.primary ? '<span class="watchlist-panel-chip">Primary</span>' : '',
      place.offlinePinned ? '<span class="watchlist-panel-chip">Offline</span>' : '',
      brief?.isStale ? '<span class="watchlist-panel-chip">Cached</span>' : '',
      hasStormPosture ? '<span class="watchlist-panel-chip">Storm</span>' : '',
      hasForecastRisk ? '<span class="watchlist-panel-chip">Forecast</span>' : '',
      ...place.tags.map((tag) => `<span class="watchlist-panel-chip">${escapeHtml(TAG_LABELS[tag] ?? tag)}</span>`),
    ].filter(Boolean).join('');

    const editBtn = this.options.editPlace
      ? `<button class="spm-card-edit" data-saved-place-edit="${escapeHtml(place.id)}" type="button" title="Edit place">${PENCIL_SVG}</button>`
      : '';

    return `
      <div class="spm-card-wrapper">
        <button class="watchlist-card" data-saved-place-id="${escapeHtml(place.id)}" type="button">
          <div class="watchlist-card-top">
            <div>
              <div class="watchlist-country">${escapeHtml(place.name)}</div>
              <div class="watchlist-scenario">${place.radiusKm.toLocaleString()} km radius</div>
            </div>
          </div>
          <div class="watchlist-summary">${escapeHtml(brief?.headline ?? this.renderSubtitle(place))}</div>
          <div class="watchlist-card-bottom">
            <div class="watchlist-panels">${badges}</div>
          </div>
        </button>
        ${editBtn}
      </div>
    `;
  }

  private renderSubtitle(place: SavedPlace): string {
    return `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}`;
  }
}
