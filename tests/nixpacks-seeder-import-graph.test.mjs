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

// The one service whose crash created this guard. A floor alone (MIN_SERVICES,
// below) would still pass if THIS service were dropped from the config or its
// crashing member unwired, so pin the #5266 crash path explicitly: the guard
// must keep walking the exact graph that took production down.
//
// minVisited is a tight floor against a silently-shrunken walk — a dropped edge
// class shrinks the graph without producing any violation. Margin of 0 over the
// current actual count (15 as of 2026-07-13), matching the sibling guard's
// rationale for its small graphs: a single silently-dropped module must already
// trip it. If modules are legitimately removed, update this alongside.
const MUST_COVER = {
  service: 'seed-bundle-relay-backup',
  member: 'seed-global-tenders.mjs',
  minVisited: 15,
  deepNodes: [
    'scripts/_bundle-runner.mjs', // the entry's own closure
    'scripts/seed-global-tenders.mjs', // the member that crashed (#5266)
    'scripts/_global-tenders.mjs', // reached only THROUGH that member
    'scripts/_seed-utils.mjs',
  ],
};

// Resolve a service's walk roots. Deliberately does NOT assert: it runs while
// the describe() tree is being built, so a throw here would abort every
// service's suite instead of failing one cleanly (same hazard as the
// commented-out-member bug this file's self-test pins). Callers assert on the
// returned shape inside it() blocks.
//
// Bundle entries spawn each member as its OWN process, so every member is an
// independent resolution root — a bad edge in a member crashes that section
// even though the bundle entry itself resolved cleanly.
function resolveRoots(entry) {
  const entryPath = join(root, entry);
  const entryExists = existsSync(entryPath);
  const src = entryExists ? readFileSync(entryPath, 'utf-8') : '';
  const members = extractBundleMembers(src);
  const memberPaths = members.map((m) => join(scriptsDir, m));
  return {
    entryPath,
    entryExists,
    // A bundle entry statically imports only _bundle-runner.mjs; its members
    // load via `script:` keys + spawn(). So if this regex ever drifts, members
    // goes empty, the walk covers the entry alone, and the suite stays GREEN
    // while the real seeders go unwalked. Proven: with members=[] the walk
    // reports ZERO violations on the #5266 papaparse crash. Hence the
    // declares-at-least-one-member assertion below.
    isBundle: /runBundle\s*\(/.test(src),
    members,
    missingMembers: memberPaths.filter((p) => !existsSync(p)),
    roots: [entryPath, ...memberPaths].filter((p) => existsSync(p)),
  };
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
    '  { label: "Template", script: `seed-template.mjs`, intervalMs: HOUR },',
    "  // { label: 'Disabled', script: 'seed-deleted.mjs' },  <- temporarily disabled",
    '  /* { label: "BlockDisabled", script: "seed-block-gone.mjs" }, */',
    ']);',
  ].join('\n');

  it('finds members regardless of quote style (single, double, backtick)', () => {
    // The regex accepts all three delimiters, so all three must be pinned: an
    // unmatched ADDED member silently escapes the walk, which is the same
    // coverage hole as an empty member list.
    const members = extractBundleMembers(SYNTH);
    assert.ok(members.includes('seed-single.mjs'), 'single-quoted member missing');
    assert.ok(members.includes('seed-double.mjs'), 'double-quoted member missing');
    assert.ok(members.includes('seed-template.mjs'), 'template-literal member missing');
  });

  it('ignores commented-out members (line and block)', () => {
    // A disabled member is the natural way to park a section. Left unstripped,
    // its path reaches the existsSync check while the describe() tree is being
    // built, and if the file still exists it gets walked and can raise a
    // violation for code the container never loads.
    const members = extractBundleMembers(SYNTH);
    assert.deepEqual(
      members,
      ['seed-single.mjs', 'seed-double.mjs', 'seed-template.mjs'],
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
    // The floor alone permits dropping exactly one service and staying green —
    // including the one whose crash created this guard. Pin it by name.
    assert.ok(
      services.some((s) => s.service === MUST_COVER.service),
      `${MUST_COVER.service} is no longer in the nixpacks-root-scripts set — the #5266 crash path is unguarded. ` +
        `If the service was genuinely retired, retarget MUST_COVER at a surviving bundle rather than deleting the canary`,
    );
  });

  for (const svc of services) {
    describe(svc.service, () => {
      const { entryPath, entryExists, isBundle, members, missingMembers, roots } = resolveRoots(svc.entry);
      const { violations, unresolved, visited } = walkContainerGraph(roots, contract);

      it('entry and every declared bundle member exist on disk', () => {
        assert.ok(entryExists, `railway-services.json entry missing on disk: ${svc.entry}`);
        assert.deepEqual(
          missingMembers.map((p) => relative(root, p)),
          [],
          `${svc.entry} declares bundle member(s) that do not exist — the section crashes on spawn`,
        );
      });

      it('a runBundle entry declares at least one member (coverage-integrity canary)', () => {
        // Without this, a renamed `script:` key or a drifted regex empties the
        // member list, the walk silently narrows to the entry (which imports
        // only _bundle-runner.mjs), and the suite goes green while the seeders
        // that actually crash are never walked.
        if (!isBundle) return;
        assert.ok(
          members.length >= 1,
          `${svc.entry} calls runBundle() but the guard extracted 0 members — the \`script:\` key or ` +
            `extractBundleMembers() drifted. The walk would cover the bundle entry alone and pass while ` +
            `every real seeder in it goes unwalked`,
        );
      });

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

      // Asserting the walk visited its own BFS seed roots proves nothing — they
      // are visited by construction, so the check passes even when the member
      // list is empty and the graph has collapsed. Only TRANSITIVELY-reached
      // nodes and a size floor can catch a silently-shrunken walk, so the real
      // canary is pinned on the #5266 crash path below.
      if (svc.service !== MUST_COVER.service) return;

      it('walk still reaches the #5266 crash path (walker-regression canary)', () => {
        assert.ok(
          members.includes(MUST_COVER.member),
          `${MUST_COVER.service} no longer declares ${MUST_COVER.member} — the member whose undeclared ` +
            `papaparse import crashed production. If the seeder moved, retarget MUST_COVER`,
        );
        for (const node of MUST_COVER.deepNodes) {
          assert.ok(
            visited.has(join(root, node)),
            `${node} not visited — an edge class was silently dropped from the walk (visited ${visited.size} files)`,
          );
        }
        assert.ok(
          visited.size >= MUST_COVER.minVisited,
          `graph walk shrank — visited only ${visited.size} modules (floor ${MUST_COVER.minVisited}); ` +
            `if modules were legitimately removed, update MUST_COVER.minVisited alongside the change`,
        );
      });
    });
  }
});
