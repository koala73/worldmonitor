import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LAYER_REGISTRY,
  getCompleteLayerCatalogKeys,
  getOrderedLayerKeys,
  isLayerEntitled,
  isLayerExecutable,
  isSunsetLayer,
  resolveLayerLabel,
} from '../src/config/map-layer-definitions.ts';
import {
  DEFAULT_MAP_LAYER_PAGE_SIZE,
  MAP_LAYER_LABEL_MAX_CHARS,
  MAX_MAP_LAYER_PAGE_SIZE,
  listMapLayerCatalog,
  parseMapLayerCatalogArgs,
  type MapLayerCatalogSnapshot,
} from '../src/services/webmcp-map-layer-catalog.ts';
import {
  ALL_MAP_LAYERS_RUNTIME_AVAILABLE,
  resolveMapLayerRuntimeUnavailableReason,
  type MapLayerRuntimeAvailability,
} from '../src/services/map-layer-runtime-availability.ts';
import type { MapLayers } from '../src/types/index.ts';

const BUDGETS = { targetOutputChars: 1_400 };

function snapshot(overrides: Partial<MapLayerCatalogSnapshot> = {}): MapLayerCatalogSnapshot {
  return {
    variant: 'full',
    rendererKind: 'deck',
    enabledLayers: ['conflicts'],
    liveLayerKeys: Object.keys(LAYER_REGISTRY),
    hasPremium: false,
    deckGlActive: true,
    targetCancellationSupported: true,
    runtimeAvailability: ALL_MAP_LAYERS_RUNTIME_AVAILABLE,
    ...overrides,
  };
}

function catalogEntry(
  layerId: keyof MapLayers,
  overrides: Partial<MapLayerCatalogSnapshot> = {},
) {
  const keys = getCompleteLayerCatalogKeys('full');
  const index = keys.indexOf(layerId);
  assert.ok(index >= 0, `${layerId} must remain in the complete catalog`);
  const page = listMapLayerCatalog(snapshot(overrides), {
    cursor: index > 0 ? keys[index - 1] : undefined,
    limit: 1,
  }, BUDGETS);
  assert.equal(page.ok, true);
  return page.ok ? page.layers[0] : undefined;
}

function collectPages(query: Parameters<typeof listMapLayerCatalog>[1] extends infer Q
  ? Omit<Q, 'cursor' | 'limit'> & { limit?: number }
  : never) {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let total = 0;
  for (;;) {
    const page = listMapLayerCatalog(snapshot(), {
      ...query,
      limit: query.limit ?? DEFAULT_MAP_LAYER_PAGE_SIZE,
      cursor,
    }, BUDGETS);
    assert.equal(page.ok, true);
    if (!page.ok) return { ids, pages, total };
    pages += 1;
    total = page.total;
    for (const layer of page.layers) ids.push(layer.id);
    assert.ok(JSON.stringify(page).length <= 1_500, 'each page must stay inside the WebMCP output budget');
    if (!page.nextCursor) break;
    assert.equal(page.nextCursor, page.layers.at(-1)?.id);
    cursor = page.nextCursor;
    assert.ok(pages < 40, 'pagination must terminate');
  }
  return { ids, pages, total };
}

describe('map-layer catalog keys', () => {
  it('enumerates the complete non-sunset registry after the current variant order', () => {
    const complete = getCompleteLayerCatalogKeys('full');
    const expected = (Object.keys(LAYER_REGISTRY) as Array<keyof MapLayers>)
      .filter((key) => !isSunsetLayer(key));
    assert.deepEqual([...complete].sort(), [...expected].sort());
    assert.deepEqual(complete.slice(0, getOrderedLayerKeys('full').length), getOrderedLayerKeys('full'));
    assert.equal(complete.includes('iranAttacks'), false);
  });
});

describe('parseMapLayerCatalogArgs', () => {
  it('accepts empty args and default limit', () => {
    assert.deepEqual(parseMapLayerCatalogArgs({}), {
      ok: true,
      query: {
        monitor: undefined,
        renderer: undefined,
        state: undefined,
        cursor: undefined,
        limit: DEFAULT_MAP_LAYER_PAGE_SIZE,
      },
    });
  });

  it('rejects unknown filters, monitors, renderers, states, limits, and cursors', () => {
    assert.equal(parseMapLayerCatalogArgs({ extra: true }).ok, false);
    assert.equal(parseMapLayerCatalogArgs({ extra: true }).reason, 'malformed_arguments');
    assert.equal(parseMapLayerCatalogArgs({ monitor: 'full' }).reason, 'invalid_monitor');
    assert.equal(parseMapLayerCatalogArgs({ renderer: 'deck' }).reason, 'invalid_renderer');
    assert.equal(parseMapLayerCatalogArgs({ state: 'disabled' }).reason, 'invalid_state');
    assert.equal(parseMapLayerCatalogArgs({ limit: 0 }).reason, 'invalid_limit');
    assert.equal(parseMapLayerCatalogArgs({ limit: MAX_MAP_LAYER_PAGE_SIZE + 1 }).reason, 'invalid_limit');
    assert.equal(parseMapLayerCatalogArgs({ limit: 1.5 }).reason, 'invalid_limit');
    assert.equal(parseMapLayerCatalogArgs({ cursor: 'Not Valid' }).reason, 'invalid_cursor');
  });
});

describe('listMapLayerCatalog', () => {
  it('pages the complete catalog deterministically within the output budget', () => {
    const { ids, total } = collectPages({});
    assert.equal(total, getCompleteLayerCatalogKeys('full').length);
    assert.deepEqual(ids, getCompleteLayerCatalogKeys('full'));
    assert.equal(new Set(ids).size, ids.length);
    const world = collectPages({ monitor: 'world', limit: MAX_MAP_LAYER_PAGE_SIZE });
    assert.equal(world.total, getOrderedLayerKeys('full').length);
    assert.ok(ids.length > world.ids.length);
  });

  it('lists only the requested monitor variant and keeps current-page set_map_layers availability', () => {
    const page = listMapLayerCatalog(snapshot(), {
      monitor: 'tech',
      limit: MAX_MAP_LAYER_PAGE_SIZE,
    }, BUDGETS);
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.deepEqual(page.layers.map((layer) => layer.id), getOrderedLayerKeys('tech').slice(0, MAX_MAP_LAYER_PAGE_SIZE));
    const startup = page.layers.find((layer) => layer.id === 'startupHubs');
    assert.ok(startup);
    assert.equal(startup.monitorAvailable, true);
    assert.equal(startup.available, false);
    assert.equal(startup.reason, 'variant_disallowed');
    const datacenters = page.layers.find((layer) => layer.id === 'datacenters');
    assert.ok(datacenters);
    assert.equal(datacenters.monitorAvailable, true);
    assert.equal(datacenters.available, true);
  });

  it('filters 2D and 3D renderer compatibility without dropping disabled layers', () => {
    const threeD = listMapLayerCatalog(snapshot({ rendererKind: 'globe' }), {
      renderer: '3d',
      limit: MAX_MAP_LAYER_PAGE_SIZE,
    }, BUDGETS);
    assert.equal(threeD.ok, true);
    if (!threeD.ok) return;
    assert.ok(threeD.layers.every((layer) => (
      LAYER_REGISTRY[layer.id as keyof MapLayers].renderers.includes('globe')
    )));
    const dayNight = threeD.layers.find((layer) => layer.id === 'dayNight');
    assert.equal(dayNight, undefined);

    const twoD = collectPages({ renderer: '2d', limit: MAX_MAP_LAYER_PAGE_SIZE });
    assert.ok(twoD.ids.includes('dayNight'));
    assert.ok(twoD.ids.includes('canadaRoads'));
    assert.equal(twoD.ids.includes('conflicts'), true);
    const globeOnlyMissing = twoD.ids.every((id) => {
      const renderers = LAYER_REGISTRY[id as keyof MapLayers].renderers;
      return renderers.includes('svg') || renderers.includes('deck');
    });
    assert.equal(globeOnlyMissing, true);

    const globeIds = getCompleteLayerCatalogKeys('full');
    const sanctionsCursor = globeIds[globeIds.indexOf('sanctions') - 1];
    const globePage = listMapLayerCatalog(snapshot({ rendererKind: 'globe' }), {
      cursor: sanctionsCursor,
      limit: 1,
    }, BUDGETS);
    assert.equal(globePage.ok, true);
    if (!globePage.ok) return;
    const sanctionsEntry = globePage.layers[0];
    assert.equal(sanctionsEntry?.id, 'sanctions');
    assert.equal(sanctionsEntry?.enabled, false);
    assert.equal(sanctionsEntry?.rendererCompatible, isLayerExecutable('sanctions', 'globe'));
    assert.equal(sanctionsEntry?.available, false);
    assert.equal(sanctionsEntry?.reason, 'layer_not_executable');
  });

  it('explains premium-gated layers with the same reason set_map_layers uses', () => {
    const world = collectPages({ monitor: 'world', limit: MAX_MAP_LAYER_PAGE_SIZE });
    assert.ok(world.ids.includes('resilienceScore'));
    const cursor = world.ids[world.ids.indexOf('resilienceScore') - 1];
    const entry = listMapLayerCatalog(snapshot({ hasPremium: false }), {
      monitor: 'world',
      cursor,
      limit: 1,
    }, BUDGETS);
    assert.equal(entry.ok, true);
    if (!entry.ok) return;
    assert.equal(entry.layers[0]?.id, 'resilienceScore');
    assert.equal(entry.layers[0]?.entitled, isLayerEntitled('resilienceScore', false));
    assert.equal(entry.layers[0]?.available, false);
    assert.equal(entry.layers[0]?.reason, 'layer_not_entitled');
    assert.equal(entry.layers[0]?.enabled, false);

    const premium = listMapLayerCatalog(snapshot({ hasPremium: true }), {
      monitor: 'world',
      cursor,
      limit: 1,
    }, BUDGETS);
    assert.equal(premium.ok, true);
    if (!premium.ok) return;
    assert.equal(premium.layers[0]?.available, true);
    assert.equal(premium.layers[0]?.reason, undefined);
  });

  it('explains resilienceScore as layer_not_executable when deck.gl is inactive', () => {
    const world = collectPages({ monitor: 'world', limit: MAX_MAP_LAYER_PAGE_SIZE });
    assert.ok(world.ids.includes('resilienceScore'));
    const cursor = world.ids[world.ids.indexOf('resilienceScore') - 1];
    const entry = listMapLayerCatalog(snapshot({ deckGlActive: false, hasPremium: true }), {
      monitor: 'world',
      cursor,
      limit: 1,
    }, BUDGETS);
    assert.equal(entry.ok, true);
    if (!entry.ok) return;
    assert.equal(entry.layers[0]?.id, 'resilienceScore');
    assert.equal(entry.layers[0]?.available, false);
    assert.equal(entry.layers[0]?.reason, 'layer_not_executable');
  });

  it('shrinks the page to fit a tight output budget', () => {
    const tight = { targetOutputChars: 200 };
    const page = listMapLayerCatalog(snapshot(), {
      limit: MAX_MAP_LAYER_PAGE_SIZE,
    }, tight);
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.ok(JSON.stringify(page).length <= tight.targetOutputChars);
    assert.ok(page.layers.length < MAX_MAP_LAYER_PAGE_SIZE);
  });

  it('filters enabled and available state against live map state', () => {
    const enabled = listMapLayerCatalog(snapshot({
      enabledLayers: ['conflicts', 'weather'],
    }), { state: 'enabled', limit: MAX_MAP_LAYER_PAGE_SIZE }, BUDGETS);
    assert.equal(enabled.ok, true);
    if (!enabled.ok) return;
    assert.deepEqual(enabled.layers.map((layer) => layer.id).sort(), ['conflicts', 'weather']);
    assert.ok(enabled.layers.every((layer) => layer.enabled));

    const available = collectPages({ state: 'available', limit: MAX_MAP_LAYER_PAGE_SIZE });
    assert.ok(available.ids.includes('conflicts'));
    assert.equal(available.ids.includes('resilienceScore'), false);
    assert.equal(available.ids.includes('startupHubs'), false);
  });

  it('marks otherwise-available rows unavailable when the host cannot cancel set_map_layers', () => {
    const page = listMapLayerCatalog(snapshot({ targetCancellationSupported: false }), {
      limit: MAX_MAP_LAYER_PAGE_SIZE,
    }, BUDGETS);
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const conflicts = page.layers.find((layer) => layer.id === 'conflicts');
    assert.ok(conflicts);
    assert.equal(conflicts.enabled, true);
    assert.equal(conflicts.available, false);
    assert.equal(conflicts.reason, 'target_cancellation_unsupported');

    const world = collectPages({ monitor: 'world', limit: MAX_MAP_LAYER_PAGE_SIZE });
    const cursor = world.ids[world.ids.indexOf('resilienceScore') - 1];
    const gated = listMapLayerCatalog(snapshot({
      targetCancellationSupported: false,
      hasPremium: false,
    }), {
      monitor: 'world',
      cursor,
      limit: 1,
    }, BUDGETS);
    assert.equal(gated.ok, true);
    if (!gated.ok) return;
    assert.equal(gated.layers[0]?.id, 'resilienceScore');
    assert.equal(gated.layers[0]?.available, false);
    assert.equal(gated.layers[0]?.reason, 'layer_not_entitled');

    const available = listMapLayerCatalog(snapshot({ targetCancellationSupported: false }), {
      state: 'available',
      limit: MAX_MAP_LAYER_PAGE_SIZE,
    }, BUDGETS);
    assert.equal(available.ok, true);
    if (!available.ok) return;
    assert.equal(available.layers.length, 0);
    assert.equal(available.total, 0);
  });

  it('rejects a cursor that is not in the current filtered page sequence', () => {
    const result = listMapLayerCatalog(snapshot(), {
      monitor: 'happy',
      cursor: 'conflicts',
      limit: 2,
    }, BUDGETS);
    assert.deepEqual(result, {
      ok: false,
      status: 'invalid',
      reason: 'invalid_cursor',
      message: 'cursor must be a catalog layer ID from a previous list_map_layers page.',
    });
  });

  it('treats a missing live key as layer_not_live, matching set_map_layers', () => {
    const page = listMapLayerCatalog(snapshot({
      liveLayerKeys: ['conflicts'],
    }), { limit: 3 }, BUDGETS);
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const hotspots = page.layers.find((layer) => layer.id === 'hotspots');
    assert.ok(hotspots);
    assert.equal(hotspots.available, false);
    assert.equal(hotspots.reason, 'layer_not_live');
  });

  it('keeps cyber, AIS, and outages in the catalog when runtime-unavailable', () => {
    const gated: MapLayerRuntimeAvailability = {
      cyberLayerEnabled: false,
      aisConfigured: false,
      outagesAvailable: false,
    };
    const cyber = catalogEntry('cyberThreats', { runtimeAvailability: gated });
    const ais = catalogEntry('ais', { runtimeAvailability: gated });
    const outages = catalogEntry('outages', { runtimeAvailability: gated });

    assert.equal(cyber?.id, 'cyberThreats');
    assert.equal(cyber?.available, false);
    assert.equal(cyber?.reason, 'layer_feature_disabled');
    assert.equal(ais?.id, 'ais');
    assert.equal(ais?.available, false);
    assert.equal(ais?.reason, 'layer_not_configured');
    assert.equal(outages?.id, 'outages');
    assert.equal(outages?.available, false);
    assert.equal(outages?.reason, 'layer_not_configured');

    assert.equal(
      resolveMapLayerRuntimeUnavailableReason('cyberThreats', true, gated),
      'layer_feature_disabled',
    );
    assert.equal(
      resolveMapLayerRuntimeUnavailableReason('ais', true, gated),
      'layer_not_configured',
    );
    assert.equal(
      resolveMapLayerRuntimeUnavailableReason('outages', true, gated),
      'layer_not_configured',
    );
  });

  it('reuses a layer-ID cursor in the new filtered sequence when filters change', () => {
    const omitPage = listMapLayerCatalog(snapshot({ variant: 'tech' }), {
      limit: DEFAULT_MAP_LAYER_PAGE_SIZE,
    }, BUDGETS);
    assert.equal(omitPage.ok, true);
    if (!omitPage.ok) return;
    const cursor = omitPage.nextCursor;
    assert.ok(cursor);
    const worldAfterCursor = listMapLayerCatalog(snapshot({ variant: 'tech' }), {
      monitor: 'world',
      cursor,
      limit: MAX_MAP_LAYER_PAGE_SIZE,
    }, BUDGETS);
    assert.equal(worldAfterCursor.ok, true);
    if (!worldAfterCursor.ok) return;
    const worldOrder = getOrderedLayerKeys('full');
    const cursorIndex = worldOrder.indexOf(cursor as typeof worldOrder[number]);
    assert.ok(cursorIndex >= 0);
    const skippedPrefix = worldOrder.slice(0, cursorIndex);
    assert.ok(skippedPrefix.length > 0);
    assert.equal(
      worldAfterCursor.layers.some((layer) => skippedPrefix.includes(layer.id as typeof worldOrder[number])),
      false,
    );
  });

  it('uses resolveLayerLabel when tFn is present and falls back without it', () => {
    const def = LAYER_REGISTRY.conflicts;
    const tFn = (key: string) => (key.endsWith('conflicts') ? 'Localized Conflicts' : key);
    const localized = listMapLayerCatalog(snapshot({ tFn }), {
      monitor: 'world',
      cursor: getOrderedLayerKeys('full')[getOrderedLayerKeys('full').indexOf('conflicts') - 1],
      limit: 1,
    }, BUDGETS);
    assert.equal(localized.ok, true);
    if (!localized.ok) return;
    assert.equal(localized.layers[0]?.id, 'conflicts');
    assert.equal(
      localized.layers[0]?.label,
      resolveLayerLabel(def, tFn).slice(0, MAP_LAYER_LABEL_MAX_CHARS),
    );
    const fallback = listMapLayerCatalog(snapshot(), {
      monitor: 'world',
      cursor: getOrderedLayerKeys('full')[getOrderedLayerKeys('full').indexOf('conflicts') - 1],
      limit: 1,
    }, BUDGETS);
    assert.equal(fallback.ok, true);
    if (!fallback.ok) return;
    assert.equal(fallback.layers[0]?.id, 'conflicts');
    assert.equal(
      fallback.layers[0]?.label,
      resolveLayerLabel(def).slice(0, MAP_LAYER_LABEL_MAX_CHARS),
    );
  });
});
