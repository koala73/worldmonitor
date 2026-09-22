import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  GUARD_EXEMPT_FILES,
  LEGACY_RAW_LOCAL_STORAGE,
  MIN_SCANNED_FILES,
  DEREF_LABELS,
  DEREF_PROBES,
  rawStorageUsesIn,
  scanRepo,
} from '../scripts/enforce-safe-local-storage.mjs';

// ---------------------------------------------------------------------------
// Why this test exists (#7833)
// ---------------------------------------------------------------------------
//
// The scan lives in scripts/enforce-safe-local-storage.mjs so it can run from
// .husky/pre-push on any `src/` change — the edit it must catch is "someone
// touched a service or a panel", which touches nothing under tests/, and
// scripts/prepush-changed-tests.sh only selects a test file when that test
// file is itself in the changed set.
//
// This file is the other half: it proves the scanner has TEETH. A guard whose
// patterns quietly stopped matching would report a clean tree forever, which
// is indistinguishable from success and worse than no guard at all.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('raw localStorage guard (#7833)', () => {
  const scan = scanRepo(REPO_ROOT);

  it('sees the whole src population', () => {
    // Without this the scan could silently match nothing (a moved directory, a
    // changed extension filter) and every assertion below would pass vacuously.
    assert.ok(
      scan.scannedFiles.length >= MIN_SCANNED_FILES,
      `expected >= ${MIN_SCANNED_FILES} scanned files under src/ (860 at #7833), found ${scan.scannedFiles.length} — the scan or the source layout has drifted`,
    );
    assert.ok(
      scan.observed.length > 0,
      'the raw-storage patterns matched nothing — the patterns have gone stale',
    );
  });

  it('matches every recorded fixture, for every idiom', () => {
    // Not circular: DEREF_PROBES is the accumulated evidence from three review
    // rounds — whitespace on the identifier side, whitespace on the receiver
    // side, and the `!` / `as` receiver wrappers. Each entry returned [] from
    // some earlier version of this gate.
    for (const [label, probes] of Object.entries(DEREF_PROBES)) {
      for (const src of probes) {
        assert.ok(
          rawStorageUsesIn(src).some((entry) => entry.startsWith(`${label} `)),
          `${label} no longer matches ${JSON.stringify(src)}`,
        );
      }
    }
  });

  it('counts a repeated dereference rather than collapsing it to a boolean', () => {
    // The regression shape this guard exists for: new code lands in the files
    // that ALREADY read storage. A per-file boolean would pass green on a
    // second call site, so the count is what makes the ratchet real.
    assert.deepEqual(
      rawStorageUsesIn('localStorage.getItem(a); localStorage.setItem(b, c);'),
      [`${DEREF_LABELS.direct} x2`],
    );
  });

  it('counts a global-qualified dereference exactly once', () => {
    // `window.localStorage.getItem(k)` is two nested accesses. The regex era
    // counted it under two labels at once, inflating those files' entries.
    assert.deepEqual(
      rawStorageUsesIn('window.localStorage.getItem(k);'),
      [`${DEREF_LABELS.global} x1`],
    );
  });

  it('treats a bare identifier as legal and a dereference as not', () => {
    // `this === localStorage` is an identity comparison; it cannot throw on a
    // null. Flagging it would push callers to "fix" working code, and an
    // inventory nobody trusts gets rubber-stamped.
    assert.deepEqual(rawStorageUsesIn('if (this === localStorage) return;'), []);
    assert.deepEqual(rawStorageUsesIn("vi.stubGlobal('localStorage', null);"), []);
    assert.deepEqual(rawStorageUsesIn('const x = windowFoo.localStorageBar;'), []);
    assert.deepEqual(rawStorageUsesIn('keyFn.call(localStorage, i);'), []);
  });

  it('ignores an idiom that only appears in a comment', () => {
    // Free with an AST — a comment is not a node. The regex era needed a
    // comment stripper for this, and that stripper is what went blind on 1826
    // lines of panel-layout.ts.
    assert.deepEqual(
      rawStorageUsesIn([
        '// call localStorage.getItem(k) here',
        '/* or localStorage.setItem(k, v) */',
        "const glob = '../locales/*.json';",
        '// see src/components/*Panel.ts',
        'safeStorageGet(k);',
      ].join('\n')),
      [],
    );
  });

  it('exempts the canonical helper and nothing else', () => {
    assert.deepEqual([...GUARD_EXEMPT_FILES], ['src/utils/safe-storage.ts']);
    // The helper is the one file that MUST dereference storage, so its
    // exemption has to be real — if the scan started including it, the
    // inventory would grow an entry nobody can ever remove.
    assert.equal(
      scan.scannedFiles.some((abs) => abs.endsWith('src/utils/safe-storage.ts')),
      false,
    );
  });

  it('keeps the recorded inventory matching the tree', () => {
    assert.deepEqual(
      scan.unlisted,
      [],
      'new raw localStorage dereferences — route them through @/utils/safe-storage, or record them with a reason',
    );
    assert.deepEqual(
      scan.stale,
      [],
      'recorded dereferences that no longer exist — lower the count or delete the line in LEGACY_RAW_LOCAL_STORAGE',
    );
  });

  it('records every entry with a count so the ratchet can only tighten', () => {
    for (const entry of LEGACY_RAW_LOCAL_STORAGE) {
      assert.match(
        entry,
        / :: .+ x[1-9]\d*$/,
        `${entry} is missing a positive occurrence count`,
      );
    }
    assert.deepEqual(
      [...LEGACY_RAW_LOCAL_STORAGE].sort(),
      LEGACY_RAW_LOCAL_STORAGE,
      'inventory must stay sorted so diffs stay readable',
    );
    assert.equal(
      new Set(LEGACY_RAW_LOCAL_STORAGE).size,
      LEGACY_RAW_LOCAL_STORAGE.length,
      'a duplicated entry would let one of the pair go stale unnoticed',
    );
  });

  it('keeps the sites #7833 migrated off raw storage', () => {
    // These had genuinely unguarded, reachable dereferences before #7833.
    // Re-listing one here would silence the guard on a regression.
    for (const file of [
      'src/services/runtime.ts',
      'src/services/tv-mode.ts',
      'src/settings-main.ts',
      // Re-listing this one would mean the private rawGet/rawSet/rawRemove
      // trio came back. It was added by #7833 itself and removed in review:
      // its justification (bypassing an own-property override of
      // `localStorage`) described a threat that exists nowhere in this repo.
      'src/utils/cloud-prefs-sync.ts',
    ]) {
      assert.equal(
        LEGACY_RAW_LOCAL_STORAGE.some((entry) => entry.startsWith(`${file} ::`)),
        false,
        `${file} was migrated off raw localStorage by #7833 and must not return to the inventory`,
      );
    }
  });
});
