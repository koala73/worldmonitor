/**
 * Parity check for the marketing/dashboard mirror files.
 *
 * `src/services/` and `pro-test/src/services/` are separate bundle roots with
 * no cross-root imports (the Vite alias `@` resolves to the pro-test root
 * only), so a helper both surfaces need is physically duplicated. The copies
 * MUST be byte-identical: a silent drift leaves one bundle running an older
 * implementation with nothing failing loudly.
 *
 * `entitlement-watchdog.ts` left this set with #7222 — the marketing copy's
 * only consumer was the dormant `initOverlay`, so the watchdog is now
 * dashboard-only and covered directly by entitlement-watchdog.test.mts.
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
 * `timeout-signal.ts` joined the mirror set with WORLDMONITOR-109 and is what
 * is left of it. Each root's `checkout-transport.ts` imports it as
 * `./timeout-signal`, so that specifier only resolves in both bundles if the
 * helper exists at the same relative path under each root. Drift here is
 * quiet and therefore dangerous: the import still resolves, nothing fails
 * loudly, and one bundle silently loses its old-engine fallback and goes back
 * to throwing before `fetch` — the exact WORLDMONITOR-109 crash, which was a
 * /pro bug, so the marketing copy is the one that must not rot.
 */
const MIRRORED = [
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
