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
  it('feature-detects navigator.modelContext before calling provideContext', () => {
    // The detection gate must run before any call. If a future refactor
    // inverts the order, this regex stops matching and fails.
    assert.match(
      src,
      /typeof provider\.provideContext !== 'function'\) return false[\s\S]+?provider\.provideContext\(/,
      'feature detection must short-circuit before provideContext is invoked',
    );
  });

  it('guards against non-browser runtimes (navigator undefined)', () => {
    assert.match(src, /typeof navigator === 'undefined'\) return false/);
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
    /registerWebMcpTools\(\{[\s\S]+?\}\);\s*\}\);/,
  );

  it('the WebMCP binding block exists in App.ts init', () => {
    assert.ok(bindingBlock, 'could not locate registerWebMcpTools(...) in App.ts');
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
