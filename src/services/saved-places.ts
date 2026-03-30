import { loadProximityConfig } from './proximity-filter';

export type SavedPlaceSource = 'manual' | 'gps' | 'search' | 'migrated-proximity';
export type SavedPlaceTag = 'home' | 'work' | 'family' | 'bugout' | 'travel' | 'medical' | 'supply' | 'concern' | 'school' | 'shelter' | 'critical';

export interface SavedPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
  tags: SavedPlaceTag[];
  priority: number;
  notes: string;
  offlinePinned: boolean;
  primary: boolean;
  source: SavedPlaceSource;
  sortIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface SavedPlaceInput {
  name: string;
  lat: number;
  lon: number;
  radiusKm?: number;
  tags?: SavedPlaceTag[];
  priority?: number;
  notes?: string;
  offlinePinned?: boolean;
  source?: SavedPlaceSource;
}

export interface SavedPlacesStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

const STORAGE_KEY = 'wm_saved_places_v1';
const CHANGE_EVENT = 'wm:saved-places-changed';
const DEFAULT_RADIUS_KM = 50;
const MIN_RADIUS_KM = 1;
const MAX_RADIUS_KM = 3000;
const VALID_TAGS = new Set<SavedPlaceTag>(['home', 'work', 'family', 'bugout', 'travel', 'medical', 'supply', 'concern', 'school', 'shelter', 'critical']);
let fallbackPlaceCounter = 0;

function defaultStorage(): SavedPlacesStorageLike | null {
  try {
    if (
      typeof localStorage !== 'undefined'
      && typeof localStorage.getItem === 'function'
      && typeof localStorage.setItem === 'function'
    ) {
      return localStorage;
    }
  } catch {}
  return null;
}

function createPlaceId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  fallbackPlaceCounter += 1;
  return `place_${Date.now()}_${fallbackPlaceCounter}`;
}

function clonePlace(place: SavedPlace): SavedPlace {
  return {
    ...place,
    tags: [...place.tags],
  };
}

function clonePlaces(places: SavedPlace[]): SavedPlace[] {
  return places.map((place) => clonePlace(place));
}

function clampRadius(radiusKm: number | undefined): number {
  if (!Number.isFinite(radiusKm)) return DEFAULT_RADIUS_KM;
  return Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, Math.round(radiusKm as number)));
}

function normalizePriority(priority: number | undefined): number {
  if (!Number.isFinite(priority)) return 0;
  return Math.trunc(priority as number);
}

function normalizeTags(tags: SavedPlaceTag[] | undefined): SavedPlaceTag[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<SavedPlaceTag>();
  for (const tag of tags) {
    if (VALID_TAGS.has(tag) && !seen.has(tag)) seen.add(tag);
  }
  return [...seen];
}

function validateLatitude(lat: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('latitude must be between -90 and 90');
  }
}

function validateLongitude(lon: number): void {
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error('longitude must be between -180 and 180');
  }
}

function normalizeName(name: string): string {
  return name.trim();
}

function nextTimestamp(places: SavedPlace[]): number {
  const now = Date.now();
  const latest = places.reduce((max, place) => Math.max(max, place.updatedAt, place.createdAt), 0);
  return now > latest ? now : latest + 1;
}

function comparePlaces(a: SavedPlace, b: SavedPlace): number {
  const primaryDiff = Number(b.primary) - Number(a.primary);
  if (primaryDiff !== 0) return primaryDiff;

  const priorityDiff = b.priority - a.priority;
  if (priorityDiff !== 0) return priorityDiff;

  const hasSortIndex = a.sortIndex > 0 || b.sortIndex > 0;
  if (hasSortIndex && a.sortIndex !== b.sortIndex) {
    return a.sortIndex - b.sortIndex;
  }

  const updatedDiff = b.updatedAt - a.updatedAt;
  if (updatedDiff !== 0) return updatedDiff;

  return a.name.localeCompare(b.name);
}

function sortPlaces(places: SavedPlace[]): SavedPlace[] {
  return [...places].sort(comparePlaces);
}

function bestPrimaryId(places: SavedPlace[]): string | null {
  if (places.length === 0) return null;
  const explicitPrimary = places.find((place) => place.primary);
  if (explicitPrimary) return explicitPrimary.id;
  return sortPlaces(places)[0]?.id ?? null;
}

function enforcePrimaryInvariant(places: SavedPlace[]): SavedPlace[] {
  const primaryId = bestPrimaryId(places);
  if (!primaryId) return [];
  return places.map((place) => ({
    ...place,
    primary: place.id === primaryId,
  }));
}

function normalizeStoredPlace(raw: unknown): SavedPlace | null {
  if (!raw || typeof raw !== 'object') return null;
  const place = raw as Partial<SavedPlace>;
  if (typeof place.id !== 'string' || typeof place.name !== 'string') return null;
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return null;

  try {
    validateLatitude(place.lat as number);
    validateLongitude(place.lon as number);
  } catch {
    return null;
  }

  return {
    id: place.id,
    name: normalizeName(place.name),
    lat: place.lat as number,
    lon: place.lon as number,
    radiusKm: clampRadius(place.radiusKm),
    tags: normalizeTags(place.tags),
    priority: normalizePriority(place.priority),
    notes: typeof place.notes === 'string' ? place.notes : '',
    offlinePinned: Boolean(place.offlinePinned),
    primary: Boolean(place.primary),
    source: place.source === 'gps' || place.source === 'search' || place.source === 'migrated-proximity' ? place.source : 'manual',
    sortIndex: Number.isFinite(place.sortIndex) ? Math.max(0, Math.trunc(place.sortIndex as number)) : 0,
    createdAt: Number.isFinite(place.createdAt) ? place.createdAt as number : Date.now(),
    updatedAt: Number.isFinite(place.updatedAt) ? place.updatedAt as number : Date.now(),
  };
}

function safeParsePlaces(raw: string | null): SavedPlace[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return enforcePrimaryInvariant(
      parsed
        .map((place) => normalizeStoredPlace(place))
        .filter((place): place is SavedPlace => Boolean(place)),
    );
  } catch {
    return [];
  }
}

function persistPlaces(storage: SavedPlacesStorageLike | null, places: SavedPlace[]): void {
  if (!storage) return;
  if (places.length === 0) {
    storage.removeItem?.(STORAGE_KEY);
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(places));
}

function emitSavedPlacesChanged(places: SavedPlace[]): void {
  if (typeof document === 'undefined' || typeof CustomEvent === 'undefined') return;
  document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: clonePlaces(sortPlaces(places)) }));
}

function createMigratedPlace(): SavedPlace | null {
  const proximity = loadProximityConfig();
  if (!proximity.location) return null;

  const now = Date.now();
  return {
    id: createPlaceId(),
    name: proximity.location.label.trim(),
    lat: proximity.location.lat,
    lon: proximity.location.lon,
    radiusKm: clampRadius(proximity.radiusKm),
    tags: ['home'],
    priority: 0,
    notes: '',
    offlinePinned: false,
    primary: true,
    source: 'migrated-proximity',
    sortIndex: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function migrateSavedPlacesFromLegacyProximity(
  storage: SavedPlacesStorageLike | null = defaultStorage(),
): SavedPlace[] {
  const existing = safeParsePlaces(storage?.getItem(STORAGE_KEY) ?? null);
  if (existing.length > 0) return clonePlaces(sortPlaces(existing));

  const migrated = createMigratedPlace();
  if (!migrated) return [];

  const places = [migrated];
  persistPlaces(storage, places);
  return clonePlaces(places);
}

export function createSavedPlacesStore(storage: SavedPlacesStorageLike | null = defaultStorage()) {
  let cache = safeParsePlaces(storage?.getItem(STORAGE_KEY) ?? null);
  const listeners = new Set<(places: SavedPlace[]) => void>();

  if (cache.length === 0) {
    cache = migrateSavedPlacesFromLegacyProximity(storage);
  }

  const notify = () => {
    const snapshot = clonePlaces(sortPlaces(cache));
    listeners.forEach((listener) => listener(snapshot));
    emitSavedPlacesChanged(snapshot);
  };

  const persist = () => {
    cache = enforcePrimaryInvariant(cache);
    persistPlaces(storage, cache);
  };

  return {
    getPlaces(): SavedPlace[] {
      return clonePlaces(sortPlaces(cache));
    },
    getPrimaryPlace(): SavedPlace | null {
      return clonePlaces(sortPlaces(cache)).find((place) => place.primary) ?? null;
    },
    getPlace(id: string): SavedPlace | null {
      const found = cache.find((place) => place.id === id);
      return found ? clonePlace(found) : null;
    },
    addPlace(input: SavedPlaceInput): SavedPlace {
      const name = normalizeName(input.name);
      validateLatitude(input.lat);
      validateLongitude(input.lon);
      const now = nextTimestamp(cache);
      const place: SavedPlace = {
        id: createPlaceId(),
        name,
        lat: input.lat,
        lon: input.lon,
        radiusKm: clampRadius(input.radiusKm),
        tags: normalizeTags(input.tags),
        priority: normalizePriority(input.priority),
        notes: typeof input.notes === 'string' ? input.notes : '',
        offlinePinned: Boolean(input.offlinePinned),
        primary: cache.length === 0,
        source: input.source ?? 'manual',
        sortIndex: 0,
        createdAt: now,
        updatedAt: now,
      };
      cache = [...cache, place];
      persist();
      notify();
      return clonePlace(cache.find((entry) => entry.id === place.id) ?? place);
    },
    updatePlace(id: string, patch: Partial<SavedPlaceInput>): SavedPlace | null {
      const existing = cache.find((place) => place.id === id);
      if (!existing) return null;

      const nextLat = patch.lat ?? existing.lat;
      const nextLon = patch.lon ?? existing.lon;
      const nextUpdatedAt = nextTimestamp(cache);
      validateLatitude(nextLat);
      validateLongitude(nextLon);

      cache = cache.map((place) => {
        if (place.id !== id) return place;
        return {
          ...place,
          name: typeof patch.name === 'string' ? normalizeName(patch.name) : place.name,
          lat: nextLat,
          lon: nextLon,
          radiusKm: patch.radiusKm == undefined ? place.radiusKm : clampRadius(patch.radiusKm),
          tags: patch.tags == undefined ? place.tags : normalizeTags(patch.tags),
          priority: patch.priority == undefined ? place.priority : normalizePriority(patch.priority),
          notes: typeof patch.notes === 'string' ? patch.notes : place.notes,
          offlinePinned: patch.offlinePinned == undefined ? place.offlinePinned : Boolean(patch.offlinePinned),
          source: patch.source ?? place.source,
          updatedAt: nextUpdatedAt,
        };
      });

      persist();
      notify();
      return clonePlace(cache.find((place) => place.id === id) ?? existing);
    },
    removePlace(id: string): SavedPlace[] {
      cache = cache.filter((place) => place.id !== id);
      cache = enforcePrimaryInvariant(cache);
      persistPlaces(storage, cache);
      notify();
      return clonePlaces(sortPlaces(cache));
    },
    setPrimaryPlace(id: string): SavedPlace | null {
      if (!cache.some((place) => place.id === id)) return null;
      const nextUpdatedAt = nextTimestamp(cache);
      cache = cache.map((place) => ({
        ...place,
        primary: place.id === id,
        updatedAt: place.id === id ? nextUpdatedAt : place.updatedAt,
      }));
      persist();
      notify();
      const nextPrimary = cache.find((place) => place.id === id) ?? null;
      return nextPrimary ? clonePlace(nextPrimary) : null;
    },
    reorderPlaces(ids: string[]): SavedPlace[] {
      const knownIds = new Set(cache.map((place) => place.id));
      const order = ids.filter((id) => knownIds.has(id));
      let fallbackIndex = order.length + 1;
      const sortIndexById = new Map(order.map((id, index) => [id, index + 1]));
      cache = cache.map((place) => ({
        ...place,
        sortIndex: sortIndexById.get(place.id) ?? fallbackIndex++,
        updatedAt: place.updatedAt,
      }));
      persist();
      notify();
      return clonePlaces(sortPlaces(cache));
    },
    subscribe(listener: (places: SavedPlace[]) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const singletonStore = createSavedPlacesStore();

export function getSavedPlaces(): SavedPlace[] {
  return singletonStore.getPlaces();
}

export function getPrimarySavedPlace(): SavedPlace | null {
  return singletonStore.getPrimaryPlace();
}

export function getSavedPlace(id: string): SavedPlace | null {
  return singletonStore.getPlace(id);
}

export function addSavedPlace(input: SavedPlaceInput): SavedPlace {
  return singletonStore.addPlace(input);
}

export function updateSavedPlace(id: string, patch: Partial<SavedPlaceInput>): SavedPlace | null {
  return singletonStore.updatePlace(id, patch);
}

export function removeSavedPlace(id: string): SavedPlace[] {
  return singletonStore.removePlace(id);
}

export function setPrimarySavedPlace(id: string): SavedPlace | null {
  return singletonStore.setPrimaryPlace(id);
}

export function reorderSavedPlaces(ids: string[]): SavedPlace[] {
  return singletonStore.reorderPlaces(ids);
}

export function subscribeSavedPlaces(listener: (places: SavedPlace[]) => void): () => void {
  return singletonStore.subscribe(listener);
}
