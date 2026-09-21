/**
 * AI Footprint — plan sections A–E as map overlays (cited WM geo only).
 *
 * Plan: AI Footprint growth on the timeline
 *   A Product / frontier → techHQs + convoHotspots + aiUsage
 *   B Open weights / diffusion → startupHubs + accelerators
 *   C Infrastructure / capital → datacenters + cloudRegions
 *   D Policy / geo friction → aiPolicy (implemented legislation + active discussion)
 *   E Density scatter → same keys + techEvents; growth filters in ai-era-visibility.ts
 *
 * Era seek via TimeNav sets timeFocus only (overlay checkboxes drive which
 * landmarks appear). Historical paint: Epoch firstOperationalMs (DCs),
 * accelerator founded year, techEvent startDate. techHQs / startupHubs /
 * cloudRegions have no cited open dates — Live only (missing ≠ 0).
 *
 * https://www.aipotluck.org/map/dataset
 */

import {
  AI_ERA_GROWTH_LAYER_KEYS,
  growthFlagsForEraSeek,
  type EraVisibilityCatalogs,
} from '@/config/ai-era-visibility';
import type { LayerKey, LayerMap } from './url-state';
import { emptyLayers } from './url-state';

export type AiFootprintAliasId = 'product' | 'open' | 'infrastructure' | 'policy';

export type AiFootprintAlias = {
  id: AiFootprintAliasId;
  /** Plan section letter for drawer copy */
  section: 'A' | 'B' | 'C' | 'D';
  label: string;
  description: string;
  layerKeys: readonly LayerKey[];
};

/** A–D pillar aliases onto existing DeckGL density layers. */
export const AI_FOOTPRINT_ALIASES: readonly AiFootprintAlias[] = [
  {
    id: 'product',
    section: 'A',
    label: 'Product / frontier',
    description: 'Tech HQs + Convo Hotspots + AI Usage (OWID / WildChat)',
    layerKeys: ['techHQs', 'convoHotspots', 'aiUsage'],
  },
  {
    id: 'open',
    section: 'B',
    label: 'Open weights',
    description: 'Startup Hubs + Accelerators',
    layerKeys: ['startupHubs', 'accelerators'],
  },
  {
    id: 'infrastructure',
    section: 'C',
    label: 'Infrastructure',
    description: 'Datacenters + Cloud Regions',
    layerKeys: ['datacenters', 'cloudRegions'],
  },
  {
    id: 'policy',
    section: 'D',
    label: 'Policy',
    description: 'Countries with implemented AI legislation or active policy discussion',
    layerKeys: ['aiPolicy'],
  },
];

/**
 * E — individual AI map layers (drawer + Overlays). Soft point density / fills.
 * Growth over scrubber: see @/config/ai-era-visibility + product/DC growth landmarks.
 */
export const AI_FOOTPRINT_LAYER_KEYS: readonly LayerKey[] = [
  'techHQs',
  'convoHotspots',
  'aiUsage',
  'startupHubs',
  'accelerators',
  'datacenters',
  'cloudRegions',
  'aiPolicy',
  'techEvents',
];

export function isAliasActive(alias: AiFootprintAlias, layers: LayerMap): boolean {
  return alias.layerKeys.every((k) => layers[k]);
}

export function layersForAliasToggle(
  alias: AiFootprintAlias,
  layers: LayerMap,
  on: boolean,
): LayerMap {
  const next = { ...layers };
  for (const k of alias.layerKeys) {
    next[k] = on;
  }
  return next;
}

export function activeAiFootprintLayerValues(layers: LayerMap): string[] {
  return AI_FOOTPRINT_LAYER_KEYS.filter((k) => layers[k]);
}

/** @deprecated Prefer layersForEraSeek — additive enable is wrong for era seek. */
export const AI_ERA_PROGRESS_LAYER_KEYS: readonly LayerKey[] = [
  ...AI_ERA_GROWTH_LAYER_KEYS,
];

/**
 * Era / Live seek: clear every overlay, enable only AI growth layers with
 * cited points visible at focus (Live = today’s catalog). Empty if none.
 */
export function layersForEraSeek(
  focusMs: number | null,
  catalogs?: EraVisibilityCatalogs,
): LayerMap {
  const next = emptyLayers(false);
  const flags = growthFlagsForEraSeek(focusMs, catalogs);
  for (const key of AI_ERA_GROWTH_LAYER_KEYS) {
    next[key] = flags[key];
  }
  return next;
}
