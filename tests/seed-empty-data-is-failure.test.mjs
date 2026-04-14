import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for PR #3078: strict-floor IMF seeders must not poison
// seed-meta on empty/invalid upstream responses. Without the opt-in flag,
// a single transient empty fetch refreshes fetchedAt → _bundle-runner skips
// the bundle for the full intervalMs (30 days for imf-external; Railway log
// 2026-04-13).

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('emptyDataIsFailure: runSeed branch (scripts/_seed-utils.mjs)', () => {
  const src = read('scripts/_seed-utils.mjs');

  it('gates writeFreshnessMetadata on opts.emptyDataIsFailure', () => {
    // The skipped-validation block must branch on opts.emptyDataIsFailure and
    // only write seed-meta in the else branch. If someone removes the gate,
    // the bundle-lockout bug returns silently.
    const skippedBlock = src.slice(
      src.indexOf('if (publishResult.skipped)'),
      src.indexOf('const { payloadBytes }')
    );
    assert.match(skippedBlock, /if\s*\(\s*opts\.emptyDataIsFailure\s*\)/);
    // writeFreshnessMetadata must live inside the else branch, not above the if.
    const metaIdx = skippedBlock.indexOf('writeFreshnessMetadata');
    const elseIdx = skippedBlock.indexOf('} else {');
    assert.ok(elseIdx > 0 && metaIdx > elseIdx,
      'writeFreshnessMetadata must be inside the else branch so strict-floor seeders preserve stale fetchedAt');
  });

  it('still extends existing TTL regardless of the flag (cache-preservation)', () => {
    // extendExistingTtl runs above the if/else — both branches must preserve
    // the existing cache value so consumers keep reading good data while the
    // bundle retries.
    const skippedBlock = src.slice(
      src.indexOf('if (publishResult.skipped)'),
      src.indexOf('const { payloadBytes }')
    );
    const extendIdx = skippedBlock.indexOf('extendExistingTtl');
    const ifIdx = skippedBlock.indexOf('if (opts.emptyDataIsFailure)');
    assert.ok(extendIdx > 0 && extendIdx < ifIdx,
      'extendExistingTtl must run before the emptyDataIsFailure branch so cache TTL is preserved either way');
  });
});

describe('emptyDataIsFailure: strict-floor IMF seeders opt in', () => {
  const seeders = [
    'scripts/seed-imf-external.mjs',
    'scripts/seed-imf-growth.mjs',
    'scripts/seed-imf-labor.mjs',
    'scripts/seed-imf-macro.mjs',
  ];

  for (const path of seeders) {
    it(`${path} passes emptyDataIsFailure: true to runSeed`, () => {
      const src = read(path);
      // Must appear inside a runSeed opts object. Match the literal key:value
      // pair — a stray comment wouldn't satisfy runSeed's runtime check.
      assert.match(src, /emptyDataIsFailure:\s*true/,
        `${path} missing emptyDataIsFailure flag — strict-floor validator will poison seed-meta on transient failures`);
    });
  }
});
