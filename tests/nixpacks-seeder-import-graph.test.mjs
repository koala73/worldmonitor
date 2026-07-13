// #5266 — static dependency-contract guard for the `nixpacks-root-scripts`
// Railway seeder services.
//
// These 21 services are NOT built from a Dockerfile in this repo. Railway
// builds them with `rootDirectory: scripts`, which means the build context IS
// scripts/ — the container's /app is a copy of scripts/, and `npm ci` installs
// ONLY what scripts/package.json declares. Two consequences, both of which
// have already caused production crashes:
//
//   1. BARE SPECIFIER BUDGET. A package in the ROOT package.json is invisible
//      to these containers. That is exactly how #5266 broke
//      seed-bundle-relay-backup: scripts/seed-global-tenders.mjs imports
//      `papaparse`, which the root package.json declares and scripts/
//      package.json does not. It resolves on every dev machine (root
//      node_modules) and dies in the container with
//      ERR_MODULE_NOT_FOUND: Cannot find package 'papaparse'.
//
//      A package that is merely HOISTED into scripts/node_modules as some
//      other dependency's transitive child is not good enough either — that
//      is a resolution accident, not a contract. `fast-xml-parser` (same file)
//      only resolved because @aws-sdk/client-s3 happens to pull it in; an
//      npm tree reshuffle or an aws-sdk bump silently turns it into the next
//      papaparse. The budget below is therefore the DECLARED dependencies of
//      scripts/package.json, never the installed tree.
//
//   2. CONTAINMENT. scripts/ is the whole container. A relative import that
//      escapes it (../server/..., ../shared/...) resolves fine in the repo and
//      crashes in production with "Cannot find module '/server/_shared/X.mjs'
//      imported from /app/Y.mjs".
//
// ESM resolves a module's full static import closure eagerly, so ONE bad edge
// anywhere in the closure crashes the cron at startup even when the importing
// code path never runs.
//
// Resolution model: the bundle runner spawns members with
// `spawn(process.execPath, [scriptPath])` (scripts/_bundle-runner.mjs) — plain
// `node`, no tsx loader. So these containers get plain-node rules: no
// extension guessing, no TypeScript. hasTsx: false encodes that.
//
// The walker/tokenizer machinery is shared with the Dockerfile-based container
// guards (tests/resilience-validation-import-graph.test.mjs), which own its
// self-tests; this file only supplies the nixpacks container contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBundleMembers, walkContainerGraph } from './_lib/import-graph-walk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const scriptsDir = join(root, 'scripts');

// --- Container contract, derived from the deploy config --------------------

const services = JSON.parse(readFileSync(join(scriptsDir, 'railway-services.json'), 'utf-8')).filter(
  (s) => s.deployMode === 'nixpacks-root-scripts',
);

// Floor, not an equality: adding a service must not require touching the
// guard, but a config/parse regression that silently empties the list must
// fail loudly rather than vacuously passing 0 services.
const MIN_SERVICES = 20;

const scriptsPkg = JSON.parse(readFileSync(join(scriptsDir, 'package.json'), 'utf-8'));
const installedPackages = new Set(Object.keys(scriptsPkg.dependencies ?? {}));

const contract = {
  repoRoot: root,
  // rootDirectory: scripts → /app IS scripts/. Nothing outside it exists.
  copyRootDirs: [scriptsDir],
  // The seeders execute their dynamic imports unconditionally on the paths
  // that matter (helper loading); follow them within the container.
  dynamicRootDirs: [scriptsDir],
  installedPackages,
  hasTsx: false,
};

// Bundle entries spawn each member as its OWN process, so every member is an
// independent resolution root — a bad edge in a member crashes that section
// even though the bundle entry itself resolved cleanly.
function walkRootsFor(entry) {
  const entryPath = join(root, entry);
  assert.ok(existsSync(entryPath), `railway-services.json entry missing on disk: ${entry}`);
  const members = extractBundleMembers(readFileSync(entryPath, 'utf-8'));
  const roots = [entryPath];
  for (const m of members) {
    const memberPath = join(scriptsDir, m);
    assert.ok(existsSync(memberPath), `${entry}: bundle member missing on disk: scripts/${m}`);
    roots.push(memberPath);
  }
  return roots;
}

// --- extractBundleMembers self-test (synthetic bundle source) ---------------
//
// The member list decides what the guard walks, so a regression here silently
// shrinks coverage (or aborts the suite) rather than failing loudly. Both
// container guards share this extractor, so both depend on these invariants.

describe('extractBundleMembers self-test (#5289)', () => {
  const SYNTH = [
    "await runBundle('synthetic', [",
    "  { label: 'Single', script: 'seed-single.mjs', intervalMs: HOUR },",
    '  { label: "Double", script: "seed-double.mjs", intervalMs: HOUR },',
    "  // { label: 'Disabled', script: 'seed-deleted.mjs' },  <- temporarily disabled",
    '  /* { label: "BlockDisabled", script: "seed-block-gone.mjs" }, */',
    ']);',
  ].join('\n');

  it('finds members regardless of quote style', () => {
    const members = extractBundleMembers(SYNTH);
    assert.ok(members.includes('seed-single.mjs'), "single-quoted member missing");
    assert.ok(members.includes('seed-double.mjs'), 'double-quoted member missing');
  });

  it('ignores commented-out members (line and block)', () => {
    // A disabled member is the natural way to park a section. Left unstripped,
    // its path hits the existsSync assert in walkRootsFor while the describe()
    // tree is being built — aborting every service's suite, not just one — and
    // if the file still exists it gets walked and can raise a violation for
    // code the container never loads.
    const members = extractBundleMembers(SYNTH);
    assert.deepEqual(
      members,
      ['seed-single.mjs', 'seed-double.mjs'],
      'commented-out members must not be extracted',
    );
  });
});

describe('nixpacks-root-scripts seeder import graphs (#5266)', () => {
  it('deploy config still yields the service list the guard is meant to cover', () => {
    assert.ok(
      services.length >= MIN_SERVICES,
      `only ${services.length} nixpacks-root-scripts services parsed from railway-services.json ` +
        `(floor ${MIN_SERVICES}) — deployMode key or config shape drifted; the guard would silently cover nothing`,
    );
    assert.ok(
      installedPackages.size > 0,
      'scripts/package.json declared no dependencies — the bare-specifier budget would vacuously reject everything',
    );
  });

  for (const svc of services) {
    describe(svc.service, () => {
      const roots = walkRootsFor(svc.entry);
      const { violations, unresolved, visited } = walkContainerGraph(roots, contract);

      it('every relative import resolves on disk', () => {
        assert.deepEqual(
          unresolved,
          [],
          `unresolvable relative import(s) — these crash the cron with ERR_MODULE_NOT_FOUND:\n\n  ${unresolved.join('\n\n  ')}`,
        );
      });

      it('reaches no bare specifier or containment escape the container cannot resolve', () => {
        assert.deepEqual(
          violations,
          [],
          `import(s) reachable from ${svc.service} that its container cannot resolve.\n\n` +
            `Railway builds this service with rootDirectory: scripts, so /app IS scripts/ and ` +
            `npm ci installs ONLY scripts/package.json dependencies — the ROOT package.json does not exist ` +
            `in the image, and a transitively-hoisted package is a resolution accident, not a contract.\n` +
            `ESM resolves the whole static closure eagerly, so the cron crashes at startup even if the ` +
            `importing code never runs.\n` +
            `Fix: declare the package in scripts/package.json (and refresh scripts/package-lock.json), ` +
            `or break the import chain so the seeder no longer reaches it:\n\n  ${violations.join('\n\n  ')}`,
        );
      });

      it('walk reaches the entry itself (walker-regression canary)', () => {
        for (const r of roots) {
          assert.ok(
            visited.has(r),
            `${relative(root, r)} not visited — an edge class was silently dropped from the walk`,
          );
        }
      });
    });
  }
});
