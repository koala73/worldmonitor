import { DEFAULT_MAP_MODE, STORAGE_KEYS, type MapModePreference } from '@/config/variants/base';

export function normalizeMapModePreference(value: string | null | undefined): MapModePreference {
  if (value === 'flat' || value === 'globe') return value;
  return DEFAULT_MAP_MODE;
}

function loadMapModeFromStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) as T : fallback;
  } catch (error) {
    console.warn(`Failed to load ${key} from storage:`, error);
    return fallback;
  }
}

export function getStoredMapModePreference(
  load: <T>(key: string, fallback: T) => T = loadMapModeFromStorage,
): MapModePreference {
  return normalizeMapModePreference(load<string>(STORAGE_KEYS.mapMode, DEFAULT_MAP_MODE));
}
