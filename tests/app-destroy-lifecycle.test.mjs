import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appSrc = readFileSync(resolve(root, 'src/App.ts'), 'utf8');
const militaryFlightsSrc = readFileSync(resolve(root, 'src/services/military-flights.ts'), 'utf8');
const militaryVesselsSrc = readFileSync(resolve(root, 'src/services/military-vessels.ts'), 'utf8');
const lazyMilitaryVesselsSrc = readFileSync(resolve(root, 'src/services/military-vessels-lazy.ts'), 'utf8');

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

  it('restarts flight cleanup on re-init and defers vessel cleanup to first vessel use', () => {
    assert.match(appSrc, /startFlightHistoryCleanup,/);
    assert.doesNotMatch(appSrc, /startVesselHistoryCleanup/);
    assert.match(appSrc, /await initDB\(\);\s+startFlightHistoryCleanup\(\);\s+await initI18n\(\);/);
    assert.match(militaryFlightsSrc, /export function startFlightHistoryCleanup\(\): void \{[\s\S]*?historyCleanupIntervalId = setInterval\(cleanupFlightHistory, HISTORY_CLEANUP_INTERVAL\);[\s\S]*?\}/);
    assert.match(militaryFlightsSrc, /startFlightHistoryCleanup\(\);/);
    assert.match(militaryVesselsSrc, /export function startVesselHistoryCleanup\(\): void \{[\s\S]*?historyCleanupIntervalId = setInterval\(cleanup, HISTORY_CLEANUP_INTERVAL\);[\s\S]*?\}/);
    assert.match(militaryVesselsSrc, /startVesselHistoryCleanup\(\);/);
    assert.match(lazyMilitaryVesselsSrc, /module\.startVesselHistoryCleanup\(\);/);
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
