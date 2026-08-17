/**
 * One-time retirement of the canadaRoads default-on (#6763).
 *
 * DEFAULT_MAP_LAYERS only applies when no saved layer blob exists. That blob
 * is written whenever the user touches any layer, so flipping the default
 * never reaches returning visitors — they keep fetching ~2.2 MB of on-demand
 * road data. The layer shipped enabled, so a stored `true` is an inherited
 * default, not a choice. Runs once; a later re-enable sticks.
 */
export const CANADA_ROADS_OPT_IN_KEY = 'worldmonitor-canada-roads-opt-in-v1';

export interface CanadaRoadsOptInStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function applyCanadaRoadsOptInMigration<T extends { canadaRoads?: boolean }>(
  mapLayers: T,
  storage: CanadaRoadsOptInStorage,
  saveMapLayers: (layers: T) => void,
): T {
  if (storage.getItem(CANADA_ROADS_OPT_IN_KEY)) return mapLayers;

  let next = mapLayers;
  if (mapLayers.canadaRoads) {
    next = { ...mapLayers, canadaRoads: false };
    saveMapLayers(next);
  }
  storage.setItem(CANADA_ROADS_OPT_IN_KEY, 'done');
  return next;
}
