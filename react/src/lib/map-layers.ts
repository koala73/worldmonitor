/**
 * Bridge React LayerMap ↔ full vanilla MapLayers for DeckGLMap / MapContainer.
 *
 * Important: never spread DEFAULT_MAP_LAYERS and only patch URL keys — that
 * leaves vanilla defaults like canadaAlerts/iranAttacks enabled and paints
 * surprise overlays on the React map.
 */
import { DEFAULT_MAP_LAYERS } from '@/config/variants/full';
import type { MapLayers } from '@/types';
import type { LayerKey, LayerMap } from './url-state';
import { LAYER_KEYS, emptyLayers } from './url-state';

/** Full MapLayers object: every key off, then only React/URL toggles on. */
export function toMapLayers(partial: LayerMap): MapLayers {
  const base = { ...DEFAULT_MAP_LAYERS } as MapLayers;
  const bag = base as unknown as Record<string, boolean | undefined>;

  // Zero every known MapLayers flag first (including keys not in LAYER_KEYS).
  for (const key of Object.keys(bag)) {
    bag[key] = false;
  }

  for (const key of LAYER_KEYS) {
    if (key in bag || key in DEFAULT_MAP_LAYERS) {
      bag[key] = !!partial[key];
    } else {
      // Optional energy-variant flags still accepted by setLayers
      bag[key] = !!partial[key];
    }
  }

  return base;
}

/** Extract URL-allowlist LayerMap from a full MapLayers snapshot. */
export function fromMapLayers(layers: MapLayers): LayerMap {
  const out = emptyLayers(false);
  const bag = layers as unknown as Record<string, boolean | undefined>;
  for (const key of LAYER_KEYS) {
    out[key] = !!bag[key];
  }
  return out;
}

export function activeLayerKeys(layers: LayerMap): LayerKey[] {
  return LAYER_KEYS.filter((k) => layers[k]);
}
