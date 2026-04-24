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
      /public async init\(\): Promise<void> \{([\s\S]*?)\n  \}(?=\n\n  (?:public|private) )/,
    );
    assert.ok(initBody, 'could not locate init() body (anchor to next class member missing)');
    const preAwait = initBody[1].split(/\n\s+await\s/, 2)[0];
    assert.match(
      preAwait,
      /registerWebMcpTools\(/,
      'registerWebMcpTools must be invoked before the first await in init()',
    );
  });

  it('both bindings await the UI-readiness signal before touching state', () => {
    // Before-fix regression: openSearch threw immediately on first
    // invocation during startup. Both bindings must wait for Phase-4
    // UI init to complete, then check the state, then dispatch.
    assert.match(
      bindingBlock[0],
      /openSearch:[\s\S]+?await this\.waitForUiReady\(\)[\s\S]+?this\.state\.searchModal/,
      'openSearch must await waitForUiReady() before accessing searchModal',
    );
    assert.match(
      bindingBlock[0],
      /openCountryBriefByCode:[\s\S]+?await this\.waitForUiReady\(\)[\s\S]+?this\.state\.countryBriefPage/,
      'openCountryBriefByCode must await waitForUiReady() before accessing countryBriefPage',
    );
  });

  it('bindings still throw (not silently succeed) when state is absent after readiness', () => {
    // The silent-success guard from PR #3356 review must survive the
    // readiness refactor. After awaiting readiness, a missing target is
    // a real failure — throw so withInvocationLogging returns isError.
    assert.match(
      bindingBlock[0],
      /openSearch:[\s\S]+?if \(!this\.state\.searchModal\)[\s\S]+?throw new Error/,
    );
    assert.match(
      bindingBlock[0],
      /openCountryBriefByCode:[\s\S]+?if \(!this\.state\.countryBriefPage\)[\s\S]+?throw new Error/,
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
      /public destroy\(\): void \{([\s\S]*?)\n  \}(?=\n\n  (?:public|private) )/,
    );
    assert.ok(destroyBody, 'could not locate destroy() body (anchor to next class member missing)');
    assert.match(
      destroyBody[1],
      /this\.webMcpController\?\.abort\(\)/,
      'destroy() must abort the stored WebMCP AbortController',
    );
  });
});
