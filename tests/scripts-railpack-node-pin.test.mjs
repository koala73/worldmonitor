import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const railpackConfig = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/railpack.json'), 'utf8'));

// Node 24.22.1 fixes CVE-2026-111497 (Brotli decoder RCE). The seeders decode
// Brotli from third-party servers, so the Railway runtime must not drop below it.
const SECURITY_FLOOR = [24, 22, 1];

function parseExact(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

describe('scripts/railpack.json', () => {
  const node = railpackConfig.packages?.node;

  it('pins an exact Node version, because Railpack resolves ranges below their floor', () => {
    // Railpack resolved ">=24.22.1" to 24.21.0 and ">=22.19.0" to 22.23.3 (2026-10-24).
    assert.ok(parseExact(node ?? ''), `expected an exact x.y.z version, got ${JSON.stringify(node)}`);
  });

  it('is at or above the CVE-2026-111497 fixed release on the Node 24 line', () => {
    const pinned = parseExact(node ?? '');
    assert.ok(pinned && pinned[0] === SECURITY_FLOOR[0], 'pin must stay on the Node 24 line');
    assert.ok(compare(pinned, SECURITY_FLOOR) >= 0, `pin ${node} is below ${SECURITY_FLOOR.join('.')}`);
  });

  it('installs curl in the runtime image for curlFetch and the relay fallbacks', () => {
    assert.ok(railpackConfig.deploy?.aptPackages?.includes('curl'));
  });
});
