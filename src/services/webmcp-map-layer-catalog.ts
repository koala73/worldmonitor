import {
  DASHBOARD_LAYER_ACTION_TARGET_ID_PATTERN,
  MAX_LAYER_ACTION_TARGET_ID_LENGTH,
} from '../../shared/agent-bus-contract';
import {
  LAYER_REGISTRY,
  getAllowedLayerKeys,
  getCompleteLayerCatalogKeys,
  getOrderedLayerKeys,
  isLayerEntitled,
  isLayerExecutable,
  resolveLayerLabel,
  type MapVariant,
  type RendererKind,
} from '../config/map-layer-definitions';
import {
  ALL_MAP_LAYERS_RUNTIME_AVAILABLE,
  resolveMapLayerRuntimeUnavailableReason,
  type MapLayerRuntimeAvailability,
} from './map-layer-runtime-availability';
import type { MapLayers } from '../types';

export const WEBMCP_MAP_LAYER_MONITORS = [
  'world',
  'tech',
  'finance',
  'commodity',
  'energy',
  'happy',
] as const;
export type WebMcpMapLayerMonitor = (typeof WEBMCP_MAP_LAYER_MONITORS)[number];

export const WEBMCP_MAP_LAYER_RENDERERS = ['2d', '3d'] as const;
export type WebMcpMapLayerRenderer = (typeof WEBMCP_MAP_LAYER_RENDERERS)[number];

export const WEBMCP_MAP_LAYER_STATES = ['enabled', 'available'] as const;
export type WebMcpMapLayerState = (typeof WEBMCP_MAP_LAYER_STATES)[number];

export const DEFAULT_MAP_LAYER_PAGE_SIZE = 6;
export const MAX_MAP_LAYER_PAGE_SIZE = 8;
export const MAP_LAYER_LABEL_MAX_CHARS = 48;

const MONITOR_SET = new Set<string>(WEBMCP_MAP_LAYER_MONITORS);
const RENDERER_SET = new Set<string>(WEBMCP_MAP_LAYER_RENDERERS);
const STATE_SET = new Set<string>(WEBMCP_MAP_LAYER_STATES);
const LAYER_ID_PATTERN = new RegExp(DASHBOARD_LAYER_ACTION_TARGET_ID_PATTERN);
const MAP_VARIANTS = new Set<MapVariant>([
  'full', 'tech', 'finance', 'happy', 'commodity', 'energy',
]);

export type MapLayerCatalogInvalidReason =
  | 'malformed_arguments'
  | 'invalid_monitor'
  | 'invalid_renderer'
  | 'invalid_state'
  | 'invalid_limit'
  | 'invalid_cursor';

export interface MapLayerCatalogSnapshot {
  variant: string;
  rendererKind: RendererKind;
  enabledLayers: readonly string[];
  liveLayerKeys: readonly string[];
  runtimeAvailability?: MapLayerRuntimeAvailability;
  hasPremium: boolean;
  deckGlActive: boolean;
  /** False when the host cannot deliver a target-side AbortSignal for set_map_layers. */
  targetCancellationSupported?: boolean;
  tFn?: (key: string) => string;
}

export interface MapLayerCatalogQuery {
  monitor?: WebMcpMapLayerMonitor;
  renderer?: WebMcpMapLayerRenderer;
  state?: WebMcpMapLayerState;
  cursor?: string;
  limit: number;
}

export interface MapLayerCatalogEntry {
  id: string;
  label: string;
  enabled: boolean;
  monitorAvailable: boolean;
  rendererCompatible: boolean;
  entitled: boolean;
  available: boolean;
  reason?: string;
}

export interface MapLayerCatalogSuccess {
  ok: true;
  variant: MapVariant;
  renderer: WebMcpMapLayerRenderer;
  layers: MapLayerCatalogEntry[];
  count: number;
  total: number;
  nextCursor?: string;
}

export interface MapLayerCatalogInvalid {
  ok: false;
  status: 'invalid';
  reason: MapLayerCatalogInvalidReason;
  message: string;
}

export type MapLayerCatalogResult = MapLayerCatalogSuccess | MapLayerCatalogInvalid;

const CATALOG_ARG_KEYS = ['monitor', 'renderer', 'state', 'cursor', 'limit'] as const;

export function monitorToVariant(monitor: WebMcpMapLayerMonitor): MapVariant {
  return monitor === 'world' ? 'full' : monitor;
}

export function rendererFamily(kind: RendererKind): WebMcpMapLayerRenderer {
  return kind === 'globe' ? '3d' : '2d';
}

export function normalizeCatalogVariant(variant: string): MapVariant {
  return MAP_VARIANTS.has(variant as MapVariant) ? variant as MapVariant : 'full';
}

function invalid(
  reason: MapLayerCatalogInvalidReason,
  message: string,
): MapLayerCatalogInvalid {
  return { ok: false, status: 'invalid', reason, message };
}

function hasOnlyOwnKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function matchesRendererFilter(
  renderers: RendererKind[],
  filter: WebMcpMapLayerRenderer,
): boolean {
  return filter === '3d'
    ? renderers.includes('globe')
    : renderers.includes('svg') || renderers.includes('deck');
}

function enableUnavailableReason(
  layerKey: keyof MapLayers,
  snapshot: MapLayerCatalogSnapshot,
  liveKeys: Set<string>,
  pageAllowed: Set<keyof MapLayers>,
): string | undefined {
  const runtimeReason = resolveMapLayerRuntimeUnavailableReason(
    layerKey,
    liveKeys.has(layerKey),
    snapshot.runtimeAvailability ?? ALL_MAP_LAYERS_RUNTIME_AVAILABLE,
  );
  if (runtimeReason) return runtimeReason;
  if (!pageAllowed.has(layerKey)) return 'variant_disallowed';
  if (!isLayerEntitled(layerKey, snapshot.hasPremium)) return 'layer_not_entitled';
  if (layerKey === 'resilienceScore' && !snapshot.deckGlActive) return 'layer_not_executable';
  if (!isLayerExecutable(layerKey, snapshot.rendererKind)) return 'layer_not_executable';
  if (snapshot.targetCancellationSupported !== true) return 'target_cancellation_unsupported';
  return undefined;
}

function describeLayer(
  layerKey: keyof MapLayers,
  snapshot: MapLayerCatalogSnapshot,
  listedAllowed: Set<keyof MapLayers>,
  liveKeys: Set<string>,
  pageAllowed: Set<keyof MapLayers>,
  enabledSet: Set<string>,
): MapLayerCatalogEntry {
  const def = LAYER_REGISTRY[layerKey];
  const reason = enableUnavailableReason(layerKey, snapshot, liveKeys, pageAllowed);
  const entry: MapLayerCatalogEntry = {
    id: layerKey,
    label: resolveLayerLabel(def, snapshot.tFn).slice(0, MAP_LAYER_LABEL_MAX_CHARS),
    enabled: enabledSet.has(layerKey),
    monitorAvailable: listedAllowed.has(layerKey),
    rendererCompatible: isLayerExecutable(layerKey, snapshot.rendererKind),
    entitled: isLayerEntitled(layerKey, snapshot.hasPremium),
    available: reason === undefined,
  };
  if (reason) entry.reason = reason;
  return entry;
}

export function parseMapLayerCatalogArgs(
  args: Record<string, unknown>,
): { ok: true; query: MapLayerCatalogQuery } | MapLayerCatalogInvalid {
  if (!hasOnlyOwnKeys(args, CATALOG_ARG_KEYS)) {
    return invalid(
      'malformed_arguments',
      'list_map_layers accepts only monitor, renderer, state, cursor, and limit.',
    );
  }

  let monitor: WebMcpMapLayerMonitor | undefined;
  if (args.monitor !== undefined) {
    if (typeof args.monitor !== 'string' || !MONITOR_SET.has(args.monitor)) {
      return invalid(
        'invalid_monitor',
        'monitor must be one of: world, tech, finance, commodity, energy, happy.',
      );
    }
    monitor = args.monitor as WebMcpMapLayerMonitor;
  }

  let renderer: WebMcpMapLayerRenderer | undefined;
  if (args.renderer !== undefined) {
    if (typeof args.renderer !== 'string' || !RENDERER_SET.has(args.renderer)) {
      return invalid('invalid_renderer', 'renderer must be 2d or 3d.');
    }
    renderer = args.renderer as WebMcpMapLayerRenderer;
  }

  let state: WebMcpMapLayerState | undefined;
  if (args.state !== undefined) {
    if (typeof args.state !== 'string' || !STATE_SET.has(args.state)) {
      return invalid('invalid_state', 'state must be enabled or available.');
    }
    state = args.state as WebMcpMapLayerState;
  }

  let cursor: string | undefined;
  if (args.cursor !== undefined) {
    if (
      typeof args.cursor !== 'string'
      || args.cursor.length < 1
      || args.cursor.length > MAX_LAYER_ACTION_TARGET_ID_LENGTH
      || !LAYER_ID_PATTERN.test(args.cursor)
    ) {
      return invalid(
        'invalid_cursor',
        'cursor must be a catalog layer ID from a previous list_map_layers page.',
      );
    }
    cursor = args.cursor;
  }

  let limit = DEFAULT_MAP_LAYER_PAGE_SIZE;
  if (args.limit !== undefined) {
    if (
      !Number.isInteger(args.limit)
      || Number(args.limit) < 1
      || Number(args.limit) > MAX_MAP_LAYER_PAGE_SIZE
    ) {
      return invalid(
        'invalid_limit',
        `limit must be an integer from 1 to ${MAX_MAP_LAYER_PAGE_SIZE}.`,
      );
    }
    limit = Number(args.limit);
  }

  return { ok: true, query: { monitor, renderer, state, cursor, limit } };
}

export function listMapLayerCatalog(
  snapshot: MapLayerCatalogSnapshot,
  query: MapLayerCatalogQuery,
  budgets: { targetOutputChars: number },
): MapLayerCatalogResult {
  const pageVariant = normalizeCatalogVariant(snapshot.variant);
  const listedVariant = query.monitor ? monitorToVariant(query.monitor) : pageVariant;
  const catalogKeys = query.monitor
    ? getOrderedLayerKeys(listedVariant)
    : getCompleteLayerCatalogKeys(pageVariant);
  const listedAllowed = getAllowedLayerKeys(listedVariant);
  const pageAllowed = getAllowedLayerKeys(pageVariant);
  const liveKeys = new Set(snapshot.liveLayerKeys);
  const enabledSet = new Set(snapshot.enabledLayers);

  const filtered = catalogKeys.filter((layerKey) => {
    if (query.renderer && !matchesRendererFilter(LAYER_REGISTRY[layerKey].renderers, query.renderer)) {
      return false;
    }
    const entry = describeLayer(
      layerKey,
      snapshot,
      listedAllowed,
      liveKeys,
      pageAllowed,
      enabledSet,
    );
    if (query.state === 'enabled') return entry.enabled;
    if (query.state === 'available') return entry.available;
    return true;
  });

  if (query.cursor && !filtered.includes(query.cursor as keyof MapLayers)) {
    return invalid(
      'invalid_cursor',
      'cursor must be a catalog layer ID from a previous list_map_layers page.',
    );
  }

  const start = query.cursor
    ? filtered.indexOf(query.cursor as keyof MapLayers) + 1
    : 0;
  const selected = filtered.slice(start, start + query.limit).map((layerKey) => (
    describeLayer(layerKey, snapshot, listedAllowed, liveKeys, pageAllowed, enabledSet)
  ));

  const result: MapLayerCatalogSuccess = {
    ok: true,
    variant: pageVariant,
    renderer: rendererFamily(snapshot.rendererKind),
    layers: selected,
    count: selected.length,
    total: filtered.length,
  };
  if (start + selected.length < filtered.length && selected.length > 0) {
    result.nextCursor = selected[selected.length - 1]?.id;
  }

  while (
    JSON.stringify(result).length > budgets.targetOutputChars
    && result.layers.length > 0
  ) {
    result.layers.pop();
    result.count = result.layers.length;
    if (start + result.layers.length < filtered.length && result.layers.length > 0) {
      result.nextCursor = result.layers[result.layers.length - 1]?.id;
    } else {
      delete result.nextCursor;
    }
  }

  return result;
}
