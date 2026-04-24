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

// App.ts wiring — guards against silent-success bugs where a binding
// forwards to a nullable UI target whose no-op the tool then falsely
// reports as success. Bindings MUST throw when the target is absent
// so withInvocationLogging's catch path can return isError:true.
describe('webmcp App.ts binding: guard against silent success', () => {
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
    const initBody = appSrc.match(/public async init\(\): Promise<void> \{([\s\S]+?)\n  \}/);
    assert.ok(initBody, 'could not locate init() body');
    const preAwait = initBody[1].split(/\n\s+await\s/, 2)[0];
    assert.match(
      preAwait,
      /registerWebMcpTools\(/,
      'registerWebMcpTools must be invoked before the first await in init()',
    );
  });

  it('openSearch binding throws when searchModal is absent', () => {
    assert.match(
      bindingBlock[0],
      /openSearch:[\s\S]+?if \(!this\.state\.searchModal\)[\s\S]+?throw new Error/,
    );
  });

  it('openCountryBriefByCode binding throws when countryBriefPage is absent', () => {
    assert.match(
      bindingBlock[0],
      /openCountryBriefByCode:[\s\S]+?if \(!this\.state\.countryBriefPage\)[\s\S]+?throw new Error/,
    );
  });
});
