import type { AppContext } from './app-context';
import { STORAGE_KEYS, type MapModePreference } from '@/config/variants/base';
import { isQuotaError, markStorageQuotaExceeded } from '@/utils/storage-quota';
import type { DashboardMapMode } from '../../shared/agent-bus-contract';

export interface MapDimensionLayerAdjustment {
  layer: 'resilienceScore';
  from: true;
  to: false;
  reason: 'layer_not_executable';
}

export interface MapDimensionApplyResult {
  requested: DashboardMapMode;
  effective: DashboardMapMode;
  renderer: 'globe' | 'deck' | 'svg';
  alreadyActive: boolean;
  adjustedLayers: MapDimensionLayerAdjustment[];
  fellBack: boolean;
  persisted: boolean;
}

export interface MapDimensionApplyOptions {
  requirePersistence?: boolean;
}

export function dashboardMapModeToPreference(mode: DashboardMapMode): MapModePreference {
  return mode === '3d' ? 'globe' : 'flat';
}

export function preferenceToDashboardMapMode(preference: MapModePreference): DashboardMapMode {
  return preference === 'globe' ? '3d' : '2d';
}

export function currentDashboardMapMode(ctx: AppContext): DashboardMapMode {
  return ctx.map?.isGlobeMode() ? '3d' : '2d';
}

export function currentMapRenderer(ctx: AppContext): 'globe' | 'deck' | 'svg' {
  if (ctx.map?.isGlobeMode?.()) return 'globe';
  return ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg';
}

function syncMapDimensionToggle(preference: MapModePreference): void {
  if (typeof document === 'undefined') return;
  const toggle = document.getElementById('mapDimensionToggle');
  if (!toggle) return;
  toggle.querySelectorAll<HTMLButtonElement>('.map-dim-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === preference);
  });
}

function persistJson(key: string, value: unknown): boolean {
  // Keep this off the `@/utils` barrel. That module loads `proxy.ts`, which
  // reads Vite's `import.meta.env.DEV` at import time and cannot run under tsx.
  // Import quota helpers from `storage-quota` directly so a full origin still
  // stops later persistent-cache writes, matching `saveToStorage()`.
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    if (isQuotaError(error)) {
      markStorageQuotaExceeded();
      return false;
    }
    console.warn(`Failed to save ${key} to storage:`, error);
    return false;
  }
}

function disableIncompatibleResilienceLayer(ctx: AppContext): {
  adjustments: MapDimensionLayerAdjustment[];
  persisted: boolean;
} {
  if (!ctx.mapLayers.resilienceScore || ctx.map?.isDeckGLActive?.()) {
    return { adjustments: [], persisted: true };
  }
  ctx.mapLayers = { ...ctx.mapLayers, resilienceScore: false };
  ctx.map?.setLayers?.(ctx.mapLayers);
  return {
    adjustments: [{
      layer: 'resilienceScore',
      from: true,
      to: false,
      reason: 'layer_not_executable',
    }],
    persisted: persistJson(STORAGE_KEYS.mapLayers, ctx.mapLayers),
  };
}

/**
 * The visible 2D/3D dashboard control. WebMCP must call this same path so
 * renderer switches, local persistence, and resilience-layer compatibility
 * stay identical to a button click.
 */
export async function applyVisibleMapDimension(
  ctx: AppContext,
  requested: DashboardMapMode,
  options: MapDimensionApplyOptions = {},
): Promise<MapDimensionApplyResult> {
  const preference = dashboardMapModeToPreference(requested);
  const alreadyGlobe = ctx.map?.isGlobeMode() ?? false;
  const wantGlobe = preference === 'globe';

  if (wantGlobe === alreadyGlobe) {
    return {
      requested,
      effective: currentDashboardMapMode(ctx),
      renderer: currentMapRenderer(ctx),
      alreadyActive: true,
      adjustedLayers: [],
      fellBack: false,
      persisted: true,
    };
  }

  // WebMCP promises a persistent mutation. Prove storage is writable before
  // starting an asynchronous renderer replacement, while the visible button
  // remains best-effort in storage-restricted browser modes.
  if (
    options.requirePersistence
    && !persistJson(STORAGE_KEYS.mapMode, dashboardMapModeToPreference(currentDashboardMapMode(ctx)))
  ) {
    return {
      requested,
      effective: currentDashboardMapMode(ctx),
      renderer: currentMapRenderer(ctx),
      alreadyActive: false,
      adjustedLayers: [],
      fellBack: false,
      persisted: false,
    };
  }

  // Optimistic control chrome only. Persist the mode the replacement renderer
  // actually settles on so a globe init fallback cannot leave storage/toggle
  // on 3d while SVG is visible.
  syncMapDimensionToggle(preference);
  const switchResult = wantGlobe
    ? await ctx.map?.switchToGlobe()
    : await ctx.map?.switchToFlat();
  const effective = currentDashboardMapMode(ctx);
  const renderer = currentMapRenderer(ctx);
  const fellBack = Boolean(switchResult?.fallback) || (wantGlobe && effective !== '3d');
  const persistPreference = dashboardMapModeToPreference(effective);
  syncMapDimensionToggle(persistPreference);
  const modePersisted = persistJson(STORAGE_KEYS.mapMode, persistPreference);
  const layerAdjustment = disableIncompatibleResilienceLayer(ctx);

  return {
    requested,
    effective,
    renderer,
    alreadyActive: false,
    adjustedLayers: layerAdjustment.adjustments,
    fellBack,
    persisted: modePersisted && layerAdjustment.persisted,
  };
}
