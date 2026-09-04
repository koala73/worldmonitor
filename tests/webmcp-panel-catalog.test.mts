import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_PANELS,
  PANEL_CATEGORY_MAP,
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
  getInitialPanelSettingsForVariant,
} from '../src/config/panels.ts';
import { SITE_VARIANTS } from '../src/config/variant.ts';
import {
  DASHBOARD_PANEL_CATALOG_DEFAULT_LIMIT,
  DASHBOARD_PANEL_CATALOG_MAX_LIMIT,
  DASHBOARD_PANEL_CATALOG_OUTPUT_TARGET_CHARS,
  DashboardPanelCatalogError,
  getCanonicalDashboardPanelIds,
  getDashboardPanelCategoryKey,
  listDashboardPanelCatalog,
  type DashboardPanelCatalogItem,
  type DashboardPanelCatalogLiveState,
  type DashboardPanelCatalogPage,
} from '../src/services/webmcp-panel-catalog.ts';
import { WEBMCP_TOOL_BUDGETS } from '../src/config/webmcp.ts';
import type { PanelConfig } from '../src/types/index.ts';

function liveState(
  variant: string,
  overrides: {
    enabled?: string[];
    mounted?: string[];
    denied?: string[];
    panelSettings?: Record<string, PanelConfig>;
  } = {},
): DashboardPanelCatalogLiveState {
  const panelSettings = overrides.panelSettings ?? getInitialPanelSettingsForVariant(variant);
  if (overrides.enabled) {
    const enabled = new Set(overrides.enabled);
    for (const [panelId, config] of Object.entries(panelSettings)) {
      panelSettings[panelId] = { ...config, enabled: enabled.has(panelId) };
    }
  }
  const mounted = new Set(
    overrides.mounted
      ?? Object.entries(panelSettings)
        .filter(([, config]) => config.enabled)
        .map(([panelId]) => panelId),
  );
  const denied = new Set(overrides.denied ?? []);
  return {
    currentVariant: variant,
    panelSettings,
    mountedIds: mounted,
    isPanelAllowed: (panelId, config) => !denied.has(panelId) && !config.premium,
  };
}

function collectPages(
  live: DashboardPanelCatalogLiveState,
  query: Parameters<typeof listDashboardPanelCatalog>[1] = {},
): DashboardPanelCatalogPage[] {
  const pages: DashboardPanelCatalogPage[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 80; guard += 1) {
    const page = listDashboardPanelCatalog(live, { ...query, cursor, limit: query?.limit });
    pages.push(page);
    if (!page.hasMore) return pages;
    assert.equal(typeof page.nextCursor, 'string');
    cursor = page.nextCursor ?? undefined;
  }
  throw new Error('catalog pagination did not terminate');
}

describe('WebMCP dashboard panel catalog', () => {
  it('lists every canonical panel ID, including disabled World defaults', () => {
    const uniqueIds = getCanonicalDashboardPanelIds();
    const worldIds = getCanonicalDashboardPanelIds('full');
    const disabledWorld = (VARIANT_DEFAULTS.full ?? [])
      .filter((panelId) => getEffectivePanelConfig(panelId, 'full').enabled !== true);

    assert.equal(uniqueIds.length, Object.keys(ALL_PANELS).length);
    assert.equal(worldIds.length, 109);
    assert.ok(uniqueIds.includes('regionalStartups'));
    assert.ok(uniqueIds.includes('gccNews'));
    assert.ok(disabledWorld.length > 0, 'World registry must include disabled panels');
    assert.ok(disabledWorld.every((panelId) => worldIds.includes(panelId)));
    assert.deepEqual([...uniqueIds], [...uniqueIds].sort((left, right) => left.localeCompare(right, 'en')));
  });

  it('pages the current monitor catalog without duplicates until exhaustion', () => {
    const live = liveState('full');
    const pages = collectPages(live, { variant: 'full', limit: 4 });
    const ids = pages.flatMap((page) => page.panels.map((panel) => panel.id));

    assert.equal(pages[0]?.total, 109);
    assert.ok(pages.length > 1);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, [...getCanonicalDashboardPanelIds('full')]);
    assert.equal(pages.at(-1)?.hasMore, false);
    assert.equal(pages.at(-1)?.nextCursor, null);
    for (const page of pages) {
      assert.ok(JSON.stringify(page).length <= DASHBOARD_PANEL_CATALOG_OUTPUT_TARGET_CHARS);
      assert.ok(JSON.stringify(page).length <= WEBMCP_TOOL_BUDGETS.outputJsonChars);
      assert.equal(page.variant, 'full');
      assert.ok(page.panels.length <= DASHBOARD_PANEL_CATALOG_MAX_LIMIT);
    }
  });

  it('defaults to every canonical panel and restricts by monitor variant', () => {
    const live = liveState('full');
    const allPages = collectPages(live);
    const worldPages = collectPages(live, { variant: 'full' });
    const techPages = collectPages(live, { variant: 'tech' });
    const allIds = allPages.flatMap((page) => page.panels.map((panel) => panel.id));
    const worldIds = worldPages.flatMap((page) => page.panels.map((panel) => panel.id));
    const techIds = techPages.flatMap((page) => page.panels.map((panel) => panel.id));

    assert.deepEqual(allIds, [...getCanonicalDashboardPanelIds()]);
    assert.deepEqual(worldIds, [...getCanonicalDashboardPanelIds('full')]);
    assert.deepEqual(techIds, [...getCanonicalDashboardPanelIds('tech')]);
    assert.notDeepEqual(worldIds, techIds);
    assert.ok(techIds.every((panelId) => allIds.includes(panelId)));
    assert.equal(allPages[0]?.variant, 'full');
    assert.equal(techPages[0]?.variant, 'full');
  });

  it('filters by category, enabled state, and availability', () => {
    const live = liveState('full', {
      enabled: ['map', 'markets', 'strategic-risk'],
      mounted: ['map', 'markets'],
      denied: ['strategic-risk'],
    });
    const core = listDashboardPanelCatalog(live, { variant: 'full', category: 'core', limit: 8 });
    const enabled = collectPages(live, { variant: 'full', enabled: true });
    const available = collectPages(live, { variant: 'full', available: true });
    const unavailable = collectPages(live, { variant: 'full', available: false });

    assert.ok(core.panels.length > 0);
    assert.ok(core.panels.every((panel) => panel.category === 'core'));
    assert.deepEqual(
      enabled.flatMap((page) => page.panels.map((panel) => panel.id)).sort(),
      ['map', 'markets', 'strategic-risk'],
    );
    assert.deepEqual(
      available.flatMap((page) => page.panels.map((panel) => panel.id)),
      ['map', 'markets'],
    );
    assert.ok(available.flatMap((page) => page.panels).every((panel) => panel.available));
    assert.ok(unavailable.flatMap((page) => page.panels).every((panel) => panel.available === false));
  });

  it('reports configured, enabled, mounted, entitled, and gated reasons', () => {
    const live = liveState('full', {
      enabled: ['map', 'markets', 'strategic-risk'],
      mounted: ['map'],
      denied: ['strategic-risk'],
    });
    const byId = new Map<string, DashboardPanelCatalogItem>(
      collectPages(live, { variant: 'full' })
        .flatMap((page) => page.panels)
        .map((panel) => [panel.id, panel]),
    );

    assert.deepEqual(byId.get('map'), {
      id: 'map',
      label: 'Global Map',
      category: 'core',
      variants: [...SITE_VARIANTS].filter((variant) => (
        (VARIANT_DEFAULTS[variant] ?? []).includes('map')
      )),
      enabled: true,
      mounted: true,
      entitled: true,
      available: true,
    });
    assert.equal(byId.get('markets')?.enabled, true);
    assert.equal(byId.get('markets')?.mounted, false);
    assert.equal(byId.get('markets')?.available, false);
    assert.equal(byId.get('markets')?.unavailableReason, 'panel_not_live');
    assert.equal(byId.get('strategic-risk')?.entitled, false);
    assert.equal(byId.get('strategic-risk')?.unavailableReason, 'panel_not_entitled');
    assert.equal(byId.get('windy-webcams')?.enabled, false);
    assert.equal(byId.get('windy-webcams')?.mounted, false);
    assert.equal(byId.get('windy-webcams')?.unavailableReason, 'panel_disabled');
    assert.equal('unavailableReason' in (byId.get('map') ?? {}), false);
  });

  it('keeps variant availability and category assignment aligned with settings registries', () => {
    const githubCategory = getDashboardPanelCategoryKey('github', 'tech');
    const githubOnWorld = getDashboardPanelCategoryKey('github', 'full');
    const live = liveState('full');
    const github = collectPages(live)
      .flatMap((page) => page.panels)
      .find((panel) => panel.id === 'github');

    assert.equal(githubCategory, 'techAi');
    assert.equal(githubOnWorld, 'techAi');
    assert.ok(github);
    assert.deepEqual(github.variants, ['tech']);
    assert.equal(github.category, 'techAi');
    assert.ok(Object.keys(PANEL_CATEGORY_MAP).includes('techAi'));
  });

  it('classifies a filtered variant catalog with that variant\'s categories', () => {
    const live = liveState('full');
    const techMarketIds = collectPages(live, { variant: 'tech', category: 'techMarkets' })
      .flatMap((page) => page.panels.map((panel) => panel.id));
    const marketsOnWorld = collectPages(live, { variant: 'full' })
      .flatMap((page) => page.panels)
      .find((panel) => panel.id === 'markets');
    const techMarkets = listDashboardPanelCatalog(live, {
      variant: 'tech',
      category: 'techMarkets',
      limit: 8,
    });

    assert.ok(techMarketIds.includes('markets'));
    assert.ok(techMarketIds.includes('finance'));
    assert.ok(techMarketIds.includes('crypto'));
    assert.deepEqual(
      [...techMarketIds].sort((left, right) => left.localeCompare(right, 'en')),
      [...(PANEL_CATEGORY_MAP.techMarkets?.panelKeys ?? [])]
        .filter((panelId) => getCanonicalDashboardPanelIds('tech').includes(panelId))
        .sort((left, right) => left.localeCompare(right, 'en')),
    );
    assert.ok(techMarkets.panels.every((panel) => panel.category === 'techMarkets'));
    assert.equal(marketsOnWorld?.category, 'marketsFinance');
    assert.equal(techMarkets.variant, 'full');
  });

  it('rejects invalid filters and cursors with structured reasons', () => {
    const live = liveState('full');
    const cases: Array<[Parameters<typeof listDashboardPanelCatalog>[1], string]> = [
      [{ variant: 'desktop' }, 'invalid_variant'],
      [{ category: 'not-a-category' }, 'invalid_category'],
      [{ category: 'constructor' }, 'invalid_category'],
      [{ cursor: 'not-a-panel' }, 'invalid_cursor'],
      [{ cursor: 'cw-risk-chart' }, 'invalid_cursor'],
      [{ limit: 0 }, 'invalid_limit'],
      [{ limit: DASHBOARD_PANEL_CATALOG_MAX_LIMIT + 1 }, 'invalid_limit'],
      [{ enabled: 'true' as unknown as boolean }, 'malformed_arguments'],
    ];

    for (const [query, reason] of cases) {
      assert.throws(
        () => listDashboardPanelCatalog(live, query),
        (error: unknown) => (
          error instanceof DashboardPanelCatalogError
          && error.reason === reason
        ),
        JSON.stringify(query),
      );
    }
  });

  it('uses a valid cursor as a keyset even when the id is outside the active filter', () => {
    const live = liveState('full');
    const worldIds = [...getCanonicalDashboardPanelIds('full')];
    const cursor = worldIds[3];
    const page = listDashboardPanelCatalog(live, {
      variant: 'full',
      category: 'core',
      cursor,
      limit: DASHBOARD_PANEL_CATALOG_DEFAULT_LIMIT,
    });
    assert.ok(page.panels.every((panel) => panel.id.localeCompare(cursor ?? '', 'en') > 0));
    assert.ok(page.panels.every((panel) => panel.category === 'core'));
  });
});
