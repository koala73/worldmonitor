import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WEBMCP_SPA_TOOL_NAMES,
} from '../src/config/webmcp.ts';
import {
  registerWebMcpTools,
} from '../src/services/webmcp.ts';
import { waitForWebMcpUiReady } from '../src/app/webmcp-dashboard.ts';
import {
  FakeWebMcpModelContext,
  createFakeWebMcpRuntime,
} from './helpers/fake-webmcp-model-context.mjs';

const settlePromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

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
      message: 'Applied dashboard action.',
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

function trackedRuntime(provider) {
  const events = [];
  const harness = createFakeWebMcpRuntime(
    provider,
    (event, data) => events.push({ event, data }),
  );
  return { ...harness, events };
}

async function executeRegistered(provider, name, inputJson = '{}') {
  const descriptor = (await provider.getTools()).find((tool) => tool.name === name);
  assert.ok(descriptor, `missing registered WebMCP tool ${name}`);
  return provider.executeTool(descriptor, inputJson);
}

describe('WebMCP registry behavioral contract', () => {
  it('keeps unsupported and obsolete providers silent', async () => {
    for (const provider of [undefined, { provideContext() {} }]) {
      const harness = trackedRuntime(provider);
      const controller = registerWebMcpTools(createBindings(), harness.runtime);
      assert.ok(controller);
      harness.dispatchDocument('DOMContentLoaded');
      harness.dispatchWindow('load');
      await settlePromises();
      assert.deepEqual(harness.events, []);
      controller.abort();
    }
  });

  it('registers synchronously, exposes sorted serialized schemas, and executes registered tools', async () => {
    const provider = new FakeWebMcpModelContext();
    const harness = trackedRuntime(provider);
    const opened = [];
    const controller = registerWebMcpTools(createBindings({
      openCountryBriefByCode: async (code, country) => opened.push({ code, country }),
    }), harness.runtime);

    assert.deepEqual(
      provider.registrationCalls.map(({ tool }) => tool.name),
      WEBMCP_SPA_TOOL_NAMES,
      'registration calls must start before registerWebMcpTools returns',
    );
    assert.ok(provider.registrationCalls.every(({ signal }) => signal === controller.signal));
    await settlePromises();

    const registered = await provider.getTools();
    assert.deepEqual(
      registered.map(({ name }) => name),
      [...WEBMCP_SPA_TOOL_NAMES].sort((left, right) => left.localeCompare(right)),
    );
    for (const registeredTool of registered) {
      const original = provider.registrationCalls
        .find(({ tool }) => tool.name === registeredTool.name).tool;
      assert.deepEqual(JSON.parse(registeredTool.inputSchema), original.inputSchema);
      assert.equal('execute' in registeredTool, false);
    }

    const result = await executeRegistered(
      provider,
      'openCountryBrief',
      JSON.stringify({ iso2: 'de' }),
    );
    assert.equal(result, 'Opened intelligence brief for Country DE (DE).');
    assert.deepEqual(opened, [{ code: 'DE', country: 'Country DE' }]);
    assert.deepEqual(harness.events, [
      {
        event: 'webmcp-registered',
        data: { toolCount: 8, pageSurface: 'dashboard', api: 'document-current' },
      },
      {
        event: 'webmcp-tool-invoked',
        data: { tool: 'openCountryBrief', outcome: 'success', reason: 'completed' },
      },
    ]);
  });

  it('reports duplicate, disallowed, rejected, and host-aborted registrations by closed reason', async () => {
    const failures = new Map([
      ['openCountryBrief', new DOMException('duplicate detail', 'InvalidStateError')],
      ['openSearch', new DOMException('policy detail', 'NotAllowedError')],
      ['get_dashboard_context', new DOMException('origin detail', 'SecurityError')],
      ['open_dashboard_panel', new TypeError('schema detail')],
      ['set_map_view', new DOMException('host cancellation detail', 'AbortError')],
    ]);
    const provider = new FakeWebMcpModelContext({ registrationFailure: failures });
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings(), harness.runtime);
    await settlePromises();

    assert.deepEqual(harness.events.slice(0, 5), [
      { event: 'webmcp-registration-failed', data: { tool: 'openCountryBrief', reason: 'invalid-state' } },
      { event: 'webmcp-registration-failed', data: { tool: 'openSearch', reason: 'not-allowed' } },
      { event: 'webmcp-registration-failed', data: { tool: 'get_dashboard_context', reason: 'security' } },
      { event: 'webmcp-registration-failed', data: { tool: 'open_dashboard_panel', reason: 'invalid-tool' } },
      { event: 'webmcp-registration-failed', data: { tool: 'set_map_view', reason: 'aborted' } },
    ]);
    assert.deepEqual(harness.events.at(-1), {
      event: 'webmcp-registered',
      data: { toolCount: 3, pageSurface: 'dashboard', api: 'document-current' },
    });
    assert.equal(JSON.stringify(harness.events).includes('detail'), false);
  });

  it('aborts before a late provider can register', async () => {
    const harness = trackedRuntime(undefined);
    const controller = registerWebMcpTools(createBindings(), harness.runtime);
    controller.abort();
    const provider = new FakeWebMcpModelContext();
    harness.document.modelContext = provider;

    assert.equal(harness.dispatchDocument('DOMContentLoaded'), false);
    assert.equal(harness.dispatchWindow('load'), false);
    await settlePromises();
    assert.equal(provider.registrationCalls.length, 0);
    assert.deepEqual(harness.events, []);
  });

  it('aborts registrations while the provider still has them pending', async () => {
    const provider = new FakeWebMcpModelContext({ deferAllRegistrations: true });
    const harness = trackedRuntime(provider);
    const controller = registerWebMcpTools(createBindings(), harness.runtime);

    assert.deepEqual(provider.pendingRegistrationNames, [...WEBMCP_SPA_TOOL_NAMES].sort());
    controller.abort();
    await settlePromises();
    assert.deepEqual(provider.pendingRegistrationNames, []);
    assert.deepEqual(await provider.getTools(), []);
    assert.deepEqual(harness.events, []);
  });

  it('unregisters after acceptance and permits same-document re-initialization', async () => {
    const provider = new FakeWebMcpModelContext();
    const first = trackedRuntime(provider);
    const firstController = registerWebMcpTools(createBindings(), first.runtime);
    await settlePromises();
    const firstTools = await provider.getTools();
    assert.equal(firstTools.length, WEBMCP_SPA_TOOL_NAMES.length);

    firstController.abort();
    assert.deepEqual(await provider.getTools(), []);
    await assert.rejects(
      provider.executeTool(firstTools[0], '{}'),
      (error) => error.name === 'InvalidStateError',
    );

    const second = trackedRuntime(provider);
    const secondController = registerWebMcpTools(createBindings(), second.runtime);
    await settlePromises();
    assert.equal((await provider.getTools()).length, WEBMCP_SPA_TOOL_NAMES.length);
    assert.equal(
      second.events.some(({ event }) => event === 'webmcp-registration-failed'),
      false,
    );
    secondController.abort();
  });
});

describe('registered WebMCP readiness behavior', () => {
  it('keeps a pre-ready invocation pending and resumes through the registered definition', async () => {
    const ready = deferred();
    const destroyed = new Promise(() => {});
    let opened = false;
    const provider = new FakeWebMcpModelContext();
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      openSearch: async () => {
        await waitForWebMcpUiReady(ready.promise, destroyed, 1_000);
        opened = true;
      },
    }), harness.runtime);
    await settlePromises();

    let settled = false;
    const invocation = executeRegistered(provider, 'openSearch').then((result) => {
      settled = true;
      return result;
    });
    await settlePromises();
    assert.equal(settled, false);
    assert.equal(opened, false);

    ready.resolve();
    assert.equal(await invocation, 'Opened search palette.');
    assert.equal(opened, true);
  });

  it('turns readiness timeout into a bounded, privacy-safe tool failure', async () => {
    const never = new Promise(() => {});
    const provider = new FakeWebMcpModelContext();
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      openSearch: () => waitForWebMcpUiReady(never, never, 5),
    }), harness.runtime);
    await settlePromises();

    await assert.rejects(
      executeRegistered(provider, 'openSearch'),
      (error) => error.name === 'WebMcpToolError'
        && error.message === 'World Monitor could not open search.'
        && !error.message.includes('5ms'),
    );
    assert.deepEqual(harness.events.at(-1), {
      event: 'webmcp-tool-invoked',
      data: { tool: 'openSearch', outcome: 'failure', reason: 'internal' },
    });
  });

  it('wakes a pre-ready invocation on teardown and removes its registered definition', async () => {
    const ready = new Promise(() => {});
    const destroyed = deferred();
    const provider = new FakeWebMcpModelContext();
    const harness = trackedRuntime(provider);
    const controller = registerWebMcpTools(createBindings({
      openSearch: () => waitForWebMcpUiReady(ready, destroyed.promise, 1_000),
    }), harness.runtime);
    await settlePromises();

    const invocation = executeRegistered(provider, 'openSearch');
    destroyed.resolve();
    await assert.rejects(invocation, /World Monitor could not open search/);
    controller.abort();
    assert.deepEqual(await provider.getTools(), []);
  });
});
