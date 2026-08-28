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
 * Why the sweep is DERIVED and not a directory listing (PR #7259 review): the
 * /pro bundle's source surface is larger than pro-test/src. Modules there
 * import repo-level `shared/` helpers by relative path (`../../../shared/...`),
 * and those files are bundle inputs too — an SDK import inside one would ship
 * to /pro while a pro-test/src-only sweep stayed green. So the set is walked
 * transitively from pro-test/src across every escaping relative import. A
 * hand-maintained list of "the shared files /pro happens to use today" would
 * rot the moment someone adds an import, which is the same allowlist-rot
 * failure this PR already fixed once in the mirror-parity gate.
 *
 * Scope note: this bans the specifier outright — including a `import type` —
 * because a type-only import is the usual first step back to a value import,
 * and /pro has no legitimate use for the SDK's types now that the overlay is
 * gone. The dashboard's own value-import guard lives separately in
 * tests/panel-cluster-chunks.test.mjs (checkoutSdkValueImportOffenders), which
 * allows the type import and only forbids a static value import.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const proRoot = resolve(root, 'pro-test');

// Every extension Vite will pull into the bundle. `.ts`/`.tsx` is what /pro is
// written in today; the JS family is here so a future plain-JS module (or a
// shared/ helper like ais-vessel-type.js, which already is one) cannot slip
// past the sweep by virtue of its extension.
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;
const RESOLVE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const SDK_SPECIFIER = /['"]dodopayments-checkout['"]/;
// Relative specifiers only — a bare package specifier is a node_modules import,
// not a repo source file we could sweep.
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

/** Resolve a relative import specifier to a real file, mirroring Vite's extension probing. */
function resolveImport(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of RESOLVE_EXT) {
    if (existsSync(base + ext)) return base + ext;
    const indexed = join(base, `index${ext}`);
    if (existsSync(indexed)) return indexed;
  }
  return null;
}

/**
 * Source files the /pro bundle can reach: everything under pro-test/src, plus
 * every repo file transitively pulled in by a relative import that escapes the
 * pro-test root.
 */
function bundleInputs(): { all: string[]; external: string[] } {
  const seen = new Set(walk(resolve(proRoot, 'src')));
  const external = new Set<string>();
  const queue = [...seen];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    const text = readFileSync(file, 'utf-8');
    for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) {
      const target = resolveImport(file, spec);
      if (target === null || seen.has(target)) continue;
      // Only follow imports that leave pro-test — everything inside it is
      // already in the set from the directory walk.
      if (target.startsWith(proRoot)) continue;
      seen.add(target);
      external.add(target);
      queue.push(target);
    }
  }
  return { all: [...seen], external: [...external] };
}

describe('/pro bundle has no dodopayments-checkout dependency', () => {
  const { all, external } = bundleInputs();

  it('scans a non-trivial number of files', () => {
    // Without this, a broken walker (wrong path, over-eager skip) would leave
    // the sweep below vacuously green.
    assert.ok(all.length > 20, `expected to scan the /pro sources, scanned ${all.length}`);
  });

  it('reaches the shared modules /pro imports from outside pro-test', () => {
    // Second positive control, and the one that matters most: the sweep is only
    // wider than a pro-test/src listing if the import walker actually resolves
    // escaping specifiers. If resolution silently returns null for all of them
    // this drops to zero and the extra coverage is imaginary, while the sweep
    // above still passes on pro-test/src alone.
    assert.ok(
      external.length > 0,
      'resolved no out-of-root bundle inputs — the import walker is broken, so this '
      + 'suite is only covering pro-test/src',
    );
  });

  it('detects a planted violation', () => {
    // Positive control for the pattern, across all three shapes a
    // re-introduction could take.
    assert.match("import { DodoPayments } from 'dodopayments-checkout';", SDK_SPECIFIER);
    assert.match("import type { CheckoutEvent } from 'dodopayments-checkout';", SDK_SPECIFIER);
    assert.match("await import('dodopayments-checkout');", SDK_SPECIFIER);
    // And that it does not fire on the hosted-checkout HOST allowlist, which
    // legitimately names the same vendor.
    assert.doesNotMatch("'checkout.dodopayments.com'", SDK_SPECIFIER);
  });

  it('has no source reference to the SDK in any /pro bundle input', () => {
    const offenders = all
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
    const pkg = JSON.parse(readFileSync(resolve(proRoot, 'package.json'), 'utf-8'));
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
