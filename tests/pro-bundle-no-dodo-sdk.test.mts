/**
 * Guards the contract #7222 established: the /pro marketing bundle carries NO
 * dependency on the `dodopayments-checkout` SDK.
 *
 * Checkout on /pro is a top-level redirect to Dodo's HOSTED page (#4449) — it
 * needs no client SDK. The dormant `initOverlay`, which held the only
 * `import('dodopayments-checkout')` under pro-test/, was deleted in #7222 along
 * with the dependency in pro-test/package.json.
 *
 * Why a SOURCE sweep and not a resolution or bundle check: the DASHBOARD still
 * declares `dodopayments-checkout` in the root package.json (its own overlay
 * machinery is dormant but present), so the package sits in the repo-root
 * node_modules. esbuild and Vite both resolve bare specifiers by walking UP
 * from pro-test/src, which means a re-introduced import in /pro resolves
 * happily against the root install — pro-test's own package.json not declaring
 * it changes nothing, and every /pro test suite stays green. Dropping the
 * `dodopayments-checkout` stubs from the /pro esbuild harness does not close
 * this either (verified: re-adding the import to pro-test/src/services/
 * checkout.ts still built and passed). Reading the source text is the only
 * check that does not depend on module resolution.
 *
 * Scope note: this deliberately bans the specifier outright — including a
 * `import type` — because a type-only import is the usual first step back to a
 * value import, and /pro has no legitimate use for the SDK's types now that the
 * overlay is gone. The dashboard's own value-import guard lives separately in
 * tests/panel-cluster-chunks.test.mjs (checkoutSdkValueImportOffenders), which
 * allows the type import and only forbids a static value import.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const SDK_SPECIFIER = /['"]dodopayments-checkout['"]/;

describe('/pro bundle has no dodopayments-checkout dependency', () => {
  const files = sourceFiles(resolve(root, 'pro-test/src'));

  it('scans a non-trivial number of files', () => {
    // Without this, a broken walker (wrong path, over-eager skip) would leave
    // the sweep below vacuously green.
    assert.ok(files.length > 20, `expected to scan the /pro sources, scanned ${files.length}`);
  });

  it('detects a planted violation', () => {
    // Positive control: proves the pattern can actually fail, for all three
    // shapes a re-introduction could take.
    assert.match("import { DodoPayments } from 'dodopayments-checkout';", SDK_SPECIFIER);
    assert.match("import type { CheckoutEvent } from 'dodopayments-checkout';", SDK_SPECIFIER);
    assert.match("await import('dodopayments-checkout');", SDK_SPECIFIER);
    // And that it does not fire on the hosted-checkout HOST allowlist, which
    // legitimately names the same vendor.
    assert.doesNotMatch("'checkout.dodopayments.com'", SDK_SPECIFIER);
  });

  it('has no source reference to the SDK anywhere under pro-test/src', () => {
    const offenders = files
      .filter((f) => SDK_SPECIFIER.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(root, f));
    assert.deepEqual(
      offenders,
      [],
      'The /pro checkout is a top-level redirect to Dodo\'s hosted page (#4449) and needs no '
      + 'client SDK; #7222 removed the import and the pro-test/package.json dependency. Note the '
      + 'root node_modules still carries the package for the dashboard, so a re-added import will '
      + `RESOLVE and every other /pro suite will stay green. Offenders: ${offenders.join(', ')}`,
    );
  });

  it('does not declare the SDK in pro-test/package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'pro-test/package.json'), 'utf-8'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.ok(
      Object.keys(declared).length > 5,
      'expected to read the real pro-test manifest, not an empty object',
    );
    assert.equal(
      Object.hasOwn(declared, 'dodopayments-checkout'),
      false,
      'pro-test must not re-declare dodopayments-checkout (#7222).',
    );
  });
});
