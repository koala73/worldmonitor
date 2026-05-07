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

describe('entitlement-watchdog.ts mirror parity', () => {
  it('src/services/entitlement-watchdog.ts and pro-test/src/services/entitlement-watchdog.ts are byte-identical', async () => {
    const dashboard = await readFile(
      resolve(__dirname, '..', 'src/services/entitlement-watchdog.ts'),
      'utf-8',
    );
    const marketing = await readFile(
      resolve(__dirname, '..', 'pro-test/src/services/entitlement-watchdog.ts'),
      'utf-8',
    );
    assert.equal(
      dashboard,
      marketing,
      'If this fails, cp src/services/entitlement-watchdog.ts pro-test/src/services/entitlement-watchdog.ts (or the reverse) and re-run the gates. The two files MUST stay in lockstep.',
    );
  });
});
