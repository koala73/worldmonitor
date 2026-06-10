import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appSrc = readFileSync(resolve(root, 'src/App.ts'), 'utf8');

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
