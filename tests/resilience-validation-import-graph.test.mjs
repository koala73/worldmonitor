// #5231 — static dependency-contract guard for the zero/single-npm-install
// Docker seed-bundle containers.
//
// These containers install (at most) the tsx loader — no scripts/package.json,
// no root node_modules. Everything their entry script reaches — the bundle
// runner, member scripts, scripts/ helpers, and (for resilience-validation)
// the ../server/*.ts modules loaded through tsx — must resolve using node:
// builtins and files the Dockerfile actually COPYs. ESM resolves a module's
// full static import closure eagerly, so ONE bad edge anywhere in that
// closure crashes the cron with ERR_MODULE_NOT_FOUND even if the importing
// code path never runs.
//
// That is exactly how #5229 broke seed-bundle-resilience-validation:
// server/_shared/usage.ts (deep in the closure via redis.ts) gained a static
// import of ./rate-limit, whose own static imports pull @upstash/ratelimit —
// declared only in the ROOT package.json, absent from the container. The
// seeder never calls the rate limiter; it crashed anyway, at resolution time.
//
// The guard enforces four container invariants, per container, with the
// COPY roots, installed-package set, tsx-loader presence, and CMD entry all
// DERIVED from each Dockerfile (so the test cannot drift from the image
// contract — including the entry point it walks and the resolution model
// it simulates):
//   1. every relative import in the reachable graph resolves on disk —
//      under the container's OWN resolution model (a no-tsx container gets
//      plain-node rules: no extension guessing, no TypeScript);
//   2. every resolved file lives inside the container's COPY roots (a module
//      that resolves in the repo but is never COPY'd — e.g. api/ — is the
//      same production crash);
//   3. every bare specifier (static import OR require) is a node builtin or
//      an installed package;
//   4. the Dockerfile CMD entry equals the bundle script this guard walks —
//      an entry swap that left the old file on disk would otherwise keep the
//      guard green while the deployed cron loads an unwalked graph.
//
// Scope notes (kept deliberately aligned with the crash mechanics):
//  - `import type` / `export type` edges are skipped, including the inline
//    all-type form `import { type X } from '...'` (tsx erases both). A mixed
//    clause (`{ type X, real }`) is still a runtime edge.
//  - Comments are stripped (structure-preserving tokenizer) before edge
//    extraction, so commented-out imports and JSDoc `@typedef {import(...)}`
//    text are not edges, while string/template contents are preserved.
//  - Dynamic import() literals are followed only when they resolve into a
//    container's dynamic-follow roots (server/ for resilience-validation —
//    the members execute those unconditionally; loading the scorers IS their
//    job). Unresolvable or computed dynamic imports are out of scope.
//  - createRequire(...)('<spec>') chains are treated as require edges —
//    _seed-utils.mjs eagerly createRequire()s _proxy-utils.cjs at module top
//    level, so that CJS closure loads at seeder startup.
//
// The shared tokenizer/extraction/walk machinery lives in
// tests/_lib/import-graph-walk.mjs (also consumed by the relay and
// digest-notifications Dockerfile guards). The self-test describe blocks
// below exercise that shared machinery with one planted violation of each
// class — so a regex/walker regression fails loudly instead of silently
// blinding all three guards.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBundleMembers, parseDockerfileCopy, walkContainerGraph } from './_lib/import-graph-walk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// --- Dockerfile contract derivation ----------------------------------------

// The Dockerfile is the single source of truth for the container contract:
// directory-level COPY sources (`COPY <dir>/ ./<dir>/`) define where imports
// may resolve; the `npm install` RUN line defines the bare-specifier budget;
// the tsx loader's presence (install line or NODE_OPTIONS --import) defines
// the resolution model; and the CMD line defines the entry whose graph the
// container actually loads. Deriving all four here means an image change
// updates the guard automatically — and a drift makes the guard fail loudly
// instead of silently passing on a contract the image no longer meets.
function parseDockerfileContractSrc(src, label) {
  // Directory-level COPY sources define the containment roots; file-level
  // COPYs (tsconfigs) are not importable modules and are ignored here. The
  // COPY grammar itself is parsed by the shared tests/_lib parser so all
  // three container guards read Dockerfiles identically.
  const copyRoots = [...parseDockerfileCopy(src).directories];

  const installedPackages = new Set();
  const installLines = [...src.matchAll(/^RUN\s+npm\s+install\b[^\n]*/gm)];
  for (const [line] of installLines) {
    // pkg@1.2.3 / pkg@^1.2 / pkg@~1.2 / @scope/pkg@... / pkg@latest / pkg@next
    for (const m of line.matchAll(/\s((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(?=[\d^~]|latest\b|next\b)/g)) {
      installedPackages.add(m[1]);
    }
  }
  if (installLines.length > 0) {
    assert.ok(
      installedPackages.size > 0,
      `${label} has an npm install line but no parseable package@version tokens — update the parser with the Dockerfile refactor`,
    );
  }

  // tsx presence decides the resolution model the container runs under —
  // either an installed tsx package or a NODE_OPTIONS --import of its loader.
  const hasTsx = installedPackages.has('tsx') || /^ENV\s+NODE_OPTIONS="[^"]*tsx[^"]*"/m.test(src);
  // tsx is the ESM loader, wired via NODE_OPTIONS — code importing tsx
  // directly would be a smell this guard should surface, so it does not
  // count toward the bare-specifier budget.
  installedPackages.delete('tsx');

  // CMD ["node", "scripts/<entry>"] — the entry decides which graph the
  // container loads first; buildContract asserts it matches the walked
  // bundle script.
  const cmd = src.match(/^CMD\s+\[\s*"node"\s*,\s*"([^"]+)"\s*\]/m);
  const entryScript = cmd ? cmd[1] : null;

  return { copyRoots, installedPackages, hasTsx, entryScript };
}

function parseDockerfileContract(dockerfileName) {
  return parseDockerfileContractSrc(readFileSync(join(root, dockerfileName), 'utf-8'), dockerfileName);
}

// --- Container contracts under guard ----------------------------------------

// minVisited is a tight sanity floor against a silently-shrunken walk (a
// dropped edge class shrinks the graph without producing violations or
// unresolved entries); deepNodes pin the load-bearing modules explicitly.
// Current actual counts (2026-07-12): resilience-validation 35, portwatch 9.
const CONTAINERS = [
  {
    name: 'seed-bundle-resilience-validation',
    dockerfile: 'Dockerfile.seed-bundle-resilience-validation',
    bundleScript: 'seed-bundle-resilience-validation.mjs',
    minMembers: 3,
    mustIncludeMember: 'validate-resilience-sensitivity.mjs',
    dynamicRoots: ['server'],
    expectsTsx: true,
    minVisited: 32,
    deepNodes: [
      'scripts/_bundle-runner.mjs',
      'scripts/_proxy-utils.cjs',
      'server/_shared/redis.ts',
      'server/_shared/usage.ts',
      'server/_shared/client-ip.ts',
    ],
  },
  {
    name: 'seed-bundle-portwatch-port-activity',
    dockerfile: 'Dockerfile.seed-bundle-portwatch-port-activity',
    bundleScript: 'seed-bundle-portwatch-port-activity.mjs',
    minMembers: 1,
    mustIncludeMember: 'seed-portwatch-port-activity.mjs',
    dynamicRoots: [],
    expectsTsx: false,
    // Margin of 0 over the actual count: this small graph has only 2 deep-node
    // canaries, so a single silently-dropped node must already trip the floor.
    minVisited: 9,
    deepNodes: ['scripts/_bundle-runner.mjs', 'scripts/_proxy-utils.cjs'],
  },
];

const scriptsDir = join(root, 'scripts');

function buildContract(container) {
  const { copyRoots, installedPackages, hasTsx, entryScript } = parseDockerfileContract(container.dockerfile);
  assert.ok(
    copyRoots.includes('scripts'),
    `${container.dockerfile}: no 'COPY scripts/ ...' line parsed — Dockerfile format changed; update parseDockerfileContractSrc`,
  );
  // The CMD entry decides what the deployed container actually loads. If it
  // ever diverges from the bundle script this guard walks, the guard would
  // stay green (the stale file still exists on disk) while the cron loads a
  // completely unwalked graph — so the divergence itself must fail loudly.
  assert.ok(
    entryScript,
    `${container.dockerfile}: no parseable CMD ["node", "<script>"] line — Dockerfile format changed; update parseDockerfileContractSrc`,
  );
  assert.equal(
    entryScript,
    `scripts/${container.bundleScript}`,
    `${container.dockerfile} CMD entry (${entryScript}) != the guard's walk root (scripts/${container.bundleScript}) — ` +
      `update bundleScript alongside the CMD change so the guard walks what the container runs`,
  );
  // The resolution model must match the runtime: a no-tsx container cannot
  // load .ts or extensionless specifiers that tsx would resolve.
  assert.equal(
    hasTsx,
    container.expectsTsx,
    `${container.dockerfile}: tsx-loader detection (${hasTsx}) != expected (${container.expectsTsx}) — ` +
      `if the image's loader setup changed, update expectsTsx so the guard simulates the right resolution model`,
  );
  return {
    repoRoot: root,
    copyRootDirs: copyRoots.map((d) => join(root, d)),
    dynamicRootDirs: container.dynamicRoots.map((d) => join(root, d)),
    installedPackages,
    hasTsx,
  };
}

function walkRootsFor(container) {
  const bundleSrc = readFileSync(join(scriptsDir, container.bundleScript), 'utf-8');
  // Shared with the nixpacks guard (#5289): quote-agnostic (an ADDED member in
  // double quotes must not escape the walk — minMembers is only a floor) and
  // comment-stripped (a DISABLED member must not be walked, nor abort the
  // suite via the existsSync assert below).
  const members = extractBundleMembers(bundleSrc);
  assert.ok(
    members.length >= container.minMembers,
    `${container.bundleScript}: expected >=${container.minMembers} member scripts, found ${members.length} — bundle definition or the member regex drifted`,
  );
  assert.ok(
    members.includes(container.mustIncludeMember),
    `${container.bundleScript}: expected member ${container.mustIncludeMember} missing — bundle definition or the member regex drifted`,
  );
  // The entry script's own closure (-> _bundle-runner.mjs) resolves FIRST in
  // the container (it is the CMD), before any member spawns — walk it too.
  const roots = [join(scriptsDir, container.bundleScript), ...members.map((m) => join(scriptsDir, m))];
  for (const r of roots) {
    assert.ok(existsSync(r), `walk root missing on disk: ${relative(root, r)}`);
  }
  return roots;
}

for (const container of CONTAINERS) {
  describe(`${container.name} container import graph (#5231)`, () => {
    const contract = buildContract(container);
    const { violations, unresolved, visited } = walkContainerGraph(walkRootsFor(container), contract);

    it('every relative import resolves on disk', () => {
      assert.deepEqual(
        unresolved,
        [],
        `unresolvable relative import(s) — these crash the cron with ERR_MODULE_NOT_FOUND:\n\n  ${unresolved.join('\n\n  ')}`,
      );
    });

    it('reaches no bare specifier or COPY-set escape the container cannot resolve', () => {
      assert.deepEqual(
        violations,
        [],
        `import(s) reachable from ${container.name} that its container cannot resolve ` +
          `(${container.dockerfile} defines the COPY roots, the installed-package budget, and the loader). ESM resolves ` +
          `these eagerly, so the cron crashes with ERR_MODULE_NOT_FOUND even if the importing code never ` +
          `runs. Break the import chain (extract a dependency-free module) or change the container image:\n\n  ${violations.join('\n\n  ')}`,
      );
    });

    it('walk reaches the load-bearing deep nodes (walker-regression canary)', () => {
      for (const node of container.deepNodes) {
        assert.ok(
          visited.has(join(root, node)),
          `${node} not visited — an edge class was silently dropped from the walk (visited ${visited.size} files)`,
        );
      }
      assert.ok(
        visited.size >= container.minVisited,
        `graph walk shrank — visited only ${visited.size} modules (floor ${container.minVisited}); ` +
          `if files were legitimately removed, update minVisited alongside the change`,
      );
    });
  });
}

// --- Dockerfile contract parser self-test (synthetic Dockerfile text) --------

describe('parseDockerfileContractSrc self-test (synthetic Dockerfiles)', () => {
  const SYNTH_TSX_INSTALL = [
    'FROM node:24-alpine@sha256:abc',
    'WORKDIR /app',
    'RUN npm install --prefix /app --no-save @org/pkg@1.2.3 lodash@^4.17.0 semver@~7.5.0 leftpad@latest tsx@4.21.0',
    'COPY scripts/ ./scripts/',
    'COPY shared/ ./shared/',
    'COPY tsconfig.json ./',
    'ENV NODE_OPTIONS="--max-old-space-size=1024"',
    'CMD ["node", "scripts/my-entry.mjs"]',
  ].join('\n');

  it('extracts a populated installed-package budget (scoped, caret, tilde, latest; tsx excluded)', () => {
    const { installedPackages } = parseDockerfileContractSrc(SYNTH_TSX_INSTALL, 'synthetic');
    assert.deepEqual(
      [...installedPackages].sort(),
      ['@org/pkg', 'leftpad', 'lodash', 'semver'],
      'install-line extraction must handle scoped packages, range prefixes, and dist-tags on one RUN line',
    );
  });

  it('derives COPY roots, CMD entry, and tsx presence from an install line', () => {
    const { copyRoots, entryScript, hasTsx } = parseDockerfileContractSrc(SYNTH_TSX_INSTALL, 'synthetic');
    assert.deepEqual(copyRoots, ['scripts', 'shared'], 'dir-level COPY roots only (file COPYs excluded)');
    assert.equal(entryScript, 'scripts/my-entry.mjs');
    assert.equal(hasTsx, true, 'tsx@ on the install line must mark the container tsx-shaped');
  });

  it('detects tsx via NODE_OPTIONS --import when nothing is npm-installed', () => {
    const viaNodeOptions = parseDockerfileContractSrc(
      'ENV NODE_OPTIONS="--max-old-space-size=8192 --import=file:///app/node_modules/tsx/dist/loader.mjs"\nCOPY scripts/ ./scripts/\nCMD ["node", "scripts/e.mjs"]',
      'synthetic',
    );
    assert.equal(viaNodeOptions.hasTsx, true);
    const plain = parseDockerfileContractSrc(
      'ENV NODE_OPTIONS="--max-old-space-size=1024 --dns-result-order=ipv4first"\nCOPY scripts/ ./scripts/\nCMD ["node", "scripts/e.mjs"]',
      'synthetic',
    );
    assert.equal(plain.hasTsx, false, 'no install line and no tsx in NODE_OPTIONS = plain node');
    assert.equal(plain.entryScript, 'scripts/e.mjs');
  });

  it('reports a missing/unparseable CMD as null so buildContract fails loudly', () => {
    const { entryScript } = parseDockerfileContractSrc('COPY scripts/ ./scripts/\n', 'synthetic');
    assert.equal(entryScript, null);
  });
});

// --- Guard self-test: the walker must still catch each violation class ------

describe('import-graph guard self-test (synthetic fixtures)', () => {
  let fixRoot;
  let result;

  before(() => {
    fixRoot = mkdtempSync(join(tmpdir(), 'wm-import-graph-guard-'));
    const write = (rel, content) => {
      const p = join(fixRoot, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    };

    write(
      'scripts/entry.mjs',
      [
        "import './helper.mjs';",
        "import './regex-hazards.mjs';",
        "import './nested-cr.mjs';",
        "import 'node:fs';",
        "import 'ok-npm-pkg';",
        "// import './commented-out.mjs'",
        "import { createRequire } from 'node:module';",
        "const load = createRequire(import.meta.url)('./util.cjs');",
        "const scorer = import('../srv/scorer.ts');",
        '',
      ].join('\n'),
    );
    write(
      'scripts/helper.mjs',
      [
        'import {',
        '  aThing,',
        '  bThing,',
        "} from './deep/multi.mjs';",
        "import type { Phantom } from 'phantom-types-pkg';",
        "import { type PhantomInline } from 'phantom-inline-pkg';",
        "import { type MixedT, mixedReal } from 'mixed-type-pkg';",
        "import '@evil/bare-pkg';",
        '',
      ].join('\n'),
    );
    write('scripts/deep/multi.mjs', "import { esc } from '../../api/outside.js';\nexport const aThing = 1;\nexport const bThing = 2;\n");
    write('scripts/util.cjs', "const p = require('node:path');\nconst bad = require('bad-npm-cjs');\nconst ok = require('@scope/ok-pkg/sub');\nmodule.exports = { p, bad, ok };\n");
    write('srv/scorer.ts', "import gone from './gone';\nexport default gone;\n");
    write('api/outside.js', 'export const esc = true;\n');
    // Tokenizer hazards: a regex literal containing /* (or //) must not flip
    // the stripper into comment state and swallow the edges after it — a
    // swallowed BARE edge raises no violation and no canary, so only this
    // fixture proves the case. Division and URL strings pin the flip side
    // (a `/` in value position must NOT start a regex literal).
    write(
      'scripts/regex-hazards.mjs',
      [
        "import './entry-was-not-swallowed.mjs';",
        'const classSlashStar = /[/*]/;',
        'const escapedSlashes = /a\\/\\*b/;',
        'const division = 4 / 2 + 8 / 4;',
        "const url = 'https://example.com/x?a=1'; // trailing comment",
        "import 'bare-after-regex-pkg';",
        "import './after-regex.mjs';",
        '',
      ].join('\n'),
    );
    write('scripts/entry-was-not-swallowed.mjs', 'export const alive = 1;\n');
    write('scripts/after-regex.mjs', 'export const reached = 1;\n');
    // The common nested-parens createRequire idiom — the extraction regex must
    // cross the inner call's parens to find the specifier.
    write(
      'scripts/nested-cr.mjs',
      [
        "import { createRequire } from 'node:module';",
        "import { fileURLToPath } from 'node:url';",
        "const load = createRequire(fileURLToPath(import.meta.url))('./nested-target.cjs');",
        '',
      ].join('\n'),
    );
    write('scripts/nested-target.cjs', "const bad = require('bad-nested-cjs-pkg');\nmodule.exports = { bad };\n");

    result = walkContainerGraph([join(fixRoot, 'scripts/entry.mjs')], {
      repoRoot: fixRoot,
      copyRootDirs: [join(fixRoot, 'scripts'), join(fixRoot, 'srv')],
      dynamicRootDirs: [join(fixRoot, 'srv')],
      installedPackages: new Set(['ok-npm-pkg', '@scope/ok-pkg']),
      hasTsx: true,
    });
  });

  after(() => {
    rmSync(fixRoot, { recursive: true, force: true });
  });

  it('flags a bare npm static import (the #5229 class)', () => {
    assert.ok(
      result.violations.some((v) => v.includes("'@evil/bare-pkg' statically imported")),
      `missing bare-import violation; got:\n${result.violations.join('\n')}`,
    );
  });

  it('flags a bare require() in an eagerly-loaded CJS closure', () => {
    assert.ok(
      result.violations.some((v) => v.includes("'bad-npm-cjs' require()d")),
      `missing bare-require violation (createRequire edge not followed?); got:\n${result.violations.join('\n')}`,
    );
  });

  it('allows installed packages through the budget (import AND scoped subpath require)', () => {
    // The allow-path: a package the Dockerfile installs must NOT be flagged.
    // Guards the extraction-to-budget wiring that the always-empty production
    // set never exercises (both real containers install only tsx today).
    assert.ok(
      !result.violations.some((v) => v.includes('ok-npm-pkg')),
      `installed package 'ok-npm-pkg' wrongly flagged:\n${result.violations.join('\n')}`,
    );
    assert.ok(
      !result.violations.some((v) => v.includes('@scope/ok-pkg')),
      `installed scoped package '@scope/ok-pkg' (required via subpath) wrongly flagged:\n${result.violations.join('\n')}`,
    );
  });

  it('flags a relative import that resolves outside the COPY roots', () => {
    assert.ok(
      result.violations.some((v) => v.includes('OUTSIDE the container COPY set') && v.includes('api')),
      `missing COPY-set containment violation; got:\n${result.violations.join('\n')}`,
    );
  });

  it('reports an unresolvable relative import (through the dynamic-follow root)', () => {
    assert.ok(
      result.unresolved.some((u) => u.includes("'./gone'")),
      `missing unresolved entry (dynamic follow into srv/ broken?); got:\n${result.unresolved.join('\n')}`,
    );
  });

  it('follows multi-line imports and skips comments and type-only imports (leading and inline)', () => {
    assert.ok(result.visited.has(join(fixRoot, 'scripts/deep/multi.mjs')), 'multi-line import edge not followed');
    assert.ok(
      !result.violations.some((v) => v.includes('phantom-types-pkg')),
      'import type must not count as an edge',
    );
    assert.ok(
      !result.violations.some((v) => v.includes('phantom-inline-pkg')),
      'inline all-type clause (import { type X }) must not count as an edge — tsx erases it',
    );
    assert.ok(
      result.violations.some((v) => v.includes("'mixed-type-pkg' statically imported")),
      `a mixed clause (import { type T, real }) IS a runtime edge and must be flagged; got:\n${result.violations.join('\n')}`,
    );
    assert.ok(
      ![...result.visited].some((f) => f.includes('commented-out')),
      'commented-out import must not be walked',
    );
  });

  it('regex literals containing /* do not swallow the edges after them', () => {
    // The dangerous variant: /[/*]/ used to flip the tokenizer into
    // block-comment state and eat to EOF — dropping BOTH a bare edge (no
    // violation, no canary) and a relative edge. Prove both survive.
    assert.ok(
      result.violations.some((v) => v.includes("'bare-after-regex-pkg' statically imported")),
      `bare import after a /[/*]/ regex literal was swallowed:\n${result.violations.join('\n')}`,
    );
    assert.ok(
      result.visited.has(join(fixRoot, 'scripts/after-regex.mjs')),
      'relative import after a /[/*]/ regex literal was swallowed',
    );
    assert.ok(
      result.visited.has(join(fixRoot, 'scripts/entry-was-not-swallowed.mjs')),
      'edge BEFORE the regex hazards must be unaffected',
    );
  });

  it('follows the nested-parens createRequire(fileURLToPath(...))(...) idiom', () => {
    assert.ok(
      result.visited.has(join(fixRoot, 'scripts/nested-target.cjs')),
      'createRequire with a nested call argument was not followed',
    );
    assert.ok(
      result.violations.some((v) => v.includes("'bad-nested-cjs-pkg' require()d")),
      `bare require inside the nested-createRequire target was not enforced:\n${result.violations.join('\n')}`,
    );
  });
});

// --- Plain-node (no-tsx) resolution self-test --------------------------------

describe('plain-node container resolution self-test (hasTsx: false)', () => {
  let fixRoot;
  let plain;
  let withTsx;

  before(() => {
    fixRoot = mkdtempSync(join(tmpdir(), 'wm-import-graph-plainnode-'));
    const write = (rel, content) => {
      const p = join(fixRoot, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    };

    write(
      'scripts/entry.mjs',
      ["import './plain-ok.mjs';", "import './no-ext';", "import './typed.ts';", ''].join('\n'),
    );
    write('scripts/plain-ok.mjs', 'export const ok = 1;\n');
    write('scripts/no-ext.mjs', 'export const x = 1;\n'); // exists only WITH extension
    write('scripts/typed.ts', 'export const t = 1;\n');

    const contract = (hasTsx) => ({
      repoRoot: fixRoot,
      copyRootDirs: [join(fixRoot, 'scripts')],
      dynamicRootDirs: [],
      installedPackages: new Set(),
      hasTsx,
    });
    plain = walkContainerGraph([join(fixRoot, 'scripts/entry.mjs')], contract(false));
    withTsx = walkContainerGraph([join(fixRoot, 'scripts/entry.mjs')], contract(true));
  });

  after(() => {
    rmSync(fixRoot, { recursive: true, force: true });
  });

  it('flags extensionless and .ts edges a plain-node container cannot load', () => {
    // The green-while-red hole this closes: these edges work under tsx in
    // every other repo context (and in the resilience-validation container),
    // so only a per-container resolution model catches them before the
    // portwatch cron crashes at import time.
    assert.ok(
      plain.violations.some((v) => v.includes("'./no-ext'") && v.includes('plain node')),
      `missing plain-node violation for extensionless specifier; got:\n${plain.violations.join('\n')}`,
    );
    assert.ok(
      plain.violations.some((v) => v.includes("'./typed.ts'") && v.includes('plain node')),
      `missing plain-node violation for .ts specifier; got:\n${plain.violations.join('\n')}`,
    );
  });

  it('still walks literal loadable specifiers, and the same edges pass under tsx', () => {
    assert.ok(plain.visited.has(join(fixRoot, 'scripts/plain-ok.mjs')), 'literal .mjs edge must still be walked');
    assert.deepEqual(withTsx.violations, [], 'the identical graph must be violation-free under a tsx-shaped contract');
    assert.deepEqual(plain.unresolved, [], 'plain-node misfits are violations (with chains), not unresolved entries');
  });
});
