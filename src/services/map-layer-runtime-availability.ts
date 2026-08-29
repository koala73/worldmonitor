/**
 * Runtime gates that object membership on `mapLayers` cannot see.
 * Mirrors App.ts: cyber is a build flag; AIS and outages hide their
 * toggles when the backing service is unconfigured.
 */
export interface MapLayerRuntimeAvailability {
  cyberLayerEnabled: boolean;
  aisConfigured: boolean;
  /** `null` means not yet probed; only `false` hides the outages toggle. */
  outagesConfigured: boolean | null;
}

export type MapLayerRuntimeUnavailableReason =
  | 'layer_not_live'
  | 'layer_feature_disabled'
  | 'layer_not_configured';

/** Test/default snapshot: every runtime-gated layer is treated as live. */
export const ALL_MAP_LAYERS_RUNTIME_AVAILABLE: MapLayerRuntimeAvailability = {
  cyberLayerEnabled: true,
  aisConfigured: true,
  outagesConfigured: true,
};

/**
 * Effective liveness for catalog rows and `set_map_layers`. Feature-disabled
 * and unconfigured layers stay in the catalog but are not selectable.
 */
export function resolveMapLayerRuntimeUnavailableReason(
  layerKey: string,
  presentInMapLayers: boolean,
  availability: MapLayerRuntimeAvailability,
): MapLayerRuntimeUnavailableReason | undefined {
  if (layerKey === 'cyberThreats' && !availability.cyberLayerEnabled) {
    return 'layer_feature_disabled';
  }
  if (layerKey === 'ais' && !availability.aisConfigured) {
    return 'layer_not_configured';
  }
  if (layerKey === 'outages' && availability.outagesConfigured === false) {
    return 'layer_not_configured';
  }
  if (!presentInMapLayers) return 'layer_not_live';
  return undefined;
}
