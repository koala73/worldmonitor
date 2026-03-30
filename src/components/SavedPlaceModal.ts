import { escapeHtml } from '@/utils/sanitize';
import { forwardGeocode, reverseGeocodeLabel, type GeocodeResult } from '@/utils/geocode';
import {
  addSavedPlace,
  updateSavedPlace,
  removeSavedPlace,
  setPrimarySavedPlace,
  type SavedPlace,
  type SavedPlaceTag,
} from '@/services/saved-places';

const ALL_TAGS: { value: SavedPlaceTag; label: string }[] = [
  { value: 'home', label: 'Home' },
  { value: 'work', label: 'Work' },
  { value: 'family', label: 'Family' },
  { value: 'school', label: 'School' },
  { value: 'medical', label: 'Medical' },
  { value: 'shelter', label: 'Shelter' },
  { value: 'supply', label: 'Supply' },
  { value: 'bugout', label: 'Bug-out' },
  { value: 'travel', label: 'Travel' },
  { value: 'concern', label: 'Concern' },
  { value: 'critical', label: 'Critical' },
];

const RADIUS_PRESETS = [
  { label: 'City (50 km)', km: 50 },
  { label: 'Region (250 km)', km: 250 },
  { label: 'Country (1000 km)', km: 1000 },
  { label: 'Continent (3000 km)', km: 3000 },
];

export interface SavedPlaceModalOptions {
  onPickLocationMode: (active: boolean, callback: ((lat: number, lon: number) => void) | null) => void;
}

interface FormState {
  name: string;
  lat: string;
  lon: string;
  tags: Set<SavedPlaceTag>;
  radiusKm: number;
  notes: string;
  primary: boolean;
}

export class SavedPlaceModal {
  private overlay: HTMLElement;
  private options: SavedPlaceModalOptions;
  private editingPlace: SavedPlace | null = null;
  private escapeHandler: (e: KeyboardEvent) => void;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private geocodeResults: GeocodeResult[] = [];
  private formState: FormState = this.defaultFormState();
  private pickModeActive = false;
  private confirmingDelete = false;

  constructor(options: SavedPlaceModalOptions) {
    this.options = options;

    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    this.overlay.id = 'savedPlaceModal';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-label', 'Save Place');

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.pickModeActive) {
          this.exitPickMode();
        } else {
          this.close();
        }
      }
    };

    this.overlay.addEventListener('click', (e) => this.handleClick(e));
    this.overlay.addEventListener('input', (e) => this.handleInput(e));
    this.overlay.addEventListener('change', (e) => this.handleChange(e));

    document.body.append(this.overlay);
  }

  private defaultFormState(): FormState {
    return {
      name: '',
      lat: '',
      lon: '',
      tags: new Set(),
      radiusKm: 50,
      notes: '',
      primary: false,
    };
  }

  public openCreate(): void {
    this.editingPlace = null;
    this.formState = this.defaultFormState();
    this.geocodeResults = [];
    this.confirmingDelete = false;
    this.render();
    this.overlay.classList.add('active');
    document.addEventListener('keydown', this.escapeHandler);
    this.focusNameField();
  }

  public openEdit(place: SavedPlace): void {
    this.editingPlace = place;
    this.formState = {
      name: place.name,
      lat: String(place.lat),
      lon: String(place.lon),
      tags: new Set(place.tags),
      radiusKm: place.radiusKm,
      notes: place.notes,
      primary: place.primary,
    };
    this.geocodeResults = [];
    this.confirmingDelete = false;
    this.render();
    this.overlay.classList.add('active');
    document.addEventListener('keydown', this.escapeHandler);
  }

  public close(): void {
    if (this.pickModeActive) this.exitPickMode();
    this.overlay.classList.remove('active');
    document.removeEventListener('keydown', this.escapeHandler);
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
  }

  private focusNameField(): void {
    requestAnimationFrame(() => {
      const nameInput = this.overlay.querySelector<HTMLInputElement>('[data-field="name"]');
      nameInput?.focus();
    });
  }

  private render(): void {
    if (this.pickModeActive) {
      // eslint-disable-next-line no-unsanitized/property
      this.overlay.innerHTML = this.renderPickModeBanner();
      return;
    }

    const isEdit = Boolean(this.editingPlace);
    // All user-controlled values are passed through escapeHtml() before insertion.
    // Static strings (labels, data-action attributes) are hardcoded literals.
    // eslint-disable-next-line no-unsanitized/property
    this.overlay.innerHTML = `
      <div class="modal spm-modal">
        <div class="modal-header">
          <span class="modal-title">${isEdit ? 'Edit Place' : 'Add Place'}</span>
          <button class="modal-close" data-action="close" type="button">&#xD7;</button>
        </div>

        <div class="spm-body">
          <div class="spm-field-group">
            <label class="spm-label" for="spm-name">Name</label>
            <input
              id="spm-name"
              class="spm-input"
              type="text"
              placeholder="Home, Work, Parents..."
              value="${escapeHtml(this.formState.name)}"
              data-field="name"
              autocomplete="off"
              maxlength="80"
            />
          </div>

          <div class="spm-field-group">
            <label class="spm-label">Location</label>
            <div class="spm-search-row">
              <input
                class="spm-input spm-search-input"
                type="text"
                placeholder="Search address..."
                data-field="search"
                autocomplete="off"
              />
            </div>
            ${this.renderGeocodeResults()}
            <div class="spm-latlon-row">
              <div class="spm-latlon-field">
                <label class="spm-sublabel">Lat</label>
                <input
                  class="spm-input spm-coord-input"
                  type="text"
                  inputmode="decimal"
                  placeholder="37.7749"
                  value="${escapeHtml(this.formState.lat)}"
                  data-field="lat"
                />
              </div>
              <div class="spm-latlon-field">
                <label class="spm-sublabel">Lon</label>
                <input
                  class="spm-input spm-coord-input"
                  type="text"
                  inputmode="decimal"
                  placeholder="-122.4194"
                  value="${escapeHtml(this.formState.lon)}"
                  data-field="lon"
                />
              </div>
              <button class="spm-pin-btn" data-action="pick-map" type="button" title="Click map to set location">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                Pin
              </button>
            </div>
          </div>

          <div class="spm-field-group">
            <label class="spm-label">Tags</label>
            <div class="spm-tags">
              ${ALL_TAGS.map((tag) => `
                <button
                  class="spm-tag${this.formState.tags.has(tag.value) ? ' spm-tag--active' : ''}"
                  data-action="toggle-tag"
                  data-tag="${tag.value}"
                  type="button"
                >${escapeHtml(tag.label)}</button>
              `).join('')}
            </div>
          </div>

          <div class="spm-field-group spm-field-row">
            <div class="spm-field-half">
              <label class="spm-label" for="spm-radius">Alert Radius</label>
              <select id="spm-radius" class="spm-input spm-select" data-field="radius">
                ${RADIUS_PRESETS.map((p) => `
                  <option value="${p.km}"${p.km === this.formState.radiusKm ? ' selected' : ''}>${escapeHtml(p.label)}</option>
                `).join('')}
              </select>
            </div>
            <div class="spm-field-half spm-primary-toggle">
              <label class="spm-label">Primary</label>
              <button
                class="spm-primary-btn${this.formState.primary ? ' spm-primary-btn--active' : ''}"
                data-action="toggle-primary"
                type="button"
                title="Set as primary location for Local Logistics and Comms Plan"
              >
                ${this.formState.primary ? '&#x2605; Primary' : '&#x2606; Set Primary'}
              </button>
            </div>
          </div>

          <div class="spm-field-group">
            <label class="spm-label" for="spm-notes">Notes</label>
            <textarea
              id="spm-notes"
              class="spm-input spm-textarea"
              placeholder="Optional notes..."
              data-field="notes"
              maxlength="500"
              rows="2"
            >${escapeHtml(this.formState.notes)}</textarea>
          </div>

          ${this.renderValidationError()}
        </div>

        <div class="spm-footer">
          ${isEdit ? this.renderDeleteButton() : ''}
          <div class="spm-footer-actions">
            <button class="spm-btn spm-btn--ghost" data-action="close" type="button">Cancel</button>
            <button class="spm-btn spm-btn--primary" data-action="save" type="button">
              ${isEdit ? 'Save Changes' : 'Add Place'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderGeocodeResults(): string {
    if (this.geocodeResults.length === 0) return '';
    return `
      <div class="spm-geocode-results">
        ${this.geocodeResults.map((r, i) => `
          <button class="spm-geocode-item" data-action="pick-geocode" data-index="${i}" type="button">
            ${escapeHtml(r.displayName)}
          </button>
        `).join('')}
      </div>
    `;
  }

  private renderValidationError(): string {
    const err = this.getValidationError();
    if (!err) return '';
    return `<div class="spm-error">${escapeHtml(err)}</div>`;
  }

  private renderDeleteButton(): string {
    if (this.confirmingDelete) {
      return `
        <div class="spm-delete-confirm">
          <span class="spm-delete-confirm-text">Delete this place?</span>
          <button class="spm-btn spm-btn--danger" data-action="delete-confirm" type="button">Delete</button>
          <button class="spm-btn spm-btn--ghost" data-action="delete-cancel" type="button">No</button>
        </div>
      `;
    }
    return `<button class="spm-btn spm-btn--ghost spm-btn--danger-ghost" data-action="delete" type="button">Delete</button>`;
  }

  private renderPickModeBanner(): string {
    return `
      <div class="spm-pick-banner">
        <span class="spm-pick-banner-text">Click anywhere on the map to set the location</span>
        <button class="spm-btn spm-btn--ghost" data-action="pick-cancel" type="button">Cancel</button>
      </div>
    `;
  }

  private getValidationError(): string | null {
    if (!this.formState.name.trim() && !this.formState.lat && !this.formState.lon) return null;
    const lat = parseFloat(this.formState.lat);
    const lon = parseFloat(this.formState.lon);
    if (this.formState.lat && !Number.isFinite(lat)) return 'Latitude must be a number between -90 and 90';
    if (this.formState.lon && !Number.isFinite(lon)) return 'Longitude must be a number between -180 and 180';
    if (this.formState.lat && (lat < -90 || lat > 90)) return 'Latitude must be between -90 and 90';
    if (this.formState.lon && (lon < -180 || lon > 180)) return 'Longitude must be between -180 and 180';
    return null;
  }

  private canSave(): boolean {
    const name = this.formState.name.trim();
    const lat = parseFloat(this.formState.lat);
    const lon = parseFloat(this.formState.lon);
    return (
      name.length > 0
      && Number.isFinite(lat) && lat >= -90 && lat <= 90
      && Number.isFinite(lon) && lon >= -180 && lon <= 180
      && !this.getValidationError()
    );
  }

  private handleInput(e: Event): void {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    const field = target.dataset.field;
    if (!field) return;

    if (field === 'name') {
      this.formState.name = target.value;
    } else if (field === 'lat') {
      this.formState.lat = target.value;
      this.refreshValidation();
    } else if (field === 'lon') {
      this.formState.lon = target.value;
      this.refreshValidation();
    } else if (field === 'notes') {
      this.formState.notes = target.value;
    } else if (field === 'search') {
      this.scheduleSearch(target.value);
    }
  }

  private handleChange(e: Event): void {
    const target = e.target as HTMLSelectElement;
    if (target.dataset.field === 'radius') {
      this.formState.radiusKm = parseInt(target.value, 10);
    }
  }

  private handleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    if (target === this.overlay) {
      if (!this.pickModeActive) this.close();
      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-action]');
    const action = actionEl?.dataset.action;
    if (!action) return;

    switch (action) {
      case 'close':
        this.close();
        break;
      case 'save':
        this.save();
        break;
      case 'toggle-tag': {
        const tagEl = target.closest<HTMLElement>('[data-tag]');
        const tag = tagEl?.dataset.tag as SavedPlaceTag | undefined;
        if (tag) {
          if (this.formState.tags.has(tag)) {
            this.formState.tags.delete(tag);
          } else {
            this.formState.tags.add(tag);
          }
          tagEl?.classList.toggle('spm-tag--active');
        }
        break;
      }
      case 'toggle-primary':
        this.formState.primary = !this.formState.primary;
        this.rerenderPrimaryButton();
        break;
      case 'pick-map':
        this.enterPickMode();
        break;
      case 'pick-cancel':
        this.exitPickMode();
        break;
      case 'pick-geocode': {
        const indexEl = target.closest<HTMLElement>('[data-index]');
        const index = parseInt(indexEl?.dataset.index ?? '', 10);
        const result = this.geocodeResults[index];
        if (result) this.applyGeocodeResult(result);
        break;
      }
      case 'delete':
        this.confirmingDelete = true;
        this.refreshDeleteArea();
        break;
      case 'delete-cancel':
        this.confirmingDelete = false;
        this.refreshDeleteArea();
        break;
      case 'delete-confirm':
        this.deletePlace();
        break;
    }
  }

  private refreshValidation(): void {
    const errorEl = this.overlay.querySelector('.spm-error');
    const err = this.getValidationError();
    if (err && !errorEl) {
      const body = this.overlay.querySelector('.spm-body');
      if (body) {
        const errDiv = document.createElement('div');
        errDiv.className = 'spm-error';
        errDiv.textContent = err;
        body.append(errDiv);
      }
    } else if (!err && errorEl) {
      errorEl.remove();
    } else if (err && errorEl) {
      errorEl.textContent = err;
    }
  }

  private rerenderPrimaryButton(): void {
    const btn = this.overlay.querySelector<HTMLElement>('[data-action="toggle-primary"]');
    if (!btn) return;
    btn.textContent = this.formState.primary ? '\u2605 Primary' : '\u2606 Set Primary';
    btn.classList.toggle('spm-primary-btn--active', this.formState.primary);
  }

  private refreshDeleteArea(): void {
    const footer = this.overlay.querySelector('.spm-footer');
    if (!footer) return;
    const existing = footer.querySelector('.spm-delete-confirm, [data-action="delete"]');
    existing?.remove();
    const actionsEl = footer.querySelector('.spm-footer-actions');
    if (actionsEl) {
      const tmp = document.createElement('div');
      // renderDeleteButton returns only safe static strings
      // eslint-disable-next-line no-unsanitized/property
      tmp.innerHTML = this.renderDeleteButton();
      footer.insertBefore(tmp.firstElementChild!, actionsEl);
    }
  }

  private scheduleSearch(query: string): void {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    if (!query.trim()) {
      this.geocodeResults = [];
      this.refreshGeocodeResults();
      return;
    }
    this.searchDebounce = setTimeout(() => void this.runSearch(query), 400);
  }

  private async runSearch(query: string): Promise<void> {
    const results = await forwardGeocode(query);
    this.geocodeResults = results;
    this.refreshGeocodeResults();
  }

  private refreshGeocodeResults(): void {
    const existing = this.overlay.querySelector('.spm-geocode-results');
    if (existing) existing.remove();
    if (this.geocodeResults.length === 0) return;

    const searchRow = this.overlay.querySelector('.spm-search-row');
    if (!searchRow) return;

    const tmp = document.createElement('div');
    // renderGeocodeResults escapes all user-provided displayName values via escapeHtml
    // eslint-disable-next-line no-unsanitized/property
    tmp.innerHTML = this.renderGeocodeResults();
    searchRow.after(tmp.firstElementChild!);
  }

  private applyGeocodeResult(result: GeocodeResult): void {
    this.formState.lat = result.lat.toFixed(6);
    this.formState.lon = result.lon.toFixed(6);
    this.geocodeResults = [];

    if (!this.formState.name.trim()) {
      const parts = result.displayName.split(',');
      this.formState.name = (parts[0] ?? '').trim();
    }

    const latInput = this.overlay.querySelector<HTMLInputElement>('[data-field="lat"]');
    const lonInput = this.overlay.querySelector<HTMLInputElement>('[data-field="lon"]');
    const nameInput = this.overlay.querySelector<HTMLInputElement>('[data-field="name"]');
    const searchInput = this.overlay.querySelector<HTMLInputElement>('[data-field="search"]');

    if (latInput) latInput.value = this.formState.lat;
    if (lonInput) lonInput.value = this.formState.lon;
    if (nameInput && !nameInput.value.trim()) nameInput.value = this.formState.name;
    if (searchInput) searchInput.value = '';

    this.refreshGeocodeResults();
    this.refreshValidation();
  }

  private enterPickMode(): void {
    this.pickModeActive = true;
    this.render();
    this.overlay.classList.add('spm-pick-mode');
    this.options.onPickLocationMode(true, (lat, lon) => {
      this.formState.lat = lat.toFixed(6);
      this.formState.lon = lon.toFixed(6);
      this.exitPickMode();
      void this.tryAutoName(lat, lon);
    });
  }

  private exitPickMode(): void {
    this.pickModeActive = false;
    this.overlay.classList.remove('spm-pick-mode');
    this.options.onPickLocationMode(false, null);
    this.render();
  }

  private async tryAutoName(lat: number, lon: number): Promise<void> {
    if (this.formState.name.trim()) return;
    const label = await reverseGeocodeLabel(lat, lon);
    if (!label || this.formState.name.trim()) return;
    const parts = label.split(',');
    this.formState.name = (parts[0] ?? '').trim();
    const nameInput = this.overlay.querySelector<HTMLInputElement>('[data-field="name"]');
    if (nameInput && !nameInput.value.trim()) nameInput.value = this.formState.name;
  }

  private save(): void {
    if (!this.canSave()) {
      this.refreshValidation();
      return;
    }

    const lat = parseFloat(this.formState.lat);
    const lon = parseFloat(this.formState.lon);
    const input = {
      name: this.formState.name.trim(),
      lat,
      lon,
      radiusKm: this.formState.radiusKm,
      tags: [...this.formState.tags],
      notes: this.formState.notes,
      source: 'manual' as const,
    };

    if (this.editingPlace) {
      const updated = updateSavedPlace(this.editingPlace.id, input);
      if (updated && this.formState.primary && !this.editingPlace.primary) {
        setPrimarySavedPlace(updated.id);
      }
    } else {
      const added = addSavedPlace(input);
      if (this.formState.primary) {
        setPrimarySavedPlace(added.id);
      }
    }

    this.close();
  }

  private deletePlace(): void {
    if (!this.editingPlace) return;
    removeSavedPlace(this.editingPlace.id);
    this.close();
  }
}
