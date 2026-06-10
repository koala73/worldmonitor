import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appSrc = readFileSync(resolve(root, 'src/App.ts'), 'utf8');
const militaryFlightsSrc = readFileSync(resolve(root, 'src/services/military-flights.ts'), 'utf8');
const militaryVesselsSrc = readFileSync(resolve(root, 'src/services/military-vessels.ts'), 'utf8');

function appDestroyBody() {
  const match = appSrc.match(
    /public destroy\(\): void \{([\s\S]*?)\n {2}\}(?=\n\n {2}(?:public|private) )/,
  );
  assert.ok(match, 'could not locate App.destroy() body');
  return match[1];
}

describe('App.destroy lifecycle cleanup contract', () => {
  it('stops background flight and vessel history cleanup intervals', () => {
    const body = appDestroyBody();
    for (const expected of [
      'stopFlightHistoryCleanup()',
      'stopVesselHistoryCleanup()',
    ]) {
      assert.ok(body.includes(expected), `App.destroy() must call ${expected}`);
    }
  });

  it('restarts flight and vessel history cleanup on same-document re-init', () => {
    assert.match(appSrc, /startFlightHistoryCleanup,\n\s+startVesselHistoryCleanup,/);
    assert.match(appSrc, /await initDB\(\);\n\s+startFlightHistoryCleanup\(\);\n\s+startVesselHistoryCleanup\(\);/);
    assert.match(militaryFlightsSrc, /export function startFlightHistoryCleanup\(\): void \{[\s\S]*?historyCleanupIntervalId = setInterval\(cleanupFlightHistory, HISTORY_CLEANUP_INTERVAL\);[\s\S]*?\}/);
    assert.match(militaryFlightsSrc, /startFlightHistoryCleanup\(\);/);
    assert.match(militaryVesselsSrc, /export function startVesselHistoryCleanup\(\): void \{[\s\S]*?historyCleanupIntervalId = setInterval\(cleanup, HISTORY_CLEANUP_INTERVAL\);[\s\S]*?\}/);
    assert.match(militaryVesselsSrc, /startVesselHistoryCleanup\(\);/);
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

});
