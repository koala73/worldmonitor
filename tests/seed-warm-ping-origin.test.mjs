import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readScript(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf-8');
}

describe('warm-ping seed scripts', () => {
  it('sends the app Origin header for infrastructure warm-pings', () => {
    const src = readScript('scripts/seed-infra.mjs');
    assert.match(src, /Origin:\s*'https:\/\/worldmonitor\.app'/);
    assert.match(src, /method:\s*'POST'/);
  });

  it('sends the app Origin header for military/maritime warm-pings', () => {
    const src = readScript('scripts/seed-military-maritime-news.mjs');
    assert.match(src, /Origin:\s*'https:\/\/worldmonitor\.app'/);
    assert.match(src, /method:\s*'POST'/);
  });

  // A warm-ping seeder is a best-effort cache warmer: it owns no Redis keys to
  // extend, so a missed ping loses no data and must NOT hard-crash Railway.
  // The fleet convention (see seed-infra.mjs) is exit(0) + a grep-able WARN
  // marker for log-alerting, NOT a non-zero exit on total failure.
  for (const script of ['scripts/seed-infra.mjs', 'scripts/seed-military-maritime-news.mjs']) {
    it(`${script} exits 0 (best-effort) and never hard-crashes on total warm-ping failure`, () => {
      const src = readScript(script);
      assert.match(src, /process\.exit\(0\)/, 'must end with a best-effort exit(0)');
      assert.match(
        src,
        /WARN: all warm-pings failed/,
        'must emit a grep-able WARN marker so persistent breakage is caught via log alert, not exit code',
      );
      assert.doesNotMatch(
        src,
        /exit\(\s*ok\s*>\s*0\s*\?\s*0\s*:\s*1\s*\)/,
        'must not hard-crash (exit 1) when all warm-pings fail',
      );
    });
  }
});
