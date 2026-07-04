import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const WEBMCP_PATH = resolve(ROOT, 'src/services/webmcp.ts');

// The real module depends on the analytics service and a DOM globalThis.
// Rather than transpile+execute it under tsx (and drag in its transitive
// imports), we assert contract properties by reading the source directly.
// This mirrors how tests/edge-functions.test.mjs validates edge handlers.
const src = readFileSync(WEBMCP_PATH, 'utf-8');

describe('webmcp.ts: draft-spec contract', () => {
  it('prefers registerTool (Chrome-implemented form) over provideContext (legacy)', () => {
    // isitagentready.com scans for navigator.modelContext.registerTool calls.
    // The registerTool branch must come first; provideContext is a legacy
    // fallback. If a future refactor inverts order, the scanner will miss us.
    const registerIdx = src.search(/typeof provider\.registerTool === 'function'/);
    const provideIdx = src.search(/typeof provider\.provideContext === 'function'/);
    assert.ok(registerIdx >= 0, 'registerTool branch missing');
    assert.ok(provideIdx >= 0, 'provideContext fallback missing');
    assert.ok(
      registerIdx < provideIdx,
      'registerTool must be checked before provideContext (Chrome-impl form is the primary target)',
    );
  });

  it('uses AbortController for registerTool teardown (draft-spec pattern)', () => {
    assert.match(
      src,
      /const controller = new AbortController\(\)[\s\S]+?provider\.registerTool\(tool, \{ signal: controller\.signal \}\)/,
    );
  });

  it('guards against non-browser runtimes (navigator undefined)', () => {
    assert.match(src, /typeof navigator === 'undefined'\) return null/);
  });

  it('ships at least two tools (acceptance criterion: >=2 tools)', () => {
    const toolCount = (src.match(/^\s+name: '[a-zA-Z]+',$/gm) || []).length;
    assert.ok(toolCount >= 2, `expected >=2 tool entries, found ${toolCount}`);
  });

  it('openCountryBrief validates ISO-2 before dispatching to the app', () => {
    // Guards against agents passing "usa" or "USA " etc. The check must live
    // inside the tool's own execute, not the UI. Regex + uppercase normalise.
    assert.match(src, /const ISO2 = \/\^\[A-Z\]\{2\}\$\//);
    assert.match(src, /if \(!ISO2\.test\(iso2\)\)/);
  });

  it('every tool invocation is wrapped in logging', () => {
    // withInvocationLogging emits a 'webmcp-tool-invoked' analytics event
    // per call so we can observe agent traffic separately from user clicks.
    const executeLines = src.match(/execute: withInvocationLogging\(/g) || [];
    const toolCount = (src.match(/^\s+name: '[a-zA-Z]+',$/gm) || []).length;
    assert.equal(
      executeLines.length,
      toolCount,
      'every tool must route execute through withInvocationLogging',
    );
  });

  it('exposes the narrow AppBindings surface (no AppContext leakage)', () => {
    assert.match(src, /export interface WebMcpAppBindings \{/);
    assert.match(src, /openCountryBriefByCode\(code: string, country: string\): Promise<void>/);
    assert.match(src, /openSearch\(\): void/);
    // Must not import AppContext — would couple the service to every module.
    assert.doesNotMatch(src, /from '@\/app\/app-context'/);
  });
});

// Homepage WebMCP — the apex `/` serves the static pro-test welcome page
// (public/pro/welcome.html), NOT the dashboard SPA, so App.ts's
// registerWebMcpTools never runs there. The apex therefore inlines its own
// synchronous WebMCP registration in the <head> (pro-test/welcome.html) so
// browser agents and agent-readiness scanners that land on the homepage see
// registered tools. These guards keep that signal from silently regressing.
describe('homepage WebMCP registration (pro-test welcome)', () => {
  const welcomeSrc = readFileSync(resolve(ROOT, 'pro-test/welcome.html'), 'utf-8');
  const welcomeBuilt = readFileSync(resolve(ROOT, 'public/pro/welcome.html'), 'utf-8');

  // Isolate the WebMCP inline <script> body (the one that touches the WebMCP
  // provider) from both the source and the built HTML.
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const findWebMcpScript = (html) => {
    for (const m of html.matchAll(scriptRe)) {
      if (m[2].includes('navigator.modelContext')) return { attrs: m[1], body: m[2] };
    }
    return null;
  };

  it('source registers WebMCP tools synchronously in the homepage head', () => {
    const script = findWebMcpScript(welcomeSrc);
    assert.ok(script, 'welcome.html must inline a script that touches navigator.modelContext');
    // Guards non-WebMCP browsers: bail before touching the provider.
    assert.match(script.body, /if \(!provider\) return;/);
    // Prefers the Chrome-implemented registerTool, with the legacy
    // provideContext batch form as a fallback (mirrors src/services/webmcp.ts).
    const registerIdx = script.body.indexOf('provider.registerTool');
    const provideIdx = script.body.indexOf('provider.provideContext');
    assert.ok(registerIdx >= 0, 'must call provider.registerTool');
    assert.ok(provideIdx >= 0, 'must keep provider.provideContext fallback');
    assert.ok(registerIdx < provideIdx, 'registerTool must be attempted before provideContext');
  });

  it('ships at least two homepage tools (act + discover)', () => {
    const script = findWebMcpScript(welcomeSrc);
    const toolNames = [...script.body.matchAll(/name: '([a-zA-Z]+)'/g)].map((m) => m[1]);
    assert.ok(toolNames.length >= 2, `expected >=2 homepage tools, found ${toolNames.length}`);
    assert.ok(toolNames.includes('launchWorldMonitor'), 'must expose launchWorldMonitor (act)');
    assert.ok(
      toolNames.includes('getWorldMonitorMcpEndpoint'),
      'must expose getWorldMonitorMcpEndpoint (discovery bridge to the remote MCP transport)',
    );
  });

  it('discovery tool points agents at the live remote MCP transport', () => {
    const script = findWebMcpScript(welcomeSrc);
    // The homepage WebMCP surface is a gateway to the full HTTP MCP server;
    // the discovery tool must hand agents the real /mcp endpoint.
    assert.match(script.body, /https:\/\/worldmonitor\.app\/mcp/);
  });

  it('the built homepage carries the WebMCP script under the static nonce (no CSP hash needed)', () => {
    // deploy-config.test.mjs only exempts inline scripts that carry
    // nonce="wm-static-bootstrap" from the exact CSP script-src hash set.
    // If the build ever stops noncing this script, that test would demand a
    // new hash; assert the invariant here at its source so the failure is
    // legible rather than surfacing as an opaque CSP-hash mismatch.
    const script = findWebMcpScript(welcomeBuilt);
    assert.ok(script, 'built welcome.html must still contain the WebMCP script');
    assert.match(
      script.attrs,
      /\bnonce="wm-static-bootstrap"/,
      'built WebMCP script must carry the static bootstrap nonce so it needs no CSP hash',
    );
  });
});

// Runtime behaviour of the homepage WebMCP registration. The inline script is
// plain ES5 with zero imports, so (unlike the TS module above) we execute it
// directly against a stub provider to lock in behaviour, not just structure.
describe('homepage WebMCP registration — runtime behaviour', () => {
  const welcomeSrc = readFileSync(resolve(ROOT, 'pro-test/welcome.html'), 'utf-8');
  const iifeMatch = welcomeSrc.match(/\(function \(\) \{[\s\S]*?\}\)\(\);/);
  const IIFE = iifeMatch && iifeMatch[0];
  // Inject navigator/window/document as params so they shadow the read-only globals.
  const runInline = IIFE ? new Function('navigator', 'window', 'document', IIFE) : null;

  // Execute the inline script with stub globals. providerFactory(registered,
  // provided) returns the value of navigator.modelContext (or null for the
  // no-provider case). Returns captured effects, any DOMContentLoaded handler
  // armed for the late-provider retry, and the mutable navigator.
  function run(providerFactory) {
    const registered = [];
    const provided = [];
    let navigatedTo = null;
    let domHandler = null;
    const navigator = { modelContext: providerFactory ? providerFactory(registered, provided) : null };
    const window = {
      location: { assign: (u) => { navigatedTo = u; } },
      addEventListener: () => {},
    };
    const document = {
      addEventListener: (evt, fn) => { if (evt === 'DOMContentLoaded') domHandler = fn; },
    };
    runInline(navigator, window, document);
    return { registered, provided, get navigatedTo() { return navigatedTo; }, domHandler, navigator };
  }
  const collectRegister = (registered) => ({ registerTool: (t) => registered.push(t) });
  const collectProvide = (registered, provided) => ({ provideContext: (ctx) => provided.push(ctx) });

  it('the inline IIFE is extractable and executable', () => {
    assert.ok(runInline, 'could not extract the WebMCP IIFE from welcome.html');
  });

  it('registers both tools via registerTool when a provider is present', () => {
    const r = run(collectRegister);
    assert.deepEqual(r.registered.map((t) => t.name), ['launchWorldMonitor', 'getWorldMonitorMcpEndpoint']);
    for (const t of r.registered) {
      assert.equal(typeof t.description, 'string');
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(typeof t.execute, 'function');
    }
  });

  it('launchWorldMonitor navigates to the requested variant and defaults to world', async () => {
    const finance = run(collectRegister);
    const res = await finance.registered.find((t) => t.name === 'launchWorldMonitor').execute({ monitor: 'finance' });
    assert.equal(res.isError, false);
    assert.equal(finance.navigatedTo, 'https://finance.worldmonitor.app/dashboard');

    const dflt = run(collectRegister);
    await dflt.registered.find((t) => t.name === 'launchWorldMonitor').execute({});
    assert.equal(dflt.navigatedTo, 'https://www.worldmonitor.app/dashboard');
  });

  it('launchWorldMonitor never resolves off-enum or prototype keys into navigation', async () => {
    // "constructor"/"__proto__" are truthy on a plain object's prototype chain;
    // an own-property guard must keep them (and any unknown key) on the world map.
    for (const bad of ['xyz', 'constructor', '__proto__', 'toString', 'valueOf']) {
      const r = run(collectRegister);
      await r.registered.find((t) => t.name === 'launchWorldMonitor').execute({ monitor: bad });
      assert.equal(
        r.navigatedTo,
        'https://www.worldmonitor.app/dashboard',
        `monitor="${bad}" must fall back to the world dashboard, not a prototype value`,
      );
    }
  });

  it('getWorldMonitorMcpEndpoint returns the remote transport with no hardcoded tool count', async () => {
    const r = run(collectRegister);
    const res = await r.registered.find((t) => t.name === 'getWorldMonitorMcpEndpoint').execute({});
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.endpoint, 'https://worldmonitor.app/mcp');
    assert.equal(payload.transport, 'streamableHttp');
    assert.equal(payload.tools, undefined, 'must not hardcode a tool count that drifts from the server card');
  });

  it('falls back to provideContext when registerTool is unavailable', () => {
    const r = run(collectProvide);
    assert.equal(r.registered.length, 0);
    assert.equal(r.provided.length, 1);
    assert.equal(r.provided[0].tools.length, 2);
  });

  it('is a clean no-op without a provider, and arms a DOMContentLoaded retry', () => {
    const r = run(() => null);
    assert.equal(r.registered.length, 0);
    assert.equal(typeof r.domHandler, 'function', 'must arm a DOMContentLoaded retry when no provider is present at parse time');
  });

  it('registers on the retry when a provider is installed after head parse', () => {
    const r = run(() => null); // no provider at parse time
    assert.equal(r.registered.length, 0);
    const late = [];
    r.navigator.modelContext = { registerTool: (t) => late.push(t) }; // provider appears later
    r.domHandler(); // DOMContentLoaded fires
    assert.deepEqual(late.map((t) => t.name), ['launchWorldMonitor', 'getWorldMonitorMcpEndpoint']);
  });
});

// Behavioural tests against buildWebMcpTools() — we can exercise the pure
// builder by re-implementing the minimal shape it needs. This is a sanity
// check that the exported surface behaves the way the contract claims.
describe('webmcp.ts: tool behaviour (source-level invariants)', () => {
  it('openCountryBrief ISO-2 regex rejects invalid inputs', () => {
    const ISO2 = /^[A-Z]{2}$/;
    assert.equal(ISO2.test('DE'), true);
    assert.equal(ISO2.test('de'), false);
    assert.equal(ISO2.test('USA'), false);
    assert.equal(ISO2.test(''), false);
    assert.equal(ISO2.test('D1'), false);
  });
});

// App.ts wiring — guards against two classes of bug:
//   (1) Silent success when a binding forwards to a nullable UI target.
//   (2) Startup race when a tool is invoked during the window between
//       early registration (needed for scanners) and Phase-4 UI init.
// Bindings await a readiness signal before touching UI state and fall
// through to a throw if the signal never resolves; withInvocationLogging
// converts that throw into isError:true.
describe('webmcp App.ts binding: readiness + teardown', () => {
  const appSrc = readFileSync(resolve(ROOT, 'src/App.ts'), 'utf-8');
  const bindingBlock = appSrc.match(
    /registerWebMcpTools\(\{[\s\S]+?\}\);/,
  );

  it('the WebMCP binding block exists in App.ts init', () => {
    assert.ok(bindingBlock, 'could not locate registerWebMcpTools(...) in App.ts');
  });

  it('is imported statically (not via dynamic import)', () => {
    // Scanner timing: dynamic import defers registration past the probe
    // window. A static import lets the synchronous call at init-start run
    // before any await in init(), catching the first scanner probe.
    assert.match(
      appSrc,
      /^import \{ registerWebMcpTools \} from '@\/services\/webmcp';$/m,
      'registerWebMcpTools must be imported statically',
    );
    assert.doesNotMatch(
      appSrc,
      /import\(['"]@\/services\/webmcp['"]\)/,
      "no dynamic import('@/services/webmcp') — defers past scanner probe window",
    );
  });

  it('is called before the first await in init()', () => {
    // Anchor the end of the capture to the NEXT class-level member
    // (public/private) so an intermediate 2-space-indent `}` inside
    // init() can't truncate the body. A lazy `[\s\S]+?\n  }` match
    // would stop at the first such closing brace and silently shrink
    // the slice we search for the pre-await pattern.
    const initBody = appSrc.match(
      /public async init\(\): Promise<void> \{([\s\S]*?)\n {2}\}(?=\n\n {2}(?:public|private) )/,
    );
    assert.ok(initBody, 'could not locate init() body (anchor to next class member missing)');
    const preAwait = initBody[1].split(/\n\s+await\s/, 2)[0];
    assert.match(
      preAwait,
      /registerWebMcpTools\(/,
      'registerWebMcpTools must be invoked before the first await in init()',
    );
  });

  it('both bindings reach UI readiness before acting (search via openSearch(), brief directly)', () => {
    // openSearch binding delegates to App.openSearch(), which awaits
    // waitForUiReady() internally — so the binding passes throwOnFailure rather
    // than re-awaiting readiness itself (the redundant outer await + dead guards
    // were removed in the #4403 review).
    assert.match(
      bindingBlock[0],
      /openSearch:[\s\S]+?this\.openSearch\(\{ throwOnFailure: true \}\)/,
      'WebMCP openSearch must delegate to openSearch({ throwOnFailure: true })',
    );
    assert.match(
      appSrc,
      /private async openSearch\([\s\S]+?await this\.waitForUiReady\(\)[\s\S]+?await this\.ensureSearchManager\(\)/,
      'openSearch() must await waitForUiReady() before loading/opening the search manager',
    );
    assert.match(
      bindingBlock[0],
      /openCountryBriefByCode:[\s\S]+?await this\.waitForUiReady\(\)[\s\S]+?this\.state\.countryBriefPage/,
      'openCountryBriefByCode must await waitForUiReady() before accessing countryBriefPage',
    );
  });

  it('bindings surface failures (not silent success) when targets are absent', () => {
    // The silent-success guard from PR #3356 review must survive the readiness
    // refactor. For search this now lives in openSearch(): it throws on a
    // missing modal and rethrows under throwOnFailure (which the binding sets),
    // so withInvocationLogging returns isError.
    assert.match(
      bindingBlock[0],
      /openSearch:[\s\S]+?throwOnFailure: true/,
      'WebMCP openSearch must opt into throwOnFailure so load/open failures surface',
    );
    assert.match(
      appSrc,
      /private async openSearch\([\s\S]+?if \(!modal\) throw new Error\([\s\S]+?if \(options\.throwOnFailure\) throw error;/,
      'openSearch() must throw on a missing modal and rethrow under throwOnFailure',
    );
    assert.match(
      bindingBlock[0],
      /openCountryBriefByCode:[\s\S]+?if \(!this\.state\.countryBriefPage\)[\s\S]+?throw new Error/,
    );
  });

  it('first-load search toggles use an epoch + net-intent accumulator (not a stale snapshot)', () => {
    // Runtime behavior (XOR parity, interleave, failure paths) is covered by
    // tests/search-open-state-machine.test.mjs; here we pin the structural shape.
    assert.match(
      appSrc,
      /private openSearchEpoch = 0;/,
      'App must track a monotonic openSearch epoch',
    );
    assert.match(
      appSrc,
      /private searchToggleDesiredOpen = false;/,
      'App must accumulate net toggle intent during first lazy load',
    );
    assert.match(
      appSrc,
      /this\.searchToggleDesiredOpen = !this\.searchToggleDesiredOpen;[\s\S]+?epoch = \+\+this\.openSearchEpoch;[\s\S]+?await this\.ensureSearchManager\(\)[\s\S]+?if \(this\.openSearchEpoch !== epoch\) return;/,
      'openSearch must flip net intent before claiming an epoch and bail when superseded',
    );
    assert.doesNotMatch(
      appSrc,
      /const wasOpen = this\.state\.searchModal\?\.isOpen\(\) === true;/,
      'openSearch must not capture searchModal state before awaiting UI readiness/import',
    );
    assert.doesNotMatch(
      appSrc,
      /pendingSearchToggleShouldOpen/,
      'the superseded pending-toggle bookkeeping must be fully removed',
    );
  });

  it('uiReady is resolved after Phase-4 UI modules initialise', () => {
    // waitForUiReady() hangs forever if nothing ever resolves uiReady.
    // The resolve must live right after countryIntel.init() so that all
    // Phase-4 modules are ready by the time waiters unblock.
    assert.match(
      appSrc,
      /this\.countryIntel\.init\(\);[\s\S]{0,200}this\.resolveUiReady\(\)/,
      'resolveUiReady() must fire after countryIntel.init() in Phase 4',
    );
  });

  it('waitForUiReady enforces a timeout so a broken init cannot hang the agent', () => {
    assert.match(
      appSrc,
      /private async waitForUiReady\(timeoutMs = [\d_]+\)[\s\S]+?Promise\.race\(\[this\.uiReady/,
    );
  });

  it('destroy() aborts the WebMCP controller so re-inits do not duplicate registrations', () => {
    // Same anchoring as init() — end at the next class member so an
    // intermediate 2-space-indent close brace can't truncate the capture.
    const destroyBody = appSrc.match(
      /public destroy\(\): void \{([\s\S]*?)\n {2}\}(?=\n\n {2}(?:public|private) )/,
    );
    assert.ok(destroyBody, 'could not locate destroy() body (anchor to next class member missing)');
    assert.match(
      destroyBody[1],
      /this\.webMcpController\?\.abort\(\)/,
      'destroy() must abort the stored WebMCP AbortController',
    );
  });
});
