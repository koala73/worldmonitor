import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildWebMcpTools,
  registerWebMcpTools,
} from '../src/services/webmcp.ts';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const WEBMCP_PATH = resolve(ROOT, 'src/services/webmcp.ts');
const src = readFileSync(WEBMCP_PATH, 'utf-8');

const settlePromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
};

function createBindings(overrides = {}) {
  return {
    openCountryBriefByCode: async () => {},
    resolveCountryName: (code) => `Country ${code}`,
    openSearch: async () => {},
    ...overrides,
  };
}

function createRegistrationRuntime(provider) {
  const listeners = new Map();
  const windowListeners = new Map();
  const events = [];
  const document = {
    modelContext: provider,
    addEventListener(type, listener, options) {
      listeners.set(type, listener);
      options?.signal?.addEventListener('abort', () => listeners.delete(type), { once: true });
    },
  };
  const window = {
    addEventListener(type, listener, options) {
      windowListeners.set(type, listener);
      options?.signal?.addEventListener('abort', () => windowListeners.delete(type), { once: true });
    },
  };
  const runtime = {
    document,
    window,
    track: (event, data) => events.push({ event, data }),
  };
  return { runtime, document, events, listeners, windowListeners };
}

describe('webmcp.ts: current API contract', () => {
  it('uses document.modelContext and removes both navigator and provideContext paths', () => {
    assert.match(src, /runtimeDocument\.modelContext/);
    assert.doesNotMatch(src, /navigator\.modelContext/);
    assert.doesNotMatch(src, /provideContext/);
  });

  it('uses the official ambient WebMCP declarations', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    const tsconfig = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf-8'));
    assert.match(pkg.devDependencies['webmcp-types'], /^\^0\.1\.3$/);
    assert.ok(tsconfig.compilerOptions.types.includes('webmcp-types'));
    assert.match(src, /WebMCP\.ModelContextTool/);
    assert.doesNotMatch(src, /interface WebMcpProvider/);
  });

  it('ships bounded current-API metadata and explicit annotations', () => {
    const tools = buildWebMcpTools(createBindings(), () => {});
    assert.ok(tools.length >= 2);
    for (const tool of tools) {
      assert.ok(tool.name.length <= 30, `${tool.name}: name exceeds Chrome guidance`);
      assert.ok(tool.description.length <= 500, `${tool.name}: description exceeds Chrome guidance`);
      assert.equal(typeof tool.title, 'string');
      assert.ok(tool.title.length > 0);
      assert.equal(tool.annotations?.readOnlyHint, false);
      const properties = tool.inputSchema?.properties ?? {};
      for (const property of Object.values(properties)) {
        if (property && typeof property === 'object' && 'description' in property) {
          assert.ok(property.description.length <= 150);
        }
      }
    }
  });
});

describe('webmcp.ts: native tool execution and telemetry', () => {
  it('returns native strings and logs only closed-vocabulary outcome fields', async () => {
    const calls = [];
    const events = [];
    const tools = buildWebMcpTools(createBindings({
      openCountryBriefByCode: async (code, country) => calls.push({ code, country }),
    }), (event, data) => events.push({ event, data }));

    const result = await tools.find((tool) => tool.name === 'openCountryBrief').execute({ iso2: 'de' });
    assert.equal(result, 'Opened intelligence brief for Country DE (DE).');
    assert.deepEqual(calls, [{ code: 'DE', country: 'Country DE' }]);
    assert.deepEqual(events, [{
      event: 'webmcp-tool-invoked',
      data: { tool: 'openCountryBrief', outcome: 'success' },
    }]);
    assert.deepEqual(Object.keys(events[0].data).sort(), ['outcome', 'tool']);
  });

  it('rejects invalid input with a safe bounded error', async () => {
    const events = [];
    const tools = buildWebMcpTools(createBindings(), (event, data) => events.push({ event, data }));
    const tool = tools.find((candidate) => candidate.name === 'openCountryBrief');
    await assert.rejects(
      tool.execute({ iso2: 'USA' }),
      (error) => error.name === 'WebMcpToolError'
        && error.message === 'iso2 must be an ISO 3166-1 alpha-2 code, such as "DE" or "IR".'
        && error.message.length < 150,
    );
    assert.deepEqual(events, [{
      event: 'webmcp-tool-invoked',
      data: { tool: 'openCountryBrief', outcome: 'failure' },
    }]);
  });

  it('does not expose internal exception content to the agent', async () => {
    const events = [];
    const tools = buildWebMcpTools(createBindings({
      openSearch: async () => { throw new Error('secret internal UI state'); },
    }), (event, data) => events.push({ event, data }));
    const tool = tools.find((candidate) => candidate.name === 'openSearch');
    await assert.rejects(
      tool.execute({}),
      (error) => error.name === 'WebMcpToolError'
        && error.message === 'World Monitor could not open search.'
        && !error.message.includes('secret'),
    );
    assert.deepEqual(events, [{
      event: 'webmcp-tool-invoked',
      data: { tool: 'openSearch', outcome: 'failure' },
    }]);
  });
});

describe('webmcp.ts: promise registration lifecycle', () => {
  it('starts every registration synchronously and counts only fulfilled tools', async () => {
    const registrations = [];
    const provider = {
      registerTool(tool, options) {
        registrations.push({ tool, signal: options.signal });
        return Promise.resolve();
      },
    };
    const harness = createRegistrationRuntime(provider);
    const controller = registerWebMcpTools(createBindings(), harness.runtime);

    assert.ok(controller);
    assert.deepEqual(registrations.map(({ tool }) => tool.name), ['openCountryBrief', 'openSearch']);
    assert.ok(registrations.every(({ signal }) => signal === controller.signal));
    assert.deepEqual(harness.events, [], 'registration must not be reported before fulfillment');

    await settlePromises();
    assert.deepEqual(harness.events, [{
      event: 'webmcp-registered',
      data: { toolCount: 2, api: 'registerTool' },
    }]);

    controller.abort();
    assert.ok(registrations.every(({ signal }) => signal.aborted));
  });

  it('drains duplicate-name rejection and reports only a bounded reason', async () => {
    const provider = {
      registerTool(tool) {
        if (tool.name === 'openCountryBrief') {
          return Promise.reject(new DOMException('raw duplicate detail', 'InvalidStateError'));
        }
        return Promise.resolve();
      },
    };
    const harness = createRegistrationRuntime(provider);
    registerWebMcpTools(createBindings(), harness.runtime);
    await settlePromises();

    assert.deepEqual(harness.events, [
      {
        event: 'webmcp-registration-failed',
        data: { tool: 'openCountryBrief', reason: 'invalid-state' },
      },
      {
        event: 'webmcp-registered',
        data: { toolCount: 1, api: 'registerTool' },
      },
    ]);
    assert.ok(!JSON.stringify(harness.events).includes('raw duplicate detail'));
  });

  it('never emits webmcp-registered when every registration rejects', async () => {
    const provider = {
      registerTool() {
        return Promise.reject(new DOMException('disabled', 'NotAllowedError'));
      },
    };
    const harness = createRegistrationRuntime(provider);
    registerWebMcpTools(createBindings(), harness.runtime);
    await settlePromises();

    assert.equal(
      harness.events.some(({ event }) => event === 'webmcp-registered'),
      false,
    );
    assert.equal(
      harness.events.filter(({ event }) => event === 'webmcp-registration-failed').length,
      2,
    );
  });

  it('contains hostile rejection values instead of creating an unhandled rejection', async () => {
    const hostileReason = new Proxy({}, {
      has: () => true,
      get: () => { throw new Error('hostile error getter'); },
    });
    const provider = {
      registerTool() { return Promise.reject(hostileReason); },
    };
    const harness = createRegistrationRuntime(provider);
    registerWebMcpTools(createBindings(), harness.runtime);
    await settlePromises();
    assert.deepEqual(
      harness.events.map(({ data }) => data.reason),
      ['unknown', 'unknown'],
    );
  });

  it('does not publish a registration that loses the abort race', async () => {
    const pending = [];
    const signals = [];
    const provider = {
      registerTool(_tool, options) {
        signals.push(options.signal);
        return new Promise((resolvePromise) => pending.push(resolvePromise));
      },
    };
    const harness = createRegistrationRuntime(provider);
    const controller = registerWebMcpTools(createBindings(), harness.runtime);
    controller.abort();
    pending.forEach((resolvePromise) => resolvePromise());
    await settlePromises();

    assert.ok(signals.every((signal) => signal.aborted));
    assert.deepEqual(harness.events, []);
  });

  it('unregisters accepted tools before a same-document re-init', async () => {
    const liveTools = new Set();
    const provider = {
      registerTool(tool, options) {
        if (liveTools.has(tool.name)) {
          return Promise.reject(new DOMException('duplicate', 'InvalidStateError'));
        }
        liveTools.add(tool.name);
        options.signal.addEventListener('abort', () => liveTools.delete(tool.name), { once: true });
        return Promise.resolve();
      },
    };

    const first = createRegistrationRuntime(provider);
    const firstController = registerWebMcpTools(createBindings(), first.runtime);
    await settlePromises();
    assert.deepEqual([...liveTools], ['openCountryBrief', 'openSearch']);
    firstController.abort();
    assert.deepEqual([...liveTools], []);

    const second = createRegistrationRuntime(provider);
    registerWebMcpTools(createBindings(), second.runtime);
    await settlePromises();
    assert.deepEqual([...liveTools], ['openCountryBrief', 'openSearch']);
    assert.equal(
      second.events.some(({ event }) => event === 'webmcp-registration-failed'),
      false,
    );
  });

  it('registers once when the provider appears at DOM readiness', async () => {
    const registrations = [];
    const harness = createRegistrationRuntime(undefined);
    const controller = registerWebMcpTools(createBindings(), harness.runtime);
    assert.ok(controller);
    assert.equal(typeof harness.listeners.get('DOMContentLoaded'), 'function');

    harness.document.modelContext = {
      registerTool(tool) {
        registrations.push(tool.name);
        return Promise.resolve();
      },
    };
    harness.listeners.get('DOMContentLoaded')();
    harness.windowListeners.get('load')();
    assert.deepEqual(registrations, ['openCountryBrief', 'openSearch']);
    await settlePromises();
    assert.equal(harness.events.at(-1).data.toolCount, 2);
  });

  it('ignores a provider that exposes only the removed batch API', () => {
    let provideCalls = 0;
    const harness = createRegistrationRuntime({
      provideContext() { provideCalls += 1; },
    });
    const controller = registerWebMcpTools(createBindings(), harness.runtime);
    assert.equal(provideCalls, 0);
    assert.equal(typeof harness.listeners.get('DOMContentLoaded'), 'function');
    controller.abort();
    assert.equal(harness.listeners.size, 0);
    assert.equal(harness.windowListeners.size, 0);
  });

  it('keeps a throwing optional provider getter from breaking page initialization', () => {
    const listeners = [];
    const runtimeDocument = {
      get modelContext() { throw new Error('broken polyfill'); },
      addEventListener(type) { listeners.push(type); },
    };
    let controller;
    assert.doesNotThrow(() => {
      controller = registerWebMcpTools(createBindings(), {
        document: runtimeDocument,
        window: { addEventListener: (type) => listeners.push(type) },
        track: () => {},
      });
    });
    assert.ok(controller);
    assert.deepEqual(listeners, ['DOMContentLoaded', 'load']);
  });
});

// Homepage WebMCP — the apex `/` serves the static pro-test welcome page,
// not the dashboard SPA, so it carries its own zero-import registration.
describe('homepage WebMCP registration', () => {
  const welcomeSrc = readFileSync(resolve(ROOT, 'pro-test/welcome.html'), 'utf-8');
  const welcomeBuilt = readFileSync(resolve(ROOT, 'public/pro/welcome.html'), 'utf-8');
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const findWebMcpScript = (html) => {
    for (const match of html.matchAll(scriptRe)) {
      if (match[2].includes('document.modelContext')) {
        return { attrs: match[1], body: match[2] };
      }
    }
    return null;
  };
  const sourceScript = findWebMcpScript(welcomeSrc);
  const iifeMatch = sourceScript?.body.match(/\(function \(\) \{[\s\S]*?\}\)\(\);/);
  const runInline = iifeMatch ? new Function('window', 'document', iifeMatch[0]) : null;

  function run(providerFactory) {
    const registered = [];
    const documentListeners = new Map();
    const windowListeners = new Map();
    let navigatedTo = null;
    const document = {
      modelContext: providerFactory ? providerFactory(registered) : null,
      addEventListener: (event, listener) => documentListeners.set(event, listener),
    };
    const window = {
      location: { assign: (url) => { navigatedTo = url; } },
      addEventListener: (event, listener) => windowListeners.set(event, listener),
    };
    runInline(window, document);
    return {
      registered,
      document,
      documentListeners,
      windowListeners,
      get navigatedTo() { return navigatedTo; },
    };
  }

  const collectingProvider = (registered) => ({
    registerTool(tool) {
      registered.push(tool);
      return Promise.resolve();
    },
  });

  it('uses only the current document API and observes registerTool promises', () => {
    assert.ok(sourceScript);
    assert.doesNotMatch(sourceScript.body, /navigator\.modelContext|provideContext/);
    assert.match(sourceScript.body, /Promise\.resolve\(provider\.registerTool\(tools\[i\]\)\)/);
    assert.match(sourceScript.body, /function \(\) \{ return false; \}/);
  });

  it('registers titled, annotated tools synchronously', () => {
    const result = run(collectingProvider);
    assert.deepEqual(result.registered.map((tool) => tool.name), [
      'launchWorldMonitor',
      'getWorldMonitorMcpEndpoint',
    ]);
    assert.equal(result.registered[0].annotations.readOnlyHint, false);
    assert.equal(result.registered[1].annotations.readOnlyHint, true);
    assert.ok(result.registered.every((tool) => typeof tool.title === 'string'));
  });

  it('returns native values and routes launch requests safely', async () => {
    const finance = run(collectingProvider);
    const launch = finance.registered.find((tool) => tool.name === 'launchWorldMonitor');
    const launchResult = await launch.execute({ monitor: 'finance' });
    assert.equal(launchResult, 'Opening the finance monitor: https://finance.worldmonitor.app/dashboard');
    assert.equal(finance.navigatedTo, 'https://finance.worldmonitor.app/dashboard');

    for (const bad of ['xyz', 'constructor', '__proto__', 'toString', 'valueOf']) {
      const fallback = run(collectingProvider);
      await fallback.registered.find((tool) => tool.name === 'launchWorldMonitor').execute({ monitor: bad });
      assert.equal(fallback.navigatedTo, 'https://www.worldmonitor.app/dashboard');
    }

    const endpoint = run(collectingProvider);
    const endpointResult = await endpoint.registered
      .find((tool) => tool.name === 'getWorldMonitorMcpEndpoint')
      .execute({});
    assert.equal(endpointResult.endpoint, 'https://worldmonitor.app/mcp');
    assert.equal(endpointResult.transport, 'streamableHttp');
    assert.equal(endpointResult.tools, undefined);
  });

  it('does not call the obsolete batch API', () => {
    let provideCalls = 0;
    const result = run(() => ({ provideContext: () => { provideCalls += 1; } }));
    assert.equal(provideCalls, 0);
    assert.equal(result.registered.length, 0);
    assert.equal(typeof result.documentListeners.get('DOMContentLoaded'), 'function');
  });

  it('registers on the bounded retry when a provider appears late', () => {
    const result = run(() => null);
    const late = [];
    result.document.modelContext = collectingProvider(late);
    result.documentListeners.get('DOMContentLoaded')();
    result.windowListeners.get('load')();
    assert.deepEqual(late.map((tool) => tool.name), [
      'launchWorldMonitor',
      'getWorldMonitorMcpEndpoint',
    ]);
  });

  it('drains rejected registrations without an unhandled rejection', async () => {
    const result = run((registered) => ({
      registerTool(tool) {
        registered.push(tool);
        return Promise.reject(new DOMException('duplicate', 'InvalidStateError'));
      },
    }));
    assert.equal(result.registered.length, 2);
    await settlePromises();
  });

  it('contains a throwing optional provider getter', () => {
    const document = {
      addEventListener: () => {},
      get modelContext() { throw new Error('broken polyfill'); },
    };
    const window = { addEventListener: () => {}, location: { assign: () => {} } };
    assert.doesNotThrow(() => runInline(window, document));
  });

  it('keeps the generated homepage copy under the static CSP nonce', () => {
    const builtScript = findWebMcpScript(welcomeBuilt);
    assert.ok(builtScript);
    assert.match(builtScript.attrs, /\bnonce="wm-static-bootstrap"/);
    assert.doesNotMatch(builtScript.body, /navigator\.modelContext|provideContext/);
  });
});

describe('webmcp App.ts binding: readiness + teardown', () => {
  const appSrc = readFileSync(resolve(ROOT, 'src/App.ts'), 'utf-8');
  const bindingBlock = appSrc.match(/registerWebMcpTools\(\{[\s\S]+?\}\);/);

  it('is imported statically and called before the first init await', () => {
    assert.ok(bindingBlock);
    assert.match(
      appSrc,
      /^import \{ registerWebMcpTools \} from '@\/services\/webmcp';$/m,
    );
    assert.doesNotMatch(appSrc, /import\(['"]@\/services\/webmcp['"]\)/);
    const initBody = appSrc.match(
      /public async init\(\): Promise<void> \{([\s\S]*?)\r?\n {2}\}(?=\r?\n\r?\n {2}(?:public|private) )/,
    );
    assert.ok(initBody);
    const preAwait = initBody[1].split(/\n\s+await\s/, 2)[0];
    assert.match(preAwait, /registerWebMcpTools\(/);
  });

  it('both bindings reach UI readiness and surface target failures', () => {
    assert.match(
      bindingBlock[0],
      /openSearch:[\s\S]+?this\.openSearch\(\{ throwOnFailure: true \}\)/,
    );
    assert.match(
      appSrc,
      /private async openSearch\([\s\S]+?await this\.waitForUiReady\(\)[\s\S]+?await this\.ensureSearchManager\(\)/,
    );
    assert.match(
      bindingBlock[0],
      /openCountryBriefByCode:[\s\S]+?await this\.waitForUiReady\(\)[\s\S]+?if \(!this\.state\.countryBriefPage\)[\s\S]+?throw new Error/,
    );
    assert.match(
      appSrc,
      /private async openSearch\([\s\S]+?if \(!modal\) throw new Error\([\s\S]+?if \(options\.throwOnFailure\) throw error;/,
    );
  });

  it('keeps the first-load search epoch state machine intact', () => {
    assert.match(appSrc, /private openSearchEpoch = 0;/);
    assert.match(appSrc, /private searchToggleDesiredOpen = false;/);
    assert.match(
      appSrc,
      /this\.searchToggleDesiredOpen = !this\.searchToggleDesiredOpen;[\s\S]+?epoch = \+\+this\.openSearchEpoch;[\s\S]+?await this\.ensureSearchManager\(\)[\s\S]+?if \(this\.openSearchEpoch !== epoch\) return;/,
    );
    assert.doesNotMatch(appSrc, /pendingSearchToggleShouldOpen/);
  });

  it('resolves UI readiness after Phase 4 and bounds readiness waits', () => {
    assert.match(
      appSrc,
      /this\.countryIntel\.init\(\);[\s\S]{0,200}this\.resolveUiReady\(\)/,
    );
    assert.match(
      appSrc,
      /private async waitForUiReady\(timeoutMs = [\d_]+\)[\s\S]+?Promise\.race\(\[this\.uiReady/,
    );
  });

  it('destroy aborts the shared controller so re-init cannot duplicate tools', () => {
    const destroyBody = appSrc.match(
      /public destroy\(\): void \{([\s\S]*?)\r?\n {2}\}(?=\r?\n\r?\n {2}(?:public|private) )/,
    );
    assert.ok(destroyBody);
    assert.match(destroyBody[1], /this\.webMcpController\?\.abort\(\)/);
  });
});
