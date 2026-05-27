import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function src(relPath: string): string {
  return readFileSync(resolve(root, relPath), 'utf-8');
}

describe('lazy startup orchestration guardrails', () => {
  it('buffers CSP violations before deferred Sentry init', () => {
    const main = src('src/main.ts');
    const initIdx = main.indexOf('const _initSentry');
    const bufferIdx = main.indexOf("window.addEventListener('securitypolicyviolation', bufferCspViolation)");
    assert.ok(bufferIdx !== -1, 'main.ts must install the CSP buffer listener eagerly');
    assert.ok(initIdx !== -1 && bufferIdx < initIdx, 'CSP buffer listener must be registered before deferred Sentry init');
    assert.match(main, /const __cspViolationBuffer: BufferedCspViolation\[\] = \[\]/);
    assert.match(main, /for \(const violation of __cspViolationBuffer\)[\s\S]*?captureCspViolation\(Sentry, violation\)/);
  });

  it('suppresses YouTube NotAllowedError before deferred Sentry init', () => {
    const main = src('src/main.ts');
    const initIdx = main.indexOf('const _initSentry');
    const suppressIdx = main.indexOf("window.addEventListener('unhandledrejection', (e) =>");
    assert.ok(suppressIdx !== -1, 'main.ts must install the NotAllowedError suppression eagerly');
    assert.ok(initIdx !== -1 && suppressIdx < initIdx, 'NotAllowedError suppression must not wait for Sentry import');
    assert.match(main, /if \(isSuppressedPreSentryRejection\(event\.reason\)\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?return;/);
  });

  it('does not force all panel data during startup', () => {
    const app = src('src/App.ts');
    assert.doesNotMatch(app, /loadAllData\(true\)/, 'startup must not bypass lazy panel data gates');
    assert.doesNotMatch(app, /primeVisiblePanelData\(true\)/, 'startup must not bypass lazy panel prime gates');
  });

  it('panel data gates require a loaded panel, not just a skeleton element', () => {
    const app = src('src/App.ts');
    const dataLoader = src('src/app/data-loader.ts');
    assert.match(app, /isLoadedPanelNearViewport\(this\.state\.panels, panelId, marginPx\)/);
    assert.match(dataLoader, /isLoadedPanelNearViewport\(this\.ctx\.panels, panelId, marginPx\)/);
    assert.doesNotMatch(dataLoader, /document\.querySelector\(`\[data-panel=/);
  });

  it('panel-ready hook triggers first-time data for lazy-loaded panels', () => {
    const app = src('src/App.ts');
    assert.match(app, /onPanelReady: \(key\) => this\.handlePanelReady\(key\)/);
    assert.match(app, /primeTask\('bls', \(\) => this\.dataLoader\.loadBlsData\(\)\)/);
    assert.match(app, /primeTask\('economicStress', \(\) => this\.dataLoader\.loadEconomicStress\(\)\)/);
    assert.match(app, /primeTask\('forecasts', \(\) => this\.dataLoader\.loadForecasts\(\)\)/);
    assert.match(app, /primeTask\('intelligence', \(\) => this\.dataLoader\.loadIntelligenceSignals\(\)\)/);
    assert.match(app, /primeTask\('wsbTickers', \(\) => this\.dataLoader\.loadWsbTickers\(\)\)/);
  });

  it('map lazy-load has a timeout fallback and app-ready path is not map-gated', () => {
    const layout = src('src/app/panel-layout.ts');
    const app = src('src/App.ts');
    assert.match(layout, /mapFallbackTimer = setTimeout\(\(\) => \{[\s\S]*?void loadMap\(\);[\s\S]*?\}, 2500\)/);
    assert.match(app, /if \(!this\.mapDependentModulesInitialized && this\.state\.map\)[\s\S]*?if \(this\.mapModulesInitialized\) return;/);
    assert.match(app, /this\.resolveUiReady\(\);/);
    assert.match(app, /this\.handleDeepLinks\(\);/);
  });
});
