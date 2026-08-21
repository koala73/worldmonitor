import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { buildWebMcpTools } from '../src/services/webmcp.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function createBindings(overrides: Record<string, unknown> = {}) {
  return {
    openCountryBriefByCode: async () => {},
    resolveCountryName: (code: string) => `Country ${code}`,
    openSearch: async () => {},
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
    ...overrides,
  };
}

const VALID_INPUTS: Record<string, Record<string, unknown>> = {
  openCountryBrief: { iso2: 'DE' },
  openSearch: {},
  get_dashboard_context: {},
  open_dashboard_panel: { panelId: 'markets' },
  set_map_view: { view: 'eu', zoom: 4 },
  set_map_layers: { layers: { weather: true } },
  search_dashboard: { query: 'germany' },
  open_search_result: { resultKey: `sr_${'a'.repeat(32)}` },
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
});

describe('WebMCP imperative schema and budget contract', () => {
  it('compiles every input schema under JSON Schema 2020-12 and accepts its canonical input', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const tool of buildWebMcpTools(createBindings(), () => {})) {
      const validate = ajv.compile(tool.inputSchema ?? {});
      assert.equal(
        validate(VALID_INPUTS[tool.name]),
        true,
        `${tool.name}: ${ajv.errorsText(validate.errors)}`,
      );
    }
  });

  it('applies uniform metadata, schema, output, and error budgets to all eight tools', async () => {
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
      applyDashboardAction: async () => { throw privateError; },
      searchDashboard: async () => { throw privateError; },
      openSearchResult: async () => { throw privateError; },
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
      },
    }), () => {}).find(({ name }) => name === 'openCountryBrief')!;

    const output = await tool.execute({ iso2: 'DE' });
    assert.equal(calls[0]?.country.length, 160);
    assert.ok(String(output).length <= WEBMCP_TOOL_BUDGETS.outputJsonChars);
    assert.equal(String(output).includes('x'.repeat(161)), false);
  });
});
