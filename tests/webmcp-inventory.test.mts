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
} from '../src/config/webmcp.ts';
import { SITE_VARIANTS } from '../src/config/variant.ts';
import {
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
} from '../src/config/panels.ts';
import { buildWebMcpTools as buildProductionWebMcpTools } from '../src/services/webmcp.ts';

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
    applyDashboardAction: async (action: { type: 'open_panel' | 'set_view' | 'set_layers' }) => ({
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
  set_map_view: { view: 'eu', zoom: 4 },
  set_map_layers: { layers: { weather: true } },
  search_dashboard: { query: 'germany' },
  open_search_result: { resultKey: `sr_${'a'.repeat(32)}` },
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
  'src/App.ts',
  'src/app/webmcp-dashboard.ts',
  'src/app/webmcp-access.ts',
  'src/services/webmcp-access-snapshot.ts',
  'src/app/webmcp-search-controller.ts',
  'src/app/webmcp-search-effects.ts',
  'src/app/search-selection-dispatcher.ts',
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
  'tests/webmcp-panel-catalog.test.mts',
  'tests/webmcp-runtime.test.mjs',
  'tests/webmcp-analytics-policy.test.mjs',
  'tests/webmcp-evals.test.mjs',
  'tests/webmcp-access.test.mts',
  'tests/deploy-config.test.mjs',
] as const;

function sectionBetween(guide: string, startHeading: string, endHeading: string): string {
  const start = guide.indexOf(startHeading);
  const end = guide.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(start, -1, `public WebMCP guide is missing ${startHeading}`);
  assert.notEqual(end, -1, `public WebMCP guide is missing ${endHeading}`);
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
  guide: string,
  headings: {
    homepage: string;
    dashboard: string;
    declarative: string;
    journeys: string;
    sourceMap: string;
    verification: string;
    verificationEnd: string;
  },
) {
  assert.deepEqual(
    renderedTableNames(sectionBetween(guide, headings.homepage, headings.dashboard)),
    WEBMCP_HOMEPAGE_TOOL_NAMES,
  );
  assert.deepEqual(
    renderedTableNames(sectionBetween(guide, headings.dashboard, headings.declarative)),
    WEBMCP_SPA_TOOL_NAMES,
  );
  assert.deepEqual(
    renderedTableNames(sectionBetween(guide, headings.declarative, headings.journeys)),
    WEBMCP_DECLARATIVE_TOOL_NAMES,
  );

  const sourceMap = visibleMdx(sectionBetween(guide, headings.sourceMap, headings.verification));
  const sourcePaths = [...sourceMap.matchAll(/^\| ([^|]+) \|/gm)].flatMap((row) =>
    [...(row[1] ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1]),
  );
  assert.deepEqual(sourcePaths, WEBMCP_MAINTAINER_SOURCES);
  for (const source of sourcePaths) assertMaintainerSourceExists(source);
  const verification = sectionBetween(guide, headings.verification, headings.verificationEnd);
  const focusedTestPaths = [...verification.matchAll(/^\s{2}(tests\/[^\s\\]+)(?:\s+\\)?$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(focusedTestPaths, WEBMCP_FOCUSED_VERIFICATION_TESTS);
  assert.match(guide, /target_cancellation_unsupported/);
  assert.match(guide, /WebMcpToolError/);
  assert.match(guide, /--test-concurrency=1/);
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

  it('keeps both public guides aligned with the canonical inventory and maintainer map', () => {
    const guides = [
      {
        guide: readFileSync(resolve(ROOT, 'docs/webmcp.mdx'), 'utf8'),
        headings: {
          homepage: '### Homepage tools',
          dashboard: '### Dashboard imperative tools',
          declarative: '### Declarative procurement tool',
          journeys: '## Common browser-agent journeys',
          sourceMap: '### Source map',
          verification: '### Verification ladder',
          verificationEnd: '## Compatibility and removal policy',
        },
      },
      {
        guide: readFileSync(resolve(ROOT, 'docs/zh/webmcp.mdx'), 'utf8'),
        headings: {
          homepage: '### 首页工具',
          dashboard: '### 仪表板命令式工具',
          declarative: '### 声明式采购工具',
          journeys: '## 常见浏览器智能体流程',
          sourceMap: '### 源文件图',
          verification: '### 验证阶梯',
          verificationEnd: '## 兼容与移除策略',
        },
      },
    ];

    for (const { guide, headings } of guides) {
      assertGuideContract(guide, headings);
    }
  });

  it('fails the guide contract when a row disappears, drifts, or cannot be extracted', () => {
    const guide = readFileSync(resolve(ROOT, 'docs/webmcp.mdx'), 'utf8');
    const headings = {
      homepage: '### Homepage tools',
      dashboard: '### Dashboard imperative tools',
      declarative: '### Declarative procurement tool',
      journeys: '## Common browser-agent journeys',
      sourceMap: '### Source map',
      verification: '### Verification ladder',
      verificationEnd: '## Compatibility and removal policy',
    };
    assert.throws(() => assertGuideContract(guide.replace(/^\| `openSearch` .*$/m, ''), headings));
    assert.throws(() => assertGuideContract(guide.replace(/^\| `src\/App\.ts` .*$/m, ''), headings));
    assert.throws(() =>
      assertGuideContract(
        guide.replace('| Tool | Input schema | Behavior |', '| Tool | Input schema | Behavior |\n| `stale_tool` | Empty object | Stale entry. |'),
        headings,
      ),
    );
    assert.throws(() =>
      assertGuideContract(
        guide.replace(/^\| `openSearch` (.*)$/m, '{/* | `openSearch` $1 */}'),
        headings,
      ),
    );
    assert.throws(() =>
      assertGuideContract(
        guide.replace(/^\| `src\/App\.ts` (.*)$/m, '{/* | `src/App.ts` $1 */}'),
        headings,
      ),
    );
    assert.throws(() => assertGuideContract(guide.replace('### Source map', '### Sources'), headings));
    assert.throws(() =>
      assertGuideContract(guide.replace(/^\s{2}tests\/webmcp-dashboard\.test\.mts \\\n/m, ''), headings),
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
