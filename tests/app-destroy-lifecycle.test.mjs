import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appSrc = readFileSync(resolve(root, 'src/App.ts'), 'utf8');
const mainSrc = readFileSync(resolve(root, 'src/main.ts'), 'utf8');
const militaryFlightsSrc = readFileSync(resolve(root, 'src/services/military-flights.ts'), 'utf8');
const militaryVesselsSrc = readFileSync(resolve(root, 'src/services/military-vessels.ts'), 'utf8');
const lazyMilitaryVesselsSrc = readFileSync(resolve(root, 'src/services/military-vessels-lazy.ts'), 'utf8');
const dataLoaderSrc = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf8');
const panelLayoutSrc = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf8');

function methodBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `could not locate ${signature}`);

  const openBraceIndex = source.indexOf('{', signatureIndex);
  assert.notEqual(openBraceIndex, -1, `could not locate ${signature} opening brace`);

  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index++) {
    const char = source[index];
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) {
      return source.slice(openBraceIndex + 1, index);
    }
  }

  assert.fail(`could not locate ${signature} closing brace`);
}

function appDestroyBody() {
  return methodBody(appSrc, 'public destroy(): void');
}

describe('App.destroy lifecycle cleanup contract', () => {
  it('tears down early WebMCP registration when asynchronous app initialization fails', () => {
    const bootStart = mainSrc.indexOf("const app = new App('app');");
    const bootEnd = mainSrc.indexOf('// Debug helpers for geo-convergence testing', bootStart);
    assert.notEqual(bootStart, -1, 'could not locate the dashboard App boot');
    assert.notEqual(bootEnd, -1, 'could not locate the end of the dashboard App boot');
    const boot = mainSrc.slice(bootStart, bootEnd);
    assert.match(boot, /\.catch\(\(error: unknown\) => \{/);
    assert.match(boot, /try \{\s*\/\/[\s\S]*?app\.destroy\(\);\s*\} catch \(cleanupError\) \{/);

    const destroyBody = appDestroyBody();
    const wakePendingTools = destroyBody.indexOf('this.resolveAppDestroyed()');
    const abortLifecycle = destroyBody.indexOf('this.lifecycleController.abort()');
    const abortRegisteredTools = destroyBody.indexOf('this.webMcpController?.abort()');
    const destroyModules = destroyBody.indexOf('// Destroy all modules in reverse order');
    assert.ok(wakePendingTools >= 0, 'destroy() must wake WebMCP readiness waits');
    assert.ok(
      abortLifecycle > wakePendingTools && abortLifecycle < abortRegisteredTools,
      'destroy() must abort App-owned waiters before unregistering WebMCP tools',
    );
    assert.ok(
      abortRegisteredTools > wakePendingTools && abortRegisteredTools < destroyModules,
      'destroy() must unregister WebMCP before partial module cleanup can throw',
    );
    assert.match(
      destroyBody,
      /try \{[\s\S]*Destroy all modules in reverse order[\s\S]*\} finally \{[\s\S]*this\.state\.map\?\.destroy\(\);[\s\S]*disconnectAisStream\(\);/,
      'destroy() must still clean up the map and AIS stream if a module destructor throws',
    );
  });

  it('observes descendant scroll containers in capture phase and removes the matching listener', () => {
    const scrollRegistrations = [
      ...appSrc.matchAll(/window\.addEventListener\('scroll',\s*this\.handleViewportPrime,\s*\{([\s\S]*?)\}\);/g),
    ];
    assert.equal(scrollRegistrations.length, 1, 'App must register exactly one viewport-prime scroll listener');
    assert.match(scrollRegistrations[0][1], /passive:\s*true/, 'the scroll listener must remain passive');
    assert.match(
      scrollRegistrations[0][1],
      /capture:\s*true/,
      'capture is required because element scroll events do not bubble to window',
    );

    const body = appDestroyBody();
    assert.match(
      body,
      /window\.removeEventListener\('scroll',\s*this\.handleViewportPrime,\s*\{\s*capture:\s*true\s*\}\);/,
      'destroy() must use the same capture value so same-document re-inits do not accumulate listeners',
    );
    assert.match(
      appSrc,
      /window\.addEventListener\('resize',\s*this\.handleViewportPrime\);/,
      'viewport resize must keep triggering hydration',
    );
    assert.match(
      body,
      /window\.removeEventListener\('resize',\s*this\.handleViewportPrime\);/,
      'destroy() must keep removing the resize listener',
    );

    const slowTierAwait = appSrc.indexOf('await slowTierReady;');
    const readyTimestamp = appSrc.indexOf('this.viewportHydrationReadyAt = typeof performance');
    const readyFlag = appSrc.indexOf('this.viewportHydrationReady = true;', readyTimestamp);
    const scrollRegistration = appSrc.indexOf("window.addEventListener('scroll', this.handleViewportPrime");
    assert.notEqual(slowTierAwait, -1, 'could not locate the slow-tier readiness checkpoint');
    assert.ok(
      scrollRegistration > slowTierAwait,
      'captured descendant scrolls must not trigger hydration before the slow tier settles',
    );
    assert.ok(
      readyTimestamp > slowTierAwait && readyTimestamp < scrollRegistration,
      'viewport hydration must stamp the readiness time before registering scroll listeners',
    );
    assert.ok(
      readyFlag > readyTimestamp && readyFlag < scrollRegistration,
      'viewport hydration readiness must open after the readiness timestamp is captured',
    );
  });

  it('filters nested scrollers, coalesces viewport triggers, and cancels queued hydration during destroy', () => {
    const start = appSrc.indexOf('private readonly handleViewportPrime = (event?: Event): void => {');
    const end = appSrc.indexOf('private readonly handleConnectivityChange', start);
    assert.notEqual(start, -1, 'could not locate handleViewportPrime');
    assert.notEqual(end, -1, 'could not locate the end of handleViewportPrime');
    const handler = appSrc.slice(start, end);

    assert.match(
      handler,
      /if \(this\.visiblePanelPrimeRaf !== null\) return;/,
      'repeated scrolls in one frame must share one hydration callback',
    );
    assert.match(handler, /if \(!this\.viewportHydrationReady \|\| this\.state\.isDestroyed\) return;/);
    assert.match(handler, /event\?\.type === 'scroll'/);
    assert.match(handler, /event\.target instanceof Element/);
    assert.match(handler, /!event\.target\.matches\('\.main-content, \.panels-grid'\)/);
    const staleEventGuard = handler.indexOf('event.timeStamp < this.viewportHydrationReadyAt');
    const rafSchedule = handler.indexOf('this.visiblePanelPrimeRaf = window.requestAnimationFrame(');
    assert.ok(
      staleEventGuard >= 0 && staleEventGuard < rafSchedule,
      'scroll events created before slow-tier readiness must not replay viewport hydration afterward',
    );
    assert.match(handler, /this\.visiblePanelPrimeRaf = window\.requestAnimationFrame\(/);
    assert.match(handler, /this\.visiblePanelPrimeRaf = null;/);
    assert.match(handler, /void this\.primeVisiblePanelData\(\);/);
    assert.match(handler, /void this\.dataLoader\.loadAllData\(\);/);

    const body = appDestroyBody();
    assert.match(
      body,
      /if \(this\.visiblePanelPrimeRaf !== null\) \{\s*window\.cancelAnimationFrame\(this\.visiblePanelPrimeRaf\);\s*this\.visiblePanelPrimeRaf = null;\s*\}/,
      'destroy() must cancel a queued frame before it can hydrate a disposed App',
    );
    assert.match(
      body,
      /this\.viewportHydrationReady = false;\s*this\.viewportHydrationReadyAt = 0;/,
      'destroy() must reset the viewport hydration readiness timestamp',
    );

    const afterPanelMounted = methodBody(panelLayoutSrc, 'private afterPanelMounted(key: string, panel: Panel): void');
    const scheduleLoad = afterPanelMounted.indexOf("this.scheduleHydrationForPanelElement(panel.getElement(), 'near');");
    const primePanel = afterPanelMounted.indexOf('this.callbacks.primeVisiblePanelData();');
    assert.ok(
      scheduleLoad >= 0 && primePanel > scheduleLoad,
      'a newly mounted deferred panel must re-run its App-owned viewport prime without another scroll',
    );
  });

  it('stops background flight and loaded vessel runtime', () => {
    const body = appDestroyBody();
    for (const expected of [
      'stopFlightHistoryCleanup()',
      'stopLoadedVesselHistoryCleanup()',
    ]) {
      assert.ok(body.includes(expected), `App.destroy() must call ${expected}`);
    }
    assert.match(
      lazyMilitaryVesselsSrc,
      /module\.stopVesselHistoryCleanup\(\);\s+module\.disconnectMilitaryVesselStream\(\);/,
      'lazy vessel teardown must stop both history cleanup and the loaded AIS callback state',
    );
  });

  it('restarts flight cleanup and re-arms the vessel runtime on re-init, deferring vessel cleanup to first vessel use', () => {
    assert.match(appSrc, /startFlightHistoryCleanup,/);
    assert.doesNotMatch(appSrc, /startVesselHistoryCleanup/);
    // Boot re-arms the lazy vessel runtime so a same-document re-init after a
    // prior destroy can fetch vessels again; the cleanup interval still starts
    // lazily on first vessel use, not at boot.
    assert.match(appSrc, /await initDB\(\);\s+startFlightHistoryCleanup\(\);[\s\S]*?enableVesselRuntime\(\);\s+await initI18n\(\);/);
    assert.match(militaryFlightsSrc, /export function startFlightHistoryCleanup\(\): void \{[\s\S]*?historyCleanupIntervalId = setInterval\(cleanupFlightHistory, HISTORY_CLEANUP_INTERVAL\);[\s\S]*?\}/);
    assert.match(militaryFlightsSrc, /startFlightHistoryCleanup\(\);/);
    assert.match(militaryVesselsSrc, /export function startVesselHistoryCleanup\(\): void \{[\s\S]*?historyCleanupIntervalId = setInterval\(cleanup, HISTORY_CLEANUP_INTERVAL\);[\s\S]*?\}/);
    assert.match(militaryVesselsSrc, /startVesselHistoryCleanup\(\);/);
    assert.match(lazyMilitaryVesselsSrc, /module\.startVesselHistoryCleanup\(\);/);
  });

  it('gates the lazy vessel runtime on lifecycle state so a late call cannot re-arm it after destroy', () => {
    // Teardown must disable the runtime AND advance the generation so an
    // in-flight load resolving later cannot arm a runtime no App owns.
    const stopBody = methodBody(lazyMilitaryVesselsSrc, 'export function stopLoadedVesselHistoryCleanup(): void');
    assert.match(stopBody, /vesselRuntimeEnabled = false;/, 'teardown must disable the runtime');
    assert.match(stopBody, /vesselRuntimeEpoch\+\+;/, 'teardown must advance the runtime generation');

    // Arming must re-check the lifecycle state captured before the await; a
    // call that begins (or resolves) after teardown must not start the interval.
    const getBody = methodBody(lazyMilitaryVesselsSrc, 'export async function getMilitaryVesselsModule(): Promise<MilitaryVesselsModule>');
    assert.match(getBody, /const epoch = vesselRuntimeEpoch;/, 'must capture the generation before awaiting');
    assert.match(
      getBody,
      /if \(!vesselRuntimeEnabled \|\| epoch !== vesselRuntimeEpoch\) \{[\s\S]*?stopLoadedVesselRuntime\(module\);[\s\S]*?throw/,
      'must tear down and reject when disabled or superseded instead of arming',
    );
    // The pre-fix deferred re-read (a .then that re-checks intent at resolve
    // time) must be gone — it was the source of the re-arm race.
    assert.doesNotMatch(lazyMilitaryVesselsSrc, /vesselHistoryCleanupWanted/);
  });

  it('surfaces deliberate teardown as a typed error callers can ignore', () => {
    assert.match(lazyMilitaryVesselsSrc, /export class VesselRuntimeStoppedError extends Error/);
    assert.match(lazyMilitaryVesselsSrc, /export function isVesselRuntimeStoppedError\(/);
    assert.match(lazyMilitaryVesselsSrc, /throw new VesselRuntimeStoppedError\(\);/);
    // Both data-loader military catch sites must skip error logging/freshness
    // recording for the teardown sentinel rather than reporting a fake failure.
    const stoppedGuards = dataLoaderSrc.match(/if \(isVesselRuntimeStoppedError\(error\)\) return;/g) || [];
    assert.ok(stoppedGuards.length >= 2, 'both military fetch catch sites must ignore the teardown sentinel');
  });

  it('preserves existing map/AIS/WebMCP teardown', () => {
    const body = appDestroyBody();
    for (const expected of [
      'this.state.map?.destroy()',
      'disconnectAisStream()',
      'this.webMcpController?.abort()',
      'mlWorker.terminate()',
      'this.freeTierGate.cancelFallback()',
    ]) {
      assert.ok(body.includes(expected), `App.destroy() must keep ${expected}`);
    }
  });

  it('tears down the lazy findings badge and ignores late imports after destroy', () => {
    const destroyBody = appDestroyBody();
    assert.ok(destroyBody.includes('this.state.findingsBadge?.destroy()'), 'App.destroy() must destroy the findings badge if it loaded');
    assert.ok(destroyBody.includes('this.state.findingsBadge = null;'), 'App.destroy() must clear the findings badge reference');

    const initFindingsBadgeBody = methodBody(appSrc, 'private async initFindingsBadge(): Promise<void>');
    assert.match(
      initFindingsBadgeBody,
      /await import\('@\/components\/IntelligenceGapBadge'\);\s+if \(this\.state\.isDestroyed\) return;/,
      'lazy findings badge init must re-check destroy state after awaiting the chunk',
    );
  });

});
