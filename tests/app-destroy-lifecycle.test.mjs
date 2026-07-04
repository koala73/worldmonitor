import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appSrc = readFileSync(resolve(root, 'src/App.ts'), 'utf8');
const militaryFlightsSrc = readFileSync(resolve(root, 'src/services/military-flights.ts'), 'utf8');
const militaryVesselsSrc = readFileSync(resolve(root, 'src/services/military-vessels.ts'), 'utf8');
const lazyMilitaryVesselsSrc = readFileSync(resolve(root, 'src/services/military-vessels-lazy.ts'), 'utf8');
const dataLoaderSrc = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf8');

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
