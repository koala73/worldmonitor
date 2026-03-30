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
};

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

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const createButton = target?.closest<HTMLElement>('[data-saved-place-create]');
      if (createButton) {
        this.options.createPlace?.();
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
        ${this.places.slice(0, 10).map((place) => this.renderCard(place)).join('')}
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
      ...place.tags.map((tag) => `<span class="watchlist-panel-chip">${escapeHtml(TAG_LABELS[tag])}</span>`),
    ].filter(Boolean).join('');

    return `
      <button class="watchlist-card" data-saved-place-id="${escapeHtml(place.id)}" type="button">
        <div class="watchlist-card-top">
          <div>
            <div class="watchlist-country">${escapeHtml(place.name)}</div>
            <div class="watchlist-scenario">${place.radiusKm.toLocaleString()} km radius • Priority ${place.priority}</div>
          </div>
        </div>
        <div class="watchlist-summary">${escapeHtml(brief?.headline ?? this.renderSubtitle(place))}</div>
        <div class="watchlist-card-bottom">
          <div class="watchlist-panels">${badges}</div>
        </div>
      </button>
    `;
  }

  private renderSubtitle(place: SavedPlace): string {
    return `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}`;
  }
}
