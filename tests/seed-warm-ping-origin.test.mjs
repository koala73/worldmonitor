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
    assert.match(src, /\/api\/infrastructure\/v1\/list-temporal-anomalies/);
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
      assert.match(
        src,
        /WARN: all warm-pings failed/,
        'must emit a grep-able WARN marker so persistent breakage is caught via log alert, not exit code',
      );
      // Durable invariant: the script must call process.exit, and EVERY call
      // must be exit(0). Extracting the literal arg catches exit(1), the old
      // `exit(ok > 0 ? 0 : 1)` ternary, exit(143), etc. — not just one spelling —
      // so no refactor can quietly re-introduce a hard crash on total failure.
      const exitArgs = [...src.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1].trim());
      assert.ok(exitArgs.length > 0, 'must call process.exit');
      for (const arg of exitArgs) {
        assert.equal(
          arg,
          '0',
          `warm-ping seeders must never exit non-zero (best-effort cache warmer — a missed ping loses no data); found process.exit(${arg})`,
        );
      }
    });
  }
});
