import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { CONTENT_ATTRIBUTION_STORAGE_KEY } from '../shared/content-attribution.ts';
import { FakeWebMcpModelContext } from './helpers/fake-webmcp-model-context.mjs';
import { resetAnalyticsForTesting } from '../src/services/analytics.ts';
import {
  DashboardBindingError,
  buildWebMcpTools,
  registerWebMcpTools,
} from '../src/services/webmcp.ts';

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, value); }
  removeItem(key) { this.#values.delete(key); }
}

const settlePromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

function createBindings(overrides = {}) {
  return {
    openCountryBriefByCode: async () => {},
    resolveCountryName: (code) => `Country ${code}`,
    openSearch: async () => {},
    getDashboardContext: async () => ({
      variant: 'full',
      map: {
        view: 'global',
        center: { lat: 0, lon: 0 },
        zoom: 2,
        timeRange: '7d',
        enabledLayers: [],
      },
      panels: { mounted: ['map'], enabled: ['map'] },
    }),
    applyDashboardAction: async (action) => ({
      ok: true,
      status: 'applied',
      actionType: action.type,
      message: 'Applied.',
      targets: [],
    }),
    searchDashboard: async (query) => ({
      queryLength: query.length,
      results: [],
      resultCount: 0,
      truncated: false,
    }),
    openSearchResult: async () => ({ ok: true, status: 'opened' }),
    ...overrides,
  };
}

async function executeRegistered(provider, name, inputJson = '{}') {
  const descriptor = (await provider.getTools()).find((tool) => tool.name === name);
  assert.ok(descriptor, `missing registered WebMCP tool ${name}`);
  return provider.executeTool(descriptor, inputJson);
}

afterEach(() => {
  delete globalThis.window;
  delete globalThis.location;
  resetAnalyticsForTesting();
});

describe('WebMCP analytics privacy policy', () => {
  it('uses the privacy-restricted collector path and permits only explicit allowlisted fields', async () => {
    const storage = new MemoryStorage();
    storage.setItem(CONTENT_ATTRIBUTION_STORAGE_KEY, JSON.stringify({
      source: 'PRIVATE_CONTENT_SOURCE',
      medium: 'PRIVATE_CONTENT_MEDIUM',
      campaign: 'PRIVATE_CONTENT_CAMPAIGN',
      destination: 'dashboard',
      placement: 'PRIVATE_CONTENT_PLACEMENT',
      landingPageFamily: 'PRIVATE_LANDING_FAMILY',
      capturedAt: Date.now(),
    }));
    const collected = [];
    const runtimeWindow = {
      sessionStorage: storage,
      localStorage: storage,
      addEventListener() {},
      umami: {
        track: (event, data) => { collected.push({ event, data }); },
        identify() {},
      },
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: runtimeWindow,
    });
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hostname: 'worldmonitor.app' },
    });

    resetAnalyticsForTesting();
    const provider = new FakeWebMcpModelContext({
      registrationFailure: new Map([
        ['set_map_view', new DOMException('PRIVATE_HOST_FAILURE', 'AbortError')],
      ]),
    });
    const document = { modelContext: provider, addEventListener() {} };
    registerWebMcpTools(createBindings({
      searchDashboard: async (query) => ({
        queryLength: query.length,
        results: [{
          key: `sr_${'a'.repeat(32)}`,
          type: 'PRIVATE_UNBOUNDED_RESULT_TYPE',
          title: 'PRIVATE_RESULT_TITLE',
          subtitle: 'PRIVATE_RESULT_SUBTITLE',
          executable: true,
        }],
        resultCount: 1,
        truncated: false,
      }),
      openSearchResult: async () => ({
        ok: false,
        status: 'denied',
        reason: 'result_no_longer_available',
      }),
    }), { document, window: runtimeWindow });
    await settlePromises();

    await executeRegistered(provider, 'openSearch');
    await executeRegistered(provider, 'search_dashboard', JSON.stringify({
      query: 'PRIVATE_QUERY_TEXT',
      scope: 'all',
      limit: 1,
    }));
    await executeRegistered(provider, 'open_search_result', JSON.stringify({
      resultKey: `sr_${'a'.repeat(32)}`,
    }));

    const allowlistedKeys = {
      'webmcp-registered': new Set(['toolCount', 'pageSurface', 'api']),
      'webmcp-registration-failed': new Set(['tool', 'reason']),
      'webmcp-tool-invoked': new Set([
        'tool', 'outcome', 'reason', 'queryLength', 'resultCount', 'resultTypes',
      ]),
    };
    for (const call of collected) {
      assert.ok(allowlistedKeys[call.event], call.event);
      assert.ok(
        Object.keys(call.data ?? {}).every((key) => allowlistedKeys[call.event].has(key)),
        `${call.event} contained a non-allowlisted field`,
      );
    }

    assert.deepEqual(
      collected.find(({ event }) => event === 'webmcp-registered'),
      {
        event: 'webmcp-registered',
        data: { toolCount: 7, pageSurface: 'dashboard', api: 'document-current' },
      },
    );
    assert.deepEqual(
      collected.find(({ event }) => event === 'webmcp-registration-failed'),
      {
        event: 'webmcp-registration-failed',
        data: { tool: 'set_map_view', reason: 'aborted' },
      },
    );
    assert.deepEqual(
      collected.find(({ data }) => data?.tool === 'search_dashboard'),
      {
        event: 'webmcp-tool-invoked',
        data: {
          tool: 'search_dashboard',
          outcome: 'success',
          reason: 'completed',
          queryLength: 18,
          resultCount: 1,
          resultTypes: ['other'],
        },
      },
    );
    assert.deepEqual(
      collected.find(({ data }) => data?.tool === 'open_search_result'),
      {
        event: 'webmcp-tool-invoked',
        data: { tool: 'open_search_result', outcome: 'denied', reason: 'stale' },
      },
    );

    const serialized = JSON.stringify(collected);
    for (const privateValue of [
      'PRIVATE_CONTENT',
      'PRIVATE_QUERY_TEXT',
      'PRIVATE_UNBOUNDED_RESULT_TYPE',
      'PRIVATE_RESULT_TITLE',
      'PRIVATE_RESULT_SUBTITLE',
      'PRIVATE_HOST_FAILURE',
      `sr_${'a'.repeat(32)}`,
      'result_no_longer_available',
    ]) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
  });

  it('maps success, validation, entitlement, unavailable, stale, cancellation, and internal outcomes', async () => {
    const events = [];
    const tools = buildWebMcpTools(createBindings({
      openSearch: async () => { throw new DOMException('cancelled by host', 'AbortError'); },
      getDashboardContext: async () => {
        throw new DashboardBindingError('map_unavailable', 'Map unavailable.');
      },
      applyDashboardAction: async (action) => action.panelId === 'premium'
        ? ({
            ok: false,
            status: 'denied',
            reason: 'panel_not_entitled',
            message: 'Denied.',
            targets: [{ target: 'premium', status: 'denied', reason: 'panel_not_entitled' }],
          })
        : ({
            ok: false,
            status: 'denied',
            reason: 'panel_not_live',
            message: 'Unavailable.',
            targets: [],
          }),
      openSearchResult: async () => ({
        ok: false,
        status: 'denied',
        reason: 'search_state_changed',
      }),
      searchDashboard: async () => { throw new Error('private internal failure'); },
    }), (event, data) => events.push({ event, data }));

    await tools.find(({ name }) => name === 'openCountryBrief').execute({ iso2: 'DE' });
    await assert.rejects(
      tools.find(({ name }) => name === 'openCountryBrief').execute({ iso2: 'USA' }),
    );
    await assert.rejects(
      tools.find(({ name }) => name === 'openSearch').execute({}),
      (error) => error.name === 'AbortError',
    );
    await assert.rejects(tools.find(({ name }) => name === 'get_dashboard_context').execute({}));
    await tools.find(({ name }) => name === 'open_dashboard_panel')
      .execute({ panelId: 'premium' });
    await tools.find(({ name }) => name === 'open_dashboard_panel')
      .execute({ panelId: 'missing' });
    await tools.find(({ name }) => name === 'open_search_result')
      .execute({ resultKey: `sr_${'b'.repeat(32)}` });
    await tools.find(({ name }) => name === 'open_search_result')
      .execute({ resultKey: `sr_${'c'.repeat(32)}`, extra: true });
    await assert.rejects(
      tools.find(({ name }) => name === 'search_dashboard').execute({ query: 'safe' }),
    );

    assert.deepEqual(events.map(({ data }) => [data.outcome, data.reason]), [
      ['success', 'completed'],
      ['failure', 'validation'],
      ['failure', 'cancelled'],
      ['failure', 'unavailable'],
      ['denied', 'entitlement'],
      ['denied', 'unavailable'],
      ['denied', 'stale'],
      ['denied', 'validation'],
      ['failure', 'internal'],
    ]);
    assert.deepEqual(
      [...new Set(events.map(({ data }) => data.outcome))].sort(),
      ['denied', 'failure', 'success'],
    );
    assert.ok(events.every(({ data }) => (
      ['completed', 'validation', 'entitlement', 'unavailable', 'stale', 'cancelled', 'internal']
        .includes(data.reason)
    )));
  });
});
