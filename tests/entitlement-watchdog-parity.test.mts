/**
 * Parity check for the entitlement-watchdog mirror files.
 *
 * `src/services/entitlement-watchdog.ts` (dashboard bundle) and
 * `pro-test/src/services/entitlement-watchdog.ts` (marketing bundle)
 * MUST be byte-identical. The dashboard version is what the unit tests
 * in entitlement-watchdog.test.mts cover; pro-test imports its own copy
 * because the bundles have no cross-root imports (Vite alias `@`
 * resolves to the pro-test root only). A silent drift between the two
 * copies would leave /pro's watchdog uncovered and possibly broken.
 *
 * Prior-art: the scripts/shared/ mirror convention
 * (feedback_shared_dir_mirror_requirement).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * `timeout-signal.ts` joined the mirror set with WORLDMONITOR-109. The
 * watchdog imports it as `./timeout-signal`, so that specifier only resolves
 * in both bundles if the helper exists at the same relative path under each
 * root. Drift there is quieter than watchdog drift and therefore worse: the
 * import still resolves, nothing fails loudly, and one bundle silently loses
 * its old-engine fallback and goes back to throwing before `fetch`.
 */
const MIRRORED = [
  'services/entitlement-watchdog.ts',
  'services/timeout-signal.ts',
];

describe('marketing/dashboard mirror parity', () => {
  for (const relPath of MIRRORED) {
    it(`src/${relPath} and pro-test/src/${relPath} are byte-identical`, async () => {
      const dashboard = await readFile(resolve(__dirname, '..', 'src', relPath), 'utf-8');
      const marketing = await readFile(
        resolve(__dirname, '..', 'pro-test/src', relPath),
        'utf-8',
      );
      // Without this, two empty/missing files would "match" and the gate would
      // pass on absence rather than on agreement.
      assert.ok(dashboard.length > 0, `src/${relPath} is empty`);
      assert.equal(
        dashboard,
        marketing,
        `If this fails, cp src/${relPath} pro-test/src/${relPath} (or the reverse) and re-run the gates. The two files MUST stay in lockstep.`,
      );
    });
  }
});
