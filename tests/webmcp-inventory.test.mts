import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  WEBMCP_DECLARATIVE_TOOL_NAMES,
  WEBMCP_HOMEPAGE_TOOL_NAMES,
  WEBMCP_PROCUREMENT_TOOL_NAME,
  WEBMCP_SPA_TOOL_NAMES,
  WEBMCP_TOOL_BUDGETS,
  WEBMCP_VARIANT_INVENTORIES,
  WEBMCP_MISSION_PICKER_REASONS,
} from '../src/config/webmcp.ts';
import { SITE_VARIANTS } from '../src/config/variant.ts';
import {
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
} from '../src/config/panels.ts';
import {
  WEBMCP_TOOL_CANCELLATION_POLICY,
  buildWebMcpTools as buildProductionWebMcpTools,
} from '../src/services/webmcp.ts';

import { PANEL_LAYOUT_DENIAL_REASONS } from '../src/services/panel-layout-actions.ts';
import {
  MISSION_PRESET_APPLY_DENY_REASONS,
  MISSION_PRESET_UNAVAILABLE_REASONS,
} from '../src/services/webmcp-mission-preset-catalog.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function buildWebMcpTools(
  app: Parameters<typeof buildProductionWebMcpTools>[0],
  track: Parameters<typeof buildProductionWebMcpTools>[1],
) {
  return buildProductionWebMcpTools(app, track).map((tool) => ({
    ...tool,
    execute(input: Record<string, unknown>) {
      return tool.execute(input, { signal: new AbortController().signal });
    },
  }));
}

function createBindings(overrides: Record<string, unknown> = {}) {
  return {
    openCountryBriefByCode: async () => true,
    resolveCountryName: (code: string) => `Country ${code}`,
    openSearch: async () => true,
    getDashboardContext: async () => ({
      variant: 'full',
      map: {
        view: 'global',
        center: { lat: 0, lon: 0 },
        zoom: 2,
        timeRange: '7d',
        enabledLayers: ['weather'],
      },
      panels: { mounted: ['map'], enabled: ['map'] },
    }),
    listMapLayerCatalog: async () => ({
      variant: 'full',
      rendererKind: 'deck',
      enabledLayers: ['weather'],
      liveLayerKeys: ['conflicts', 'weather', 'hotspots', 'resilienceScore'],
      hasPremium: false,
      deckGlActive: true,
    }),
    listDashboardPanels: async () => ({
      variant: 'full',
      total: 1,
      hasMore: false,
      nextCursor: null,
      panels: [{
        id: 'map',
        label: 'Map',
        category: 'core',
        variants: ['full'],
        enabled: true,
        mounted: true,
        entitled: true,
        available: true,
      }],
    }),
    switchMonitor: async (monitor) => ({
      ok: true,
      status: 'applied' as const,
      destination: monitor,
      navigation: 'none' as const,
      message: 'Already on that monitor.',
      context: {
        variant: monitor,
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: ['weather'],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    openSettings: async () => ({
      ok: true,
      status: 'applied' as const,
      destination: 'settings' as const,
      overlay: 'open' as const,
      tab: 'settings',
      message: 'Opened settings.',
      context: {
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: ['weather'],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    openAlerts: async () => ({
      ok: true,
      status: 'applied' as const,
      destination: 'alerts' as const,
      overlay: 'open' as const,
      tab: 'notifications',
      message: 'Opened alerts.',
      context: {
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: ['weather'],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    applyDashboardAction: async (action: {
      type: 'open_panel' | 'set_view' | 'set_layers' | 'set_time_range' | 'focus_country' | 'set_map_mode';
    }) => ({
      ok: true,
      status: 'applied' as const,
      actionType: action.type,
      message: 'Applied.',
      targets: [],
    }),
    searchDashboard: async (query: string) => ({
      queryLength: query.length,
      results: [{
        key: `sr_${'a'.repeat(32)}`,
        type: 'country',
        title: 'Germany',
        executable: true,
      }],
      resultCount: 1,
      truncated: false,
    }),
    openSearchResult: async () => ({ ok: true, status: 'opened' as const, type: 'country' }),
    setPanelEnabled: async () => ({
      ok: true,
      status: 'applied' as const,
      panelId: 'giving',
      requestedEnabled: true,
      effectiveEnabled: true,
      changed: true,
      message: 'Panel enabled.',
    }),
    listMissionPresets: async () => ({
      ok: true as const,
      variant: 'full',
      activePresetId: null,
      presets: [{
        id: 'supply-chain-risk' as const,
        label: 'Supply-Chain Risk',
        view: 'global' as const,
        timeRange: '7d' as const,
        panelCount: 2,
        layerCount: 1,
        active: false,
        monitorCompatible: true,
        entitled: true,
        available: true,
      }],
      count: 1,
    }),
    applyMissionPreset: async () => ({
      ok: true,
      status: 'applied' as const,
      presetId: 'supply-chain-risk',
      label: 'Supply-Chain Risk',
      changed: true,
      monitor: 'full',
      map: {
        view: 'global',
        zoom: 2.3,
        timeRange: '7d',
        enabledLayers: ['tradeRoutes'],
      },
      panels: { enabled: ['map', 'supply-chain'] },
      message: 'Mission preset applied: Supply-Chain Risk.',
    }),
    openMissionPicker: async () => ({
      ok: true,
      status: 'applied' as const,
      destination: 'mission_picker' as const,
      overlay: 'open' as const,
      message: 'Opened mission presets.',
      context: {
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: ['weather'],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    applyDashboardTabAction: async (action: { type: string; tabId?: string; name?: string }) => (
      action.type === 'list'
        ? {
            activeTabId: 'tab-main01-abc123',
            tabs: [{ id: 'tab-main01-abc123', name: 'Main', active: true, canDelete: false }],
            tabCount: 1,
            tabsTruncated: false,
            canCreate: true,
            cap: null,
          }
        : {
            ok: true,
            status: 'applied' as const,
            actionType: action.type,
            message: 'Applied dashboard tab action.',
            tabId: action.tabId ?? 'tab-main01-abc123',
            name: action.name ?? 'Main',
            activeTabId: action.tabId ?? 'tab-main01-abc123',
          }
    ),

    getPanelLayout: async () => ({
      regions: {
        sidebar: { available: true, panelCount: 1 },
        bottom: { available: false, panelCount: 0 },
      },
      panels: [{
        id: 'giving',
        region: 'sidebar' as const,
        index: 0,
        collapsed: false,
        fullscreen: false,
        collapsible: false,
        fullscreenCapable: false,
        fixed: false,
      }],
      panelCount: 1,
    }),
    setPanelCollapsed: async () => ({
      ok: true,
      status: 'applied' as const,
      actionType: 'set_collapsed' as const,
      panelId: 'live-news',
      requestedCollapsed: true,
      effectiveCollapsed: true,
      changed: true,
      message: 'Panel collapsed.',
      persisted: true,
    }),
    movePanel: async () => ({
      ok: true,
      status: 'applied' as const,
      actionType: 'move' as const,
      panelId: 'giving',
      region: 'sidebar',
      index: 0,
      changed: true,
      message: 'Moved panel.',
      persisted: true,
    }),
    setPanelFullscreen: async () => ({
      ok: true,
      status: 'applied' as const,
      actionType: 'set_fullscreen' as const,
      panelId: 'live-news',
      requestedFullscreen: true,
      effectiveFullscreen: true,
      changed: true,
      message: 'Panel entered fullscreen.',
    }),
    getAccessContext: async () => ({
      accountState: 'signed_out' as const,
      clerk: 'unavailable' as const,
      productTier: 'anonymous' as const,
      capabilities: {
        premiumAccess: false,
        apiAccess: false,
        mcpAccess: false,
        dataExport: false,
      },
      limits: {
        enabledPanels: { used: 1, cap: 40 },
        dashboardTabs: { used: 1, cap: 3, canCreate: true },
      },
    }),
    openSignIn: async () => ({ ok: false as const, status: 'denied' as const, reason: 'clerk_unavailable' as const }),
    ...overrides,
  };
}

const VALID_INPUTS: Record<string, Record<string, unknown>> = {
  openCountryBrief: { iso2: 'DE' },
  openSearch: {},
  get_dashboard_context: {},
  list_map_layers: {},
  list_dashboard_panels: {},
  switch_monitor: { monitor: 'tech' },
  open_settings: {},
  open_alerts: {},
  open_dashboard_panel: { panelId: 'markets' },
  set_panel_enabled: { panelId: 'giving', enabled: true },
  get_panel_layout: {},
  set_panel_collapsed: { panelId: 'live-news', collapsed: true },
  move_panel: { panelId: 'giving', region: 'sidebar', index: 0 },
  set_panel_fullscreen: { panelId: 'live-news', fullscreen: true },
  set_map_view: { view: 'eu', zoom: 4 },
  set_map_layers: { layers: { weather: true } },
  set_time_range: { timeRange: '24h' },
  focus_country: { iso2: 'DE' },
  set_map_mode: { mode: '2d' },
  search_dashboard: { query: 'germany' },
  open_search_result: { resultKey: `sr_${'a'.repeat(32)}` },
  list_dashboard_tabs: {},
  select_dashboard_tab: { tabId: 'tab-main01-abc123' },
  create_dashboard_tab: { name: 'Markets' },
  rename_dashboard_tab: { tabId: 'tab-main01-abc123', name: 'Workspace' },
  delete_dashboard_tab: { tabId: 'tab-main01-abc123', confirm: true },
  list_mission_presets: {},
  apply_mission_preset: { presetId: 'supply-chain-risk' },
  open_mission_picker: {},
  get_access_context: {},
  open_sign_in: {},
};

interface HomepageTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMCP.ToolAnnotations;
  execute(args: Record<string, unknown>): unknown;
}

const HOMEPAGE_VALID_INPUTS: Record<string, Record<string, unknown>> = {
  launchWorldMonitor: { monitor: 'world' },
  getWorldMonitorMcpEndpoint: {},
};

const WEBMCP_MAINTAINER_SOURCES = [
  'src/config/webmcp.ts',
  'src/services/webmcp.ts',
  'src/services/webmcp-map-layer-catalog.ts',
  'src/services/webmcp-panel-catalog.ts',
  'src/services/webmcp-mission-preset-catalog.ts',
  'src/App.ts',
  'src/app/webmcp-dashboard.ts',
  'src/app/dashboard-action-binding.ts',
  'shared/agent-bus-actions.ts',
  'shared/agent-bus-contract.ts',
  'src/app/agent-bus-applier.ts',
  'src/app/country-map-focus.ts',
  'src/app/map-dimension-control.ts',
  'src/config/panel-enablement.ts',
  'src/app/panel-enablement.ts',
  'src/app/webmcp-access.ts',
  'src/services/webmcp-access-snapshot.ts',
  'src/services/clerk.ts',
  'src/app/webmcp-search-controller.ts',
  'src/app/webmcp-search-effects.ts',
  'src/app/search-selection-dispatcher.ts',
  'src/services/panel-layout-actions.ts',
  'src/app/panel-layout.ts',
  'src/components/PanelTabBar.ts',
  'src/services/tab-store.ts',
  'src/services/dashboard-tab-actions.ts',
  'src/components/GlobalProcurementPanel.ts',
  'pro-test/welcome.html',
  'vercel.json',
  'docker/nginx-security-headers.conf',
  'docker/nginx-embed-security-headers.conf',
  'vite.config.ts',
  'pro-test/vite.config.ts',
  'tests/webmcp*.test.*',
  'tests/dom/*webmcp*.test.*',
  'tests/deploy-config.test.mjs',
  'tests/fixtures/webmcp/evals.v1.json',
  'scripts/evaluate-webmcp-evals.mjs',
  'e2e/webmcp.spec.ts',
  'e2e/webmcp-cancellation.spec.ts',
  'e2e/embed.spec.ts',
] as const;

const WEBMCP_FOCUSED_VERIFICATION_TESTS = [
  'tests/docs-i18n-parity.test.mjs',
  'tests/webmcp-inventory.test.mts',
  'tests/webmcp.test.mjs',
  'tests/webmcp-map-layer-catalog.test.mts',
  'tests/webmcp-search-effects.test.mts',
  'tests/webmcp-dashboard.test.mts',
  'tests/dashboard-tab-actions.test.mts',
  'tests/panel-layout-actions.test.mts',
  'tests/webmcp-panel-catalog.test.mts',
  'tests/webmcp-mission-presets.test.mts',
  'tests/agent-bus-actions.test.mts',
  'tests/agent-bus-applier.test.mts',
  'tests/country-map-focus.test.mts',
  'tests/webmcp-runtime.test.mjs',
  'tests/webmcp-analytics-policy.test.mjs',
  'tests/webmcp-evals.test.mjs',
  'tests/webmcp-access.test.mts',
  'tests/webmcp-panel-enablement.test.mts',
  'tests/deploy-config.test.mjs',
] as const;

function sectionBetween(guide: string, startHeading: string, endHeading: string): string {
  const start = guide.indexOf(startHeading);
  const end = guide.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(start, -1, `WebMCP guide is missing ${startHeading}`);
  assert.notEqual(end, -1, `WebMCP guide is missing ${endHeading}`);
  return guide.slice(start, end);
}

function visibleMdx(section: string): string {
  return section
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '');
}

function renderedTableNames(section: string): string[] {
  return [...visibleMdx(section).matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
}

const WEBMCP_CANCELLATION_CLASSES = [
  'read-only',
  'view-state',
  'cancellation-required',
  'result-dependent',
] as const;

function assertCancellationTable(guide: string, startHeading: string, endHeading: string) {
  const section = visibleMdx(sectionBetween(guide, startHeading, endHeading));
  for (const cancellationClass of WEBMCP_CANCELLATION_CLASSES) {
    const row = section.match(new RegExp('^\\| `' + cancellationClass + '` \\| ([^|]+) \\|', 'm'));
    assert.ok(row, `WebMCP guide is missing the ${cancellationClass} cancellation row`);
    const documentedNames = [...(row[1] ?? '').matchAll(/`([^`]+)`/g)]
      .map((match) => match[1])
      .sort();
    const expectedNames = Object.entries(WEBMCP_TOOL_CANCELLATION_POLICY)
      .filter(([, policy]) => policy === cancellationClass)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(documentedNames, expectedNames, `${cancellationClass} documentation drift`);
  }
}

/**
 * Every stable reason the panel-layout and mission-preset tools can report.
 * A reason that reaches a caller but is absent from a guide leaves that agent
 * with no documented recovery, so both language guides must name all of them.
 */
const WEBMCP_DOCUMENTED_REASONS = [...new Set([
  ...PANEL_LAYOUT_DENIAL_REASONS,
  ...MISSION_PRESET_UNAVAILABLE_REASONS,
  ...MISSION_PRESET_APPLY_DENY_REASONS,
  ...WEBMCP_MISSION_PICKER_REASONS,
])].sort();

function assertReasonsDocumented(
  guide: string,
  startHeading: string,
  endHeading: string,
  label: string,
) {
  // Scoped to the reasons section on purpose: several reason names also appear
  // in unrelated prose elsewhere in the guide, so a whole-document search would
  // pass for a reason that was never actually documented as an outcome.
  const section = visibleMdx(sectionBetween(guide, startHeading, endHeading));
  const missing = WEBMCP_DOCUMENTED_REASONS.filter(
    (reason) => !section.includes(`\`${reason}\``),
  );
  assert.deepEqual(missing, [], `${label} does not document these WebMCP reasons`);
}

function assertMaintainerSourceExists(source: string) {
  const lastSlash = source.lastIndexOf('/');
  const directory = source.slice(0, lastSlash);
  const basename = source.slice(lastSlash + 1);
  if (!basename.includes('*')) {
    assert.ok(existsSync(resolve(ROOT, source)), `WebMCP maintainer source does not exist: ${source}`);
    return;
  }

  const pattern = new RegExp(`^${basename.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
  const matches = readdirSync(resolve(ROOT, directory)).filter((entry) => pattern.test(entry));
  assert.ok(matches.length > 0, `WebMCP maintainer source glob matches no files: ${source}`);
}

function assertGuideContract(
  publicGuide: string,
  maintainerGuide: string,
  headings: {
    homepage: string;
    dashboard: string;
    declarative: string;
    journeys: string;
    cancellation: string;
    cancellationEnd: string;
    reasons: string;
    reasonsEnd: string;
    sourceMap: string;
    verification: string;
    verificationEnd: string;
  },
) {
  assert.deepEqual(
    renderedTableNames(sectionBetween(publicGuide, headings.homepage, headings.dashboard)),
    WEBMCP_HOMEPAGE_TOOL_NAMES,
  );
  assert.deepEqual(
    renderedTableNames(sectionBetween(publicGuide, headings.dashboard, headings.declarative)),
    WEBMCP_SPA_TOOL_NAMES,
  );
  assert.deepEqual(
    renderedTableNames(sectionBetween(publicGuide, headings.declarative, headings.journeys)),
    WEBMCP_DECLARATIVE_TOOL_NAMES,
  );
  assertCancellationTable(publicGuide, headings.cancellation, headings.cancellationEnd);

  const sourceMap = visibleMdx(sectionBetween(maintainerGuide, headings.sourceMap, headings.verification));
  const sourcePaths = [...sourceMap.matchAll(/^\| ([^|]+) \|/gm)].flatMap((row) =>
    [...(row[1] ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1]),
  );
  assert.deepEqual(sourcePaths, WEBMCP_MAINTAINER_SOURCES);
  for (const source of sourcePaths) assertMaintainerSourceExists(source);
  const verification = sectionBetween(maintainerGuide, headings.verification, headings.verificationEnd);
  const focusedTestPaths = [...verification.matchAll(/^\s{2}(tests\/[^\s\\]+)(?:\s+\\)?$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(focusedTestPaths, WEBMCP_FOCUSED_VERIFICATION_TESTS);
  assertReasonsDocumented(publicGuide, headings.reasons, headings.reasonsEnd, 'The WebMCP public guide');
  assert.match(publicGuide, /target_cancellation_unsupported/);
  assert.match(publicGuide, /WebMcpToolError/);
  assert.match(publicGuide, /webmcp-maintenance/);
  assert.match(maintainerGuide, /\/webmcp/);
  assert.match(maintainerGuide, /--test-concurrency=1/);
}

function homepageTools(): HomepageTool[] {
  const html = readFileSync(resolve(ROOT, 'pro-test/welcome.html'), 'utf8');
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1] ?? '')
    .find((body) => body.includes('document.modelContext'));
  const iife = script?.match(/\(function \(\) \{[\s\S]*?\}\)\(\);/)?.[0];
  assert.ok(iife, 'homepage WebMCP registration IIFE must exist');
  const tools: HomepageTool[] = [];
  const document = {
    modelContext: {
      registerTool(tool: HomepageTool) {
        tools.push(tool);
        return Promise.resolve();
      },
    },
    addEventListener() {},
  };
  const window = { location: { assign() {} }, addEventListener() {} };
  new Function('window', 'document', iife)(window, document);
  return tools;
}

describe('WebMCP canonical inventories', () => {
  it('locks exact homepage, SPA, and declarative namespaces', () => {
    assert.deepEqual(homepageTools().map(({ name }) => name), WEBMCP_HOMEPAGE_TOOL_NAMES);
    assert.deepEqual(
      buildWebMcpTools(createBindings(), () => {}).map(({ name }) => name),
      WEBMCP_SPA_TOOL_NAMES,
    );
    assert.deepEqual(WEBMCP_DECLARATIVE_TOOL_NAMES, ['search_procurement']);
    assert.equal(WEBMCP_PROCUREMENT_TOOL_NAME, 'search_procurement');

    const namespaceSets = [
      new Set(WEBMCP_HOMEPAGE_TOOL_NAMES),
      new Set(WEBMCP_SPA_TOOL_NAMES),
      new Set(WEBMCP_DECLARATIVE_TOOL_NAMES),
    ];
    for (let left = 0; left < namespaceSets.length; left += 1) {
      for (let right = left + 1; right < namespaceSets.length; right += 1) {
        assert.deepEqual(
          [...namespaceSets[left]!].filter((name) => namespaceSets[right]!.has(name as never)),
          [],
          `WebMCP namespaces ${left} and ${right} overlap`,
        );
      }
    }
  });

  it('keeps homepage metadata, schemas, annotations, and outputs inside the shared budgets', async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const tool of homepageTools()) {
      assert.ok(tool.name.length <= WEBMCP_TOOL_BUDGETS.nameChars, `${tool.name}: name`);
      assert.ok((tool.title?.length ?? 0) > 0, `${tool.name}: title is required`);
      assert.ok((tool.title?.length ?? 0) <= WEBMCP_TOOL_BUDGETS.titleChars, `${tool.name}: title`);
      assert.ok(tool.description.length <= WEBMCP_TOOL_BUDGETS.descriptionChars, `${tool.name}: description`);
      assert.ok(tool.annotations, `${tool.name}: annotations are required`);
      assert.ok(
        JSON.stringify(tool.inputSchema).length <= WEBMCP_TOOL_BUDGETS.inputSchemaJsonChars,
        `${tool.name}: input schema`,
      );
      const properties = tool.inputSchema.properties;
      if (properties && typeof properties === 'object') {
        for (const property of Object.values(properties)) {
          if (property && typeof property === 'object' && 'description' in property) {
            assert.ok(
              String(property.description).length <= WEBMCP_TOOL_BUDGETS.propertyDescriptionChars,
              `${tool.name}: property description`,
            );
          }
        }
      }
      const validate = ajv.compile(tool.inputSchema);
      const input = HOMEPAGE_VALID_INPUTS[tool.name]!;
      assert.equal(validate(input), true, `${tool.name}: ${ajv.errorsText(validate.errors)}`);
      const output = await tool.execute(input);
      const serialized = JSON.stringify(output);
      assert.equal(typeof serialized, 'string', `${tool.name}: output must be JSON serializable`);
      assert.ok(serialized.length <= WEBMCP_TOOL_BUDGETS.outputJsonChars, `${tool.name}: output`);
    }
  });

  it('snapshots all six fresh-default variant inventories', () => {
    assert.deepEqual(Object.keys(WEBMCP_VARIANT_INVENTORIES), SITE_VARIANTS);
    const expectedConditional = {
      full: ['search_procurement'],
      tech: ['search_procurement'],
      finance: ['search_procurement'],
      happy: [],
      commodity: [],
      energy: [],
    };

    for (const variant of SITE_VARIANTS) {
      const inventory = WEBMCP_VARIANT_INVENTORIES[variant];
      assert.deepEqual(inventory.spa, WEBMCP_SPA_TOOL_NAMES, variant);
      assert.deepEqual(inventory.conditionalDeclarative, expectedConditional[variant], variant);

      const procurementIsFreshDefault = (VARIANT_DEFAULTS[variant] ?? [])
        .includes('global-procurement')
        && getEffectivePanelConfig('global-procurement', variant).enabled === true;
      assert.equal(
        inventory.conditionalDeclarative.includes(WEBMCP_PROCUREMENT_TOOL_NAME),
        procurementIsFreshDefault,
        `${variant} inventory drifted from the real fresh panel defaults`,
      );

      const combined = [
        ...WEBMCP_HOMEPAGE_TOOL_NAMES,
        ...inventory.spa,
        ...inventory.conditionalDeclarative,
      ];
      assert.equal(new Set(combined).size, combined.length, `${variant} combined inventory has duplicates`);
    }
  });

  it('keeps both public and maintainer guides aligned with the canonical contract', () => {
    const guides = [
      {
        publicGuide: readFileSync(resolve(ROOT, 'docs/webmcp.mdx'), 'utf8'),
        maintainerGuide: readFileSync(resolve(ROOT, 'docs/webmcp-maintenance.mdx'), 'utf8'),
        headings: {
          homepage: '### Homepage tools',
          dashboard: '### Dashboard imperative tools',
          declarative: '### Declarative procurement tool',
          journeys: '## Common browser-agent journeys',
          cancellation: '### Host support and cancellation',
          cancellationEnd: '<Warning>',
          reasons: '### Panel layout and mission preset reasons',
          reasonsEnd: '## Human control and UI behavior',
          sourceMap: '## Source map',
          verification: '## Verification ladder',
          verificationEnd: '## Release smoke checklist',
        },
      },
      {
        publicGuide: readFileSync(resolve(ROOT, 'docs/zh/webmcp.mdx'), 'utf8'),
        maintainerGuide: readFileSync(resolve(ROOT, 'docs/zh/webmcp-maintenance.mdx'), 'utf8'),
        headings: {
          homepage: '### 首页工具',
          dashboard: '### 仪表板命令式工具',
          declarative: '### 声明式采购工具',
          journeys: '## 常见浏览器智能体流程',
          cancellation: '### 宿主支持与取消',
          cancellationEnd: '<Warning>',
          reasons: '### 面板布局与任务预设的拒绝原因',
          reasonsEnd: '## 人工控制与 UI 行为',
          sourceMap: '## 源文件图',
          verification: '## 验证阶梯',
          verificationEnd: '## 发布冒烟检查清单',
        },
      },
    ];

    for (const { publicGuide, maintainerGuide, headings } of guides) {
      assertGuideContract(publicGuide, maintainerGuide, headings);
    }
  });

  it('fails the guide contract when a row disappears, drifts, or cannot be extracted', () => {
    const publicGuide = readFileSync(resolve(ROOT, 'docs/webmcp.mdx'), 'utf8');
    const maintainerGuide = readFileSync(resolve(ROOT, 'docs/webmcp-maintenance.mdx'), 'utf8');
    const headings = {
      homepage: '### Homepage tools',
      dashboard: '### Dashboard imperative tools',
      declarative: '### Declarative procurement tool',
      journeys: '## Common browser-agent journeys',
      cancellation: '### Host support and cancellation',
      cancellationEnd: '<Warning>',
      reasons: '### Panel layout and mission preset reasons',
      reasonsEnd: '## Human control and UI behavior',
      sourceMap: '## Source map',
      verification: '## Verification ladder',
      verificationEnd: '## Release smoke checklist',
    };
    assert.throws(() => assertGuideContract(
      publicGuide.replace(/^\| `openSearch` .*$/m, ''),
      maintainerGuide,
      headings,
    ));
    assert.throws(() => assertGuideContract(
      publicGuide.replace(/^\| `view-state` .*$/m, ''),
      maintainerGuide,
      headings,
    ));
    assert.throws(() => assertGuideContract(
      publicGuide,
      maintainerGuide.replace(/^\| [^\n]*`src\/App\.ts`.*$/m, ''),
      headings,
    ));
    assert.throws(() =>
      assertGuideContract(
        publicGuide.replace('| Tool | Input schema | Behavior |', '| Tool | Input schema | Behavior |\n| `stale_tool` | Empty object | Stale entry. |'),
        maintainerGuide,
        headings,
      ),
    );
    assert.throws(() =>
      assertGuideContract(
        publicGuide.replace(/^\| `openSearch` (.*)$/m, '{/* | `openSearch` $1 */}'),
        maintainerGuide,
        headings,
      ),
    );
    assert.throws(() =>
      assertGuideContract(
        publicGuide,
        maintainerGuide.replace(/^\| ([^\n]*`src\/App\.ts`.*)$/m, '{/* | $1 */}'),
        headings,
      ),
    );
    assert.throws(() => assertGuideContract(
      publicGuide.replaceAll('`preset_incompatible`', 'preset-incompatible'),
      maintainerGuide,
      headings,
    ));
    assert.throws(() => assertGuideContract(
      publicGuide.replaceAll('`panel_fixed`', 'panel-fixed'),
      maintainerGuide,
      headings,
    ));
    assert.throws(() => assertGuideContract(
      publicGuide.replace(/^\| `unavailable` \| `open_mission_picker`.*$/m, ''),
      maintainerGuide,
      headings,
    ));
    assert.throws(() => assertGuideContract(
      publicGuide,
      maintainerGuide.replace('## Source map', '## Sources'),
      headings,
    ));
    assert.throws(() =>
      assertGuideContract(
        publicGuide,
        maintainerGuide.replace(/^\s{2}tests\/webmcp-dashboard\.test\.mts \\\n/m, ''),
        headings,
      ),
    );
  });
});

describe('WebMCP imperative schema and budget contract', () => {
  it('compiles every input schema under JSON Schema 2020-12 and accepts its canonical input', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const tools = buildWebMcpTools(createBindings(), () => {});
    for (const tool of tools) {
      const validate = ajv.compile(tool.inputSchema ?? {});
      assert.equal(
        validate(VALID_INPUTS[tool.name]),
        true,
        `${tool.name}: ${ajv.errorsText(validate.errors)}`,
      );
    }
    const open = tools.find((tool) => tool.name === 'open_dashboard_panel');
    const validateOpen = ajv.compile(open?.inputSchema ?? {});
    assert.equal(validateOpen({ panelId: 'regionalStartups' }), true, ajv.errorsText(validateOpen.errors));
    assert.equal(validateOpen({ panelId: 'gccNews' }), true, ajv.errorsText(validateOpen.errors));
  });

  it('applies uniform metadata, schema, output, and error budgets to all dashboard tools', async () => {
    const tools = buildWebMcpTools(createBindings(), () => {});
    for (const tool of tools) {
      assert.ok(tool.name.length <= WEBMCP_TOOL_BUDGETS.nameChars, `${tool.name}: name`);
      assert.ok((tool.title?.length ?? 0) > 0, `${tool.name}: title is required`);
      assert.ok((tool.title?.length ?? 0) <= WEBMCP_TOOL_BUDGETS.titleChars, `${tool.name}: title`);
      assert.ok(tool.description.length <= WEBMCP_TOOL_BUDGETS.descriptionChars, `${tool.name}: description`);
      assert.ok(
        JSON.stringify(tool.inputSchema).length <= WEBMCP_TOOL_BUDGETS.inputSchemaJsonChars,
        `${tool.name}: input schema`,
      );
      for (const property of Object.values(tool.inputSchema?.properties ?? {})) {
        if (property && typeof property === 'object' && 'description' in property) {
          assert.ok(
            String(property.description).length <= WEBMCP_TOOL_BUDGETS.propertyDescriptionChars,
            `${tool.name}: property description`,
          );
        }
      }

      const output = await tool.execute(VALID_INPUTS[tool.name]!);
      const serialized = JSON.stringify(output);
      assert.equal(typeof serialized, 'string', `${tool.name}: output must be JSON serializable`);
      assert.ok(serialized.length <= WEBMCP_TOOL_BUDGETS.outputJsonChars, `${tool.name}: output`);
    }

    const privateError = new Error(`PRIVATE_INTERNAL_${'x'.repeat(2_000)}`);
    const failing = buildWebMcpTools(createBindings({
      openCountryBriefByCode: async () => { throw privateError; },
      openSearch: async () => { throw privateError; },
      getDashboardContext: async () => { throw privateError; },
      listMapLayerCatalog: async () => { throw privateError; },
      listDashboardPanels: async () => { throw privateError; },
      switchMonitor: async () => { throw privateError; },
      openSettings: async () => { throw privateError; },
      openAlerts: async () => { throw privateError; },
      applyDashboardAction: async () => { throw privateError; },
      searchDashboard: async () => { throw privateError; },
      openSearchResult: async () => { throw privateError; },
      applyDashboardTabAction: async () => { throw privateError; },
      setPanelEnabled: async () => { throw privateError; },
      listMissionPresets: async () => { throw privateError; },
      applyMissionPreset: async () => { throw privateError; },
      openMissionPicker: async () => { throw privateError; },
      getPanelLayout: async () => { throw privateError; },
      setPanelCollapsed: async () => { throw privateError; },
      movePanel: async () => { throw privateError; },
      setPanelFullscreen: async () => { throw privateError; },
      getAccessContext: async () => { throw privateError; },
      openSignIn: async () => { throw privateError; },
    }), () => {});
    for (const tool of failing) {
      await assert.rejects(tool.execute(VALID_INPUTS[tool.name]!), (error: Error) => (
        error.name === 'WebMcpToolError'
        && error.message.length <= WEBMCP_TOOL_BUDGETS.errorMessageChars
        && !error.message.includes('PRIVATE_INTERNAL')
      ));
    }
  });

  it('bounds hostile country names before UI dispatch and output serialization', async () => {
    const calls: Array<{ code: string; country: string }> = [];
    const tool = buildWebMcpTools(createBindings({
      resolveCountryName: () => `HOSTILE_${'x'.repeat(5_000)}`,
      openCountryBriefByCode: async (code: string, country: string) => {
        calls.push({ code, country });
        return true;
      },
    }), () => {}).find(({ name }) => name === 'openCountryBrief')!;

    const output = await tool.execute({ iso2: 'DE' });
    assert.equal(calls[0]?.country.length, 160);
    assert.ok(String(output).length <= WEBMCP_TOOL_BUDGETS.outputJsonChars);
    assert.equal(String(output).includes('x'.repeat(161)), false);
  });
});
