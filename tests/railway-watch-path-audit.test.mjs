import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sourceBootstrapsTsx } from './helpers/tsx-bootstrap.mjs';

import {
  auditRailwayServiceConfig,
  buildRailwayEditArgs,
  buildRailwayServiceConfigPatch,
  managedRailwayServices,
  readArgument,
  serializeRailwayServiceConfigPatch,
  waitForRailwayServiceConfigConvergence,
} from '../scripts/audit-railway-watch-paths.mjs';
import {
  extractBundleMembers,
  parseDockerfileCopy,
  readStrippedSource,
  walkContainerGraph,
} from './_lib/import-graph-walk.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAILWAY_SERVICE_REGISTRY = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
);

function service({
  cronSchedule = '0 * * * *',
  dockerfilePath,
  variables = {},
  watchPatterns = [],
} = {}) {
  return {
    source: { repo: 'koala73/worldmonitor', rootDirectory: 'scripts' },
    build: {
      watchPatterns,
      ...(dockerfilePath === undefined ? {} : { dockerfilePath }),
    },
    deploy: { cronSchedule, startCommand: 'node seed-example.mjs' },
    variables,
  };
}

const NIXPACKS_BUILD_FILES = Object.freeze([
  'scripts/package.json',
  'scripts/package-lock.json',
  'scripts/nixpacks.toml',
]);

// A `nixpacks-root-repo` service builds from the repository root, so it reads
// the ROOT nixpacks.toml — and that file runs `npm ci`, `npm install` AND
// `npm install --prefix scripts`, so BOTH dependency trees are build inputs.
// None of these appear in any import graph, which is exactly why they have to
// be named: a lockfile bump changes the image and nothing in the walk notices.
const ROOT_NIXPACKS_BUILD_FILES = Object.freeze([
  'nixpacks.toml',
  'package.json',
  'package-lock.json',
  'scripts/package.json',
  'scripts/package-lock.json',
]);

const INSTALL_MANIFESTS = Object.freeze([
  'scripts/package.json',
  'scripts/package-lock.json',
  'package.json',
  'package-lock.json',
]);

// Dockerfile.relay derives this ignored runtime artifact from authoritative
// registries. These are build inputs, not runtime imports. Keep the list closed
// so broad wildcards cannot silently expand the relay's deployment surface.
const RELAY_INVENTORY_BUILD_INPUTS = Object.freeze([
  'scripts/docs-stats.mjs',
  'scripts/generate-inventory-facts.mjs',
  'scripts/source-attribution.mjs',
  'shared/source-attribution-manifest.json',
  'public/.well-known/mcp/server-card.json',
  'src/components/**/*.ts',
  'src/config/feeds.ts',
  'src/config/map-layer-definitions.ts',
  'src/config/variants/*.ts',
  'src/locales/*.json',
  'src/services/data-freshness.ts',
]);
const RELAY_GENERATED_RUNTIME_OUTPUT = 'scripts/shared/inventory-facts.generated.json';

function pathPatternMatches(pattern, path) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char !== '*') {
      expression += /[.+?^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
      continue;
    }
    if (pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else {
        expression += '.*';
      }
    } else {
      expression += '[^/]*';
    }
  }
  return new RegExp(`^${expression}$`, 'u').test(path);
}

function patternHasRepositoryMatch(pattern) {
  if (!pattern.includes('*')) return existsSync(resolve(repoRoot, pattern));
  const slash = pattern.lastIndexOf('/', pattern.indexOf('*'));
  const directory = slash === -1 ? '' : pattern.slice(0, slash);
  return readFilePaths(resolve(repoRoot, directory), directory)
    .some((path) => pathPatternMatches(pattern, path));
}

function readFilePaths(directory, relativeDirectory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...readFilePaths(resolve(directory, entry.name), path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

/**
 * Which dependency manifests a Dockerfile installs from.
 *
 * Exact token match on its own COPY lines, never a substring: `COPY
 * package.json` and `COPY scripts/package.json` are different build inputs, and
 * a substring test would report the root manifest for every image that copies
 * the scripts one.
 */
function manifestsCopiedBy(dockerfileSource) {
  const copied = new Set();
  for (const line of dockerfileSource.split('\n')) {
    if (!/^\s*COPY\b/.test(line)) continue;
    for (const token of line.trim().split(/\s+/).slice(1)) {
      if (token.startsWith('--')) continue;
      if (INSTALL_MANIFESTS.includes(token)) copied.add(token);
    }
  }
  return copied;
}

function repositoryCopyInputs(dockerfileSource) {
  const repositoryCopySource = dockerfileSource
    .split('\n')
    .filter((line) => !/^COPY\s+--from=/u.test(line))
    .join('\n');
  return parseDockerfileCopy(repositoryCopySource);
}

/**
 * The BUILD inputs a service's closure must name, on top of its runtime graph.
 *
 * One definition, used for both directions of the contract below: every member
 * must be watched, and a watched member is never "stale" for not appearing in
 * the import graph — by construction none of them ever does.
 */
function buildInputsFor(entry, repoRootDir) {
  const inputs = new Set();
  if (entry.deployMode === 'nixpacks-root-scripts') {
    for (const file of NIXPACKS_BUILD_FILES) inputs.add(file);
  }
  if (entry.deployMode === 'nixpacks-root-repo') {
    for (const file of ROOT_NIXPACKS_BUILD_FILES) inputs.add(file);
  }
  if (entry.dockerfile) {
    inputs.add(entry.dockerfile);
    inputs.add('.dockerignore');
    const source = readFileSync(resolve(repoRootDir, entry.dockerfile), 'utf8');
    // A repository file copied directly into the image is a build input even
    // when it is a patch, fixture, declaration, or config that the runtime
    // import graph cannot see. Stage-to-stage COPY sources are image-local and
    // must not become repository watch paths.
    const copied = repositoryCopyInputs(source);
    for (const file of copied.files) {
      if (file !== '.') inputs.add(file);
    }
    if (/^RUN node scripts\/generate-inventory-facts\.mjs$/mu.test(source)) {
      for (const file of RELAY_INVENTORY_BUILD_INPUTS) inputs.add(file);
    }
  }
  return inputs;
}

// walkContainerGraph only follows import/require/dynamic-import edges, so a data
// file pulled in with fs is invisible to it -- and one already is:
// scripts/seed-supply-chain-trade.mjs reads scripts/shared/un-to-iso2.json via
// readFileSync(join(__dirname, ...)). Without this extractor the closure guard
// cannot tell whether such a path is watched, which is exactly the
// silently-skipped-deployment class the registry exists to prevent.
function extractFileReadDependencies(files, repoRootDir) {
  const dependencies = new Set();
  const add = (fromFile, ...segments) => {
    const resolved = resolve(dirname(fromFile), ...segments);
    if (!resolved.startsWith(repoRootDir)) return;
    if (!existsSync(resolved)) return;
    dependencies.add(relative(repoRootDir, resolved));
  };
  for (const file of files) {
    if (!/\.[cm]?[jt]s$/u.test(file)) continue;
    const source = readStrippedSource(file);
    // readFileSync(join(__dirname, 'shared', 'x.json')) -- any local alias of
    // readFileSync/join (the seeders import them as _readFileSync/_join).
    for (const match of source.matchAll(
      /\b_?readFileSync\s*\(\s*_?join\(\s*__dirname\s*,\s*((?:['"][^'"]+['"]\s*,\s*)*['"][^'"]+['"])\s*\)/gu,
    )) {
      const segments = [...match[1].matchAll(/['"]([^'"]+)['"]/gu)].map((m) => m[1]);
      if (segments.length > 0) add(file, ...segments);
    }
    // readFileSync(new URL('./x.json', import.meta.url))
    for (const match of source.matchAll(
      /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
    )) {
      add(file, match[1]);
    }
  }
  return dependencies;
}

// A quoted filename with a data or script extension, optionally relative-prefixed.
const LITERAL_PATH_RE = /['"`]((?:\.{1,2}\/)*[\w-][\w./-]*\.(?:json|ya?ml|csv|txt|sql|mjs|cjs|js))['"`]/gu;
const SCRIPT_EXTENSION_RE = /\.[cm]?js$/u;

// Where a bare literal filename inside `file` can plausibly resolve.
//
// Deliberately a SMALL fixed set of siblings rather than a repository-wide
// search by basename: these are the directories the seeders actually reach for,
// and a wider net would start claiming unrelated files that happen to share a
// name. Over-claiming here costs a build; under-claiming strands a service.
function literalBasesFor(file) {
  const dir = dirname(file);
  return [
    dir,
    resolve(dir, 'data'),
    resolve(dir, 'shared'),
    resolve(dir, '..', 'shared'),
    resolve(dir, '..', 'data'),
  ];
}

/**
 * Files named by a string literal, whatever the call around it looks like.
 *
 * extractFileReadDependencies below matches two exact call SHAPES, and the
 * fleet uses more than two. All of these evade it, and each one was a service
 * that would have sat on stale code forever:
 *
 *   scripts/_energy-disruption-registry.mjs:37  readFileSync(resolve(__dirname, 'data', 'x.json'))
 *   scripts/shared/rankable-universe.mjs:47     const P = resolve(here, 'x.json'); readFileSync(P)
 *   scripts/shared/swf-manifest-loader.mjs:27   the same, for a .yaml manifest
 *   scripts/ais-relay.cjs:56                    require(path.join(__dirname, '..', 'shared', name))
 *
 * Matching the LITERAL rather than the call is what makes this robust: a new
 * seeder inventing a fourth way to build a path is still covered, because the
 * filename has to appear somewhere.
 */
function extractLiteralPathDependencies(files, repoRootDir) {
  const found = new Set();
  for (const file of files) {
    if (!/\.[cm]?[jt]s$/u.test(file)) continue;
    const source = readStrippedSource(file);
    for (const match of source.matchAll(LITERAL_PATH_RE)) {
      // EVERY base that resolves, never the first one. shared/ is mirrored at
      // the repository root AND under scripts/ — `stocks.json` exists in both —
      // and scripts/ais-relay.cjs:56 resolves `../shared` FIRST while this list
      // reaches scripts/shared first. Stopping at one match picked the copy the
      // service does not load, which watches a file that never changes while the
      // one it reads goes unwatched. Claiming both costs a build; guessing
      // strands the service.
      for (const base of literalBasesFor(file)) {
        const candidate = resolve(base, match[1]);
        if (!candidate.startsWith(repoRootDir)) continue;
        if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
        found.add(candidate);
      }
    }
  }
  return found;
}

// A scripts-root seeder can self-register tsx immediately before a dynamic
// TypeScript import. The plain-Node import walker sees the entry module but
// cannot follow the loader-enabled graph, so those seeders declare each exact
// transitive file. Missing declarations fail the normal closure comparison;
// stale or missing paths fail here instead of silently widening the watch set.
function extractDeclaredRuntimeDependencies(files, repoRootDir) {
  const found = new Set();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/@railway-runtime-dependency\s+(\.{1,2}\/[^\s*]+)/gu)) {
      const candidate = resolve(dirname(file), match[1]);
      assert.ok(candidate.startsWith(repoRootDir), `runtime dependency escapes repository: ${match[1]}`);
      assert.ok(existsSync(candidate) && statSync(candidate).isFile(), `runtime dependency does not exist: ${match[1]}`);
      found.add(candidate);
    }
  }
  return found;
}

/**
 * The resolution model a Dockerfile-built container actually runs under.
 *
 * Hardcoding `hasTsx: false` and scripts-only dynamic roots was wrong for
 * exactly one service, and wrong in the direction that strands it.
 * Dockerfile.seed-bundle-resilience-validation installs tsx and COPYs
 * `server/`, and scripts/validate-resilience-sensitivity.mjs:169-185
 * dynamic-imports four `../server/worldmonitor/resilience/v1/*.ts` modules. A
 * scripts-only, tsx-less walk cannot follow one of those edges, so the derived
 * closure contained ZERO server/ paths — and this service was previously
 * unmanaged, i.e. protected by the broad fallback. Narrowing it would have
 * removed that floor and stopped server/ changes from ever rebuilding the
 * image, under a green "complete closure" check.
 *
 * Derived from the image rather than assumed, and read with the same
 * tests/_lib parser the sibling container guards use, so all of them read a
 * Dockerfile identically. tests/resilience-validation-import-graph.test.mjs
 * independently pins this same container as tsx + server/.
 */
function dockerfileContainerContract(dockerfileName, repoRootDir) {
  const source = readFileSync(resolve(repoRootDir, dockerfileName), 'utf8');
  const directories = [...parseDockerfileCopy(source).directories];
  return {
    // Anything the image copies in is somewhere a dynamic import can land.
    dynamicRoots: directories.map((directory) => resolve(repoRootDir, directory)),
    hasTsx: /^RUN\s+npm\s+install\b[^\n]*\stsx@/m.test(source)
      || /^ENV\s+NODE_OPTIONS="[^"]*tsx[^"]*"/m.test(source),
  };
}

/**
 * A service's full runtime surface: the import graph, plus everything reached by
 * a mechanism the import graph cannot express.
 *
 * Iterates to a fixed point because a literal naming an executable script is a
 * SPAWN edge, and the spawned file's whole import subgraph ships in the image.
 * scripts/ais-relay.cjs:6367/:6442 runs
 * `execFile(process.execPath, [path.join(__dirname, 'seed-climate-news.mjs')])`,
 * so seed-climate-news.mjs and everything IT imports — _seed-utils.mjs and
 * lib/llm-telemetry.cjs among them, which Dockerfile.relay calls
 * startup-crash-critical — are relay's dependencies with no import statement
 * anywhere connecting them. Feed such a literal back as a walk root and repeat.
 */
function resolveRuntimeSurface(entry, repoRootDir) {
  const scriptsDir = resolve(repoRootDir, 'scripts');
  const entryPath = resolve(repoRootDir, entry.entry);
  const roots = new Set([
    entryPath,
    ...extractBundleMembers(readFileSync(entryPath, 'utf8'))
      .map((member) => resolve(repoRootDir, 'scripts', member)),
  ]);

  // A scripts-root seeder can self-register the tsx loader and then dynamically
  // import `.mts`. Hardcoding hasTsx:false made the walker blind to those edges,
  // so the closure came out too NARROW: a transitive `.mts` nobody remembered to
  // declare with @railway-runtime-dependency was invisible to BOTH checks -- the
  // declared-set comparison never saw it, and the walk never reached it -- and
  // Railway would skip the deploy behind a green badge.
  //
  // The registration lives in the bundle MEMBER, not the bundle entry, so this
  // asks every root, not just entryPath. Erring toward following the edges is
  // the safe direction here, for the same reason containment stays permissive
  // below: a closure that is too wide costs a build, one that is too narrow
  // strands the service.
  const rootsBootstrapTsx = (candidates) => [...candidates]
    .some((root) => existsSync(root) && statSync(root).isFile() && sourceBootstrapsTsx(readFileSync(root, 'utf8')));

  // Containment stays permissive at the repository root on purpose: including
  // a file the image does not ship costs a build, excluding one the image DOES
  // ship strands the service. Only the dynamic-follow roots and the loader
  // model come from the image, because those decide which edges exist at all.
  const container = entry.dockerfile
    ? dockerfileContainerContract(entry.dockerfile, repoRootDir)
    : { dynamicRoots: [scriptsDir], hasTsx: rootsBootstrapTsx(roots) };

  let visited = new Set();
  let unresolved = [];
  let literals = new Set();
  let converged = false;
  // Bounded: each pass must ADD a root to continue, and the root set is bounded
  // by the repository. The cap only stops a pathological cycle from hanging CI —
  // and hitting it is reported rather than accepted, because an unconverged walk
  // yields a closure that is too NARROW, the one direction that strands a
  // service.
  for (let pass = 0; pass < 8 && !converged; pass += 1) {
    ({ visited, unresolved } = walkContainerGraph([...roots], {
      repoRoot: repoRootDir,
      copyRootDirs: [scriptsDir, repoRootDir],
      dynamicRootDirs: container.dynamicRoots,
      installedPackages: new Set(),
      hasTsx: container.hasTsx,
    }));
    literals = extractLiteralPathDependencies(visited, repoRootDir);
    const before = roots.size;
    for (const file of literals) {
      if (SCRIPT_EXTENSION_RE.test(file)) roots.add(file);
    }
    converged = roots.size === before;
  }

  const runtimeFiles = new Set([
    ...[...visited].map((file) => relative(repoRootDir, file)),
    ...[...extractDeclaredRuntimeDependencies(visited, repoRootDir)]
      .map((file) => relative(repoRootDir, file)),
    ...extractSharedConfigDependencies(visited, entry.deployMode),
    ...extractFileReadDependencies(visited, repoRootDir),
    ...[...literals].map((file) => relative(repoRootDir, file)),
  ]);
  return { visited, unresolved, runtimeFiles, converged };
}

function extractSharedConfigDependencies(files, deployMode) {
  const prefix = deployMode === 'nixpacks-root-scripts'
    ? 'scripts/shared'
    : 'shared';
  const dependencies = new Set();
  for (const file of files) {
    if (!/\.[cm]?[jt]s$/u.test(file)) continue;
    const source = readStrippedSource(file);
    for (const match of source.matchAll(/\bloadSharedConfig\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      dependencies.add(`${prefix}/${match[1]}`);
    }
  }
  return dependencies;
}

const managedRegistry = [
  {
    entry: 'scripts/seed-example.mjs',
    service: 'seed-example',
    watchPatterns: [
      'scripts/seed-example.mjs',
      'scripts/_seed-utils.mjs',
      'scripts/package.json',
      'scripts/package-lock.json',
      'scripts/nixpacks.toml',
    ],
    cronSchedule: '*/15 * * * *',
  },
];
const serviceIds = new Map([['seed-example', 'svc-example']]);

describe('Railway operational-config audit', () => {
  it('audits always-on services without reconciling their cron', () => {
    const registry = [{
      service: 'publisher',
      watchPatterns: ['scripts/publish.mjs'],
      cronSchedule: null,
    }];
    assert.deepEqual(
      auditRailwayServiceConfig(
        {
          services: {
            'svc-publisher': service({
              cronSchedule: '*/5 * * * *',
              watchPatterns: ['scripts/**'],
            }),
          },
        },
        new Map([['publisher', 'svc-publisher']]),
        registry,
      ),
      [{
        service: 'publisher',
        serviceId: 'svc-publisher',
        missingService: false,
        watchPatterns: {
          actual: ['scripts/**'],
          expected: ['scripts/publish.mjs'],
        },
        cronSchedule: null,
      }],
    );
  });

  it('flags broad or missing watch paths and cron drift against the registry', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: ['scripts/**', 'shared/**'],
          cronSchedule: '0 * * * *',
        }),
      },
    };

    assert.deepEqual(auditRailwayServiceConfig(config, serviceIds, managedRegistry), [
      {
        service: 'seed-example',
        serviceId: 'svc-example',
        missingService: false,
        watchPatterns: {
          actual: ['scripts/**', 'shared/**'],
          expected: managedRegistry[0].watchPatterns,
        },
        cronSchedule: {
          actual: '0 * * * *',
          expected: '*/15 * * * *',
        },
      },
    ]);
  });

  it('builds a minimal patch containing only drifted fields', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: '0 * * * *',
        }),
      },
    };
    const drift = auditRailwayServiceConfig(config, serviceIds, managedRegistry);

    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: {
        'svc-example': {
          deploy: { cronSchedule: '*/15 * * * *' },
        },
      },
    });
    assert.deepEqual(buildRailwayEditArgs(drift), [
      'environment',
      'edit',
      '--environment',
      'production',
      '--message',
      'ops: reconcile registry-managed Railway seeders',
      '--json',
    ]);
    assert.ok(serializeRailwayServiceConfigPatch(drift).endsWith('\n'));
    assert.deepEqual(
      JSON.parse(serializeRailwayServiceConfigPatch(drift)),
      buildRailwayServiceConfigPatch(drift),
    );
  });

  it('refuses to apply when a registry-managed production service is absent', () => {
    const drift = auditRailwayServiceConfig(
      { services: {} },
      new Map(),
      managedRegistry,
    );

    assert.equal(drift[0].missingService, true);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /seed-example.*not present in Railway production/,
    );
  });

  it('refuses to mutate config while required source routing is absent', () => {
    const registry = [{
      ...managedRegistry[0],
      requiredEnv: ['SOURCE_PROXY_URL'],
    }];
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: ['scripts/**'],
          cronSchedule: '0 * * * *',
        }),
      },
    };
    const drift = auditRailwayServiceConfig(config, serviceIds, registry);

    assert.deepEqual(drift[0].missingRequiredEnv, ['SOURCE_PROXY_URL']);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /seed-example missing required environment: SOURCE_PROXY_URL/,
    );

    const emptyConfig = {
      services: {
        'svc-example': service({
          variables: { SOURCE_PROXY_URL: { value: '   ' } },
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
      },
    };
    assert.deepEqual(
      auditRailwayServiceConfig(emptyConfig, serviceIds, registry)[0].missingRequiredEnv,
      ['SOURCE_PROXY_URL'],
    );

    const configured = {
      services: {
        'svc-example': service({
          variables: { SOURCE_PROXY_URL: { value: '${{shared.PROXY_URL}}' } },
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(configured, serviceIds, registry), []);
  });

  it('allows Railway config read-back to converge after a patch', async () => {
    const broad = {
      services: {
        'svc-example': service({
          watchPatterns: ['scripts/**', 'shared/**'],
          cronSchedule: '0 * * * *',
        }),
      },
    };
    const converged = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: '*/15 * * * *',
        }),
      },
    };
    const snapshots = [broad, broad, converged];
    let reads = 0;
    let sleeps = 0;

    const remaining = await waitForRailwayServiceConfigConvergence(
      () => snapshots[Math.min(reads++, snapshots.length - 1)],
      serviceIds,
      managedRegistry,
      { attempts: 3, delayMs: 0, sleep: async () => { sleeps += 1; } },
    );

    assert.deepEqual(remaining, []);
    assert.equal(reads, 3);
    assert.equal(sleeps, 2);
  });

  it('treats an omitted build.watchPatterns as the empty whole-repo list', () => {
    // Railway omits the field entirely when no filter is configured, so
    // "absent" and "[]" must both satisfy an entry that expects []. This is
    // load-bearing for the always-on bootstrap publisher.
    const registry = [{ service: 'publisher', watchPatterns: [], cronSchedule: null }];
    const ids = new Map([['publisher', 'svc-publisher']]);
    const omitted = service({ cronSchedule: null });
    delete omitted.build.watchPatterns;

    assert.deepEqual(
      auditRailwayServiceConfig({ services: { 'svc-publisher': omitted } }, ids, registry),
      [],
      'omitted watchPatterns must satisfy an expected []',
    );
    assert.deepEqual(
      auditRailwayServiceConfig(
        { services: { 'svc-publisher': service({ cronSchedule: null, watchPatterns: [] }) } },
        ids,
        registry,
      ),
      [],
      'explicit [] must satisfy an expected []',
    );
    const narrowed = auditRailwayServiceConfig(
      { services: { 'svc-publisher': service({ cronSchedule: null, watchPatterns: ['scripts/**'] }) } },
      ids,
      registry,
    );
    assert.deepEqual(narrowed[0].watchPatterns, { actual: ['scripts/**'], expected: [] });
  });

  it('flags a managed entry that pins a cron without declaring watchPatterns', () => {
    const registry = [{ service: 'seed-example', cronSchedule: '*/15 * * * *' }];
    const drift = auditRailwayServiceConfig(
      { services: { 'svc-example': service({ cronSchedule: '*/15 * * * *' }) } },
      serviceIds,
      registry,
    );
    assert.equal(drift[0].missingWatchPatterns, true);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /seed-example pins a cron without watchPatterns/,
    );
  });

  it('audits Railway rootDirectory against the deployMode the registry claims', () => {
    const registry = [{
      ...managedRegistry[0],
      deployMode: 'nixpacks-root-repo', // implies rootDirectory ''
    }];
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
      },
    };
    const drift = auditRailwayServiceConfig(config, serviceIds, registry);
    assert.deepEqual(drift[0].rootDirectory, { actual: 'scripts', expected: '' });
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /seed-example rootDirectory is "scripts" but deployMode implies ""/,
    );

    const matching = [{ ...managedRegistry[0], deployMode: 'nixpacks-root-scripts' }];
    assert.deepEqual(auditRailwayServiceConfig(config, serviceIds, matching), []);
  });

  it('audits and patches a managed Dockerfile path with slash normalization', () => {
    const registry = [{
      ...managedRegistry[0],
      deployMode: 'dockerfile',
      dockerfile: 'Dockerfile.example',
      watchPatterns: [],
      cronSchedule: null,
    }];
    const ids = new Map([['seed-example', 'svc-example']]);
    const live = service({
      cronSchedule: null,
      dockerfilePath: 'Dockerfile.wrong',
      watchPatterns: [],
    });
    live.source.rootDirectory = '';

    const drift = auditRailwayServiceConfig(
      { services: { 'svc-example': live } },
      ids,
      registry,
    );
    assert.deepEqual(drift[0].dockerfilePath, {
      actual: 'Dockerfile.wrong',
      expected: 'Dockerfile.example',
    });
    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: {
        'svc-example': {
          build: { dockerfilePath: 'Dockerfile.example' },
        },
      },
    });

    const normalized = service({
      cronSchedule: null,
      dockerfilePath: '/Dockerfile.example',
      watchPatterns: [],
    });
    normalized.source.rootDirectory = '';
    assert.deepEqual(
      auditRailwayServiceConfig({ services: { 'svc-example': normalized } }, ids, registry),
      [],
    );

    const missing = service({ cronSchedule: null, watchPatterns: [] });
    missing.source.rootDirectory = '';
    const missingDrift = auditRailwayServiceConfig(
      { services: { 'svc-example': missing } },
      ids,
      registry,
    );
    assert.deepEqual(missingDrift[0].dockerfilePath, {
      actual: '',
      expected: 'Dockerfile.example',
    });
  });
});

// The registry is hand-edited JSON with no runtime schema, and every field the
// audit reads decides what --apply pushes to production. Each shape below used
// to fail OPEN: the audit returned [] and printed "audit passed".
describe('registry shape validation', () => {
  const liveConfig = {
    services: { 'svc-example': service({ watchPatterns: managedRegistry[0].watchPatterns }) },
  };

  it('rejects an unknown deployMode instead of skipping the rootDirectory audit', () => {
    const typo = [{ ...managedRegistry[0], deployMode: 'nixpacks-root-scrpits' }];
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, typo),
      /unknown deployMode "nixpacks-root-scrpits"/,
    );
  });

  it('rejects an unknown lifecycle instead of silently auditing it', () => {
    const typo = [{ ...managedRegistry[0], lifecycle: 'planed' }];
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, typo),
      /unknown lifecycle "planed"; expected active or planned/,
    );
  });

  it('rejects a non-array watchPatterns instead of comparing it clean', () => {
    // sortedUniqueStrings() collapses a non-array to [], which compares equal to
    // a whole-repo filter — and the closure contract test skips the same entry
    // on `Array.isArray`, so this shape escaped BOTH gates.
    const asString = [{ ...managedRegistry[0], watchPatterns: 'scripts/seed-example.mjs' }];
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, asString),
      /watchPatterns must be an array of strings/,
    );
    const withNonString = [{ ...managedRegistry[0], watchPatterns: ['scripts/a.mjs', 42] }];
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, withNonString),
      /watchPatterns must be an array of strings/,
    );
  });

  it('rejects a malformed cronSchedule or requiredEnv declaration', () => {
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, [{ ...managedRegistry[0], cronSchedule: 15 }]),
      /cronSchedule must be a string or null/,
    );
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, [{ ...managedRegistry[0], requiredEnv: [[]] }]),
      /empty any-of group/,
    );
    assert.throws(
      () => auditRailwayServiceConfig(liveConfig, serviceIds, [{ ...managedRegistry[0], requiredEnv: ['lower_case'] }]),
      /invalid requiredEnv name/,
    );
  });

  it('rejects malformed Dockerfile declarations', () => {
    assert.throws(
      () => auditRailwayServiceConfig(
        liveConfig,
        serviceIds,
        [{ ...managedRegistry[0], deployMode: 'dockerfile' }],
      ),
      /deployMode dockerfile requires a dockerfile path/,
    );
    assert.throws(
      () => auditRailwayServiceConfig(
        liveConfig,
        serviceIds,
        [{ ...managedRegistry[0], dockerfile: 42 }],
      ),
      /dockerfile must be a non-empty string/,
    );
  });
});

describe('planned Railway service lifecycle', () => {
  const planned = {
    service: 'umami-retention',
    deployMode: 'dockerfile',
    dockerfile: 'Dockerfile.umami-retention',
    lifecycle: 'planned',
    requiredEnv: ['PGHOST'],
    watchPatterns: ['scripts/umami-retention.sql', 'Dockerfile.umami-retention'],
    cronSchedule: '7,22,37,52 * * * *',
  };

  it('keeps unprovisioned standalone seeders explicitly planned', () => {
    // An exact list, not a predicate: `planned` removes an entry from the live
    // audit AND from `--apply`, so every addition has to be a decision somebody
    // made rather than a way to quiet a red gate.
    //
    const expectedPlannedServices = [
      // seed-bundle-canada is deliberately ABSENT now: all six members merged
      // (#6669, #6672, #6674 and the roads stack) and the Railway service was
      // provisioned, so it is a live cron and belongs in the audit. Leaving it
      // planned would exempt the one service most likely to drift — six member
      // scripts behind a single */5 cron — from the watch-path and deploy-drift
      // checks that exist to catch exactly that.
      // seed-bundle-static-ref-heavy is deliberately ABSENT now: #6889 landed it
      // planned until the Railway clone existed, and service
      // 6285c37b-1327-46f1-bfd0-7454612764fb now runs
      // `node seed-bundle-static-ref-heavy.mjs` on cron 0 4 * * *. ONE service
      // carries Arms-Suppliers, Military-Bases and Mineral-Production, so
      // leaving it planned would exempt three low-cadence members behind a
      // single daily cron from the watch-path and deploy-drift checks.
      'seed-crypto-sectors',
      'seed-market-quotes',
      'seed-service-statuses',
      'seed-weather-alerts',
      'seed-imd-cyclone-marine',
    ].sort();
    const plannedEntries = RAILWAY_SERVICE_REGISTRY.filter(
      (entry) => entry.lifecycle === 'planned',
    );

    assert.deepEqual(
      plannedEntries.map((entry) => entry.service).sort(),
      expectedPlannedServices,
      'only unprovisioned standalone seeders may be marked planned',
    );
    assert.ok(
      plannedEntries.every((entry) => entry.lifecycle === 'planned'),
      'unprovisioned standalone seeders must not be treated as active Railway services',
    );
    assert.deepEqual(
      managedRailwayServices(RAILWAY_SERVICE_REGISTRY).filter((entry) =>
        expectedPlannedServices.includes(entry.service),
      ),
      [],
    );
  });

  it('does not attach watchPatterns to planned seed-imd-cyclone-marine', () => {
    const imd = RAILWAY_SERVICE_REGISTRY.find((entry) => entry.service === 'seed-imd-cyclone-marine');
    assert.ok(imd, 'seed-imd-cyclone-marine must remain in the Railway registry');
    assert.equal(imd.lifecycle, 'planned');
    assert.equal(Object.hasOwn(imd, 'watchPatterns'), false);
    assert.equal(Object.hasOwn(imd, 'cronSchedule'), false);
  });

  it('does not attach watchPatterns to planned seed-weather-alerts (no dual-SET of weather:alerts:v1)', () => {
    const weather = RAILWAY_SERVICE_REGISTRY.find((entry) => entry.service === 'seed-weather-alerts');
    assert.ok(weather, 'seed-weather-alerts must remain in the Railway registry');
    assert.equal(weather.lifecycle, 'planned');
    assert.equal(
      Object.hasOwn(weather, 'watchPatterns'),
      false,
      'watchPatterns on a planned seeder is a dual-SET footgun; live writer is ais-relay only',
    );
    assert.equal(Object.hasOwn(weather, 'cronSchedule'), false);
  });

  it('does not report an intentionally absent planned service', () => {
    assert.deepEqual(
      auditRailwayServiceConfig({ services: {} }, new Map(), [planned]),
      [],
    );
    assert.deepEqual(managedRailwayServices([planned]), []);
  });

  it('starts auditing the service after an explicit activation transition', () => {
    const active = { ...planned, lifecycle: 'active' };
    const drift = auditRailwayServiceConfig({ services: {} }, new Map(), [active]);

    assert.equal(drift.length, 1);
    assert.equal(drift[0].service, 'umami-retention');
    assert.equal(drift[0].missingService, true);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /umami-retention.*not present in Railway production/,
    );
  });

  it('never reconciles a planned cron even when the live service already exists', () => {
    const active = { ...managedRegistry[0], service: 'seed-example' };
    const liveRetention = service({
      cronSchedule: '0 * * * *',
      watchPatterns: ['scripts/**'],
      variables: { PGHOST: 'db.internal' },
    });
    liveRetention.source.rootDirectory = '';
    const drift = auditRailwayServiceConfig(
      {
        services: {
          'svc-example': service({
            cronSchedule: '0 * * * *',
            watchPatterns: active.watchPatterns,
          }),
          'svc-retention': liveRetention,
        },
      },
      new Map([
        ['seed-example', 'svc-example'],
        ['umami-retention', 'svc-retention'],
      ]),
      [active, planned],
    );

    assert.deepEqual(drift.map((entry) => entry.service), ['seed-example']);
    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: {
        'svc-example': { deploy: { cronSchedule: active.cronSchedule } },
      },
    });
  });
});

describe('requiredEnv any-of groups', () => {
  // SZSE and Japan MOD resolve `SOURCE_SPECIFIC || PROXY_URL`. Declared
  // as two flat entries the audit demanded BOTH, so configuring only the
  // source-specific exit — the independently-replaceable state the per-source
  // split exists to deliver — reported drift and threw out of the patch builder,
  // vetoing reconciliation for every OTHER service in the same run.
  const anyOfRegistry = [{
    ...managedRegistry[0],
    requiredEnv: [['SZSE_PROXY_URL', 'PROXY_URL']],
  }];

  it('is satisfied by the source-specific variable alone', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
          variables: { SZSE_PROXY_URL: 'http://exit-a' },
        }),
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(config, serviceIds, anyOfRegistry), []);
  });

  it('is satisfied by the shared fallback alone', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
          variables: { PROXY_URL: 'http://shared' },
        }),
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(config, serviceIds, anyOfRegistry), []);
  });

  it('still fails when no alternative in the group is configured', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
          variables: { UNRELATED: 'x' },
        }),
      },
    };
    const drift = auditRailwayServiceConfig(config, serviceIds, anyOfRegistry);
    assert.deepEqual(drift[0].missingRequiredEnv, ['SZSE_PROXY_URL or PROXY_URL']);
    assert.throws(
      () => buildRailwayServiceConfigPatch(drift),
      /missing required environment: SZSE_PROXY_URL or PROXY_URL/,
    );
  });

  it('one unroutable service does not hide another service\'s real drift', () => {
    // The env veto is deliberately fail-closed, but the audit REPORT must still
    // name every drifted service so an operator sees the whole picture.
    const registry = [
      { ...managedRegistry[0], requiredEnv: [['SZSE_PROXY_URL', 'PROXY_URL']] },
      { service: 'seed-other', deployMode: 'nixpacks-root-scripts', watchPatterns: ['scripts/seed-other.mjs'], cronSchedule: '0 * * * *' },
    ];
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
        'svc-other': service({ watchPatterns: ['scripts/WRONG.mjs'], cronSchedule: '0 * * * *' }),
      },
    };
    const drift = auditRailwayServiceConfig(
      config,
      new Map([['seed-example', 'svc-example'], ['seed-other', 'svc-other']]),
      registry,
    );
    assert.deepEqual(drift.map((entry) => entry.service), ['seed-example', 'seed-other']);
    assert.deepEqual(drift[1].watchPatterns, {
      actual: ['scripts/WRONG.mjs'],
      expected: ['scripts/seed-other.mjs'],
    });
  });
});

// Restores the coverage the registry rewrite dropped. Before this sweep the
// audit only ever looked at registry-managed services, so a narrow watch filter
// on any of the ~30 other live seeders — the "merged is not ran" failure this
// guard exists to prevent — returned [] and printed "audit passed".
describe('unmanaged live seeders', () => {
  const registry = [managedRegistry[0]];
  const ids = new Map([['seed-example', 'svc-example'], ['seed-forecasts', 'svc-forecasts']]);

  function unmanagedSeeder({ watchPatterns, rootDirectory = 'scripts' }) {
    return {
      source: { repo: 'koala73/worldmonitor', rootDirectory },
      build: { watchPatterns },
      deploy: { startCommand: 'node seed-forecasts.mjs' },
      variables: {},
    };
  }

  // The managed service must be present in every fixture, otherwise it reports
  // missingService and drowns out what these cases are actually asserting.
  const managedService = () => service({
    watchPatterns: managedRegistry[0].watchPatterns,
    cronSchedule: managedRegistry[0].cronSchedule,
  });

  it('flags a narrow watch filter on a seeder the registry does not manage', () => {
    const config = {
      services: {
        'svc-example': service({
          watchPatterns: managedRegistry[0].watchPatterns,
          cronSchedule: managedRegistry[0].cronSchedule,
        }),
        'svc-forecasts': unmanagedSeeder({ watchPatterns: ['scripts/seed-forecasts.mjs'] }),
      },
    };
    const drift = auditRailwayServiceConfig(config, ids, registry);
    assert.deepEqual(drift, [{
      service: 'seed-forecasts',
      serviceId: 'svc-forecasts',
      missingService: false,
      unmanagedSeeder: true,
      watchPatterns: {
        actual: ['scripts/seed-forecasts.mjs'],
        expected: ['scripts/**', 'shared/**'],
      },
      cronSchedule: null,
    }]);
    assert.deepEqual(buildRailwayServiceConfigPatch(drift), {
      services: { 'svc-forecasts': { build: { watchPatterns: ['scripts/**', 'shared/**'] } } },
    });
  });

  it('accepts a whole-repository filter, however it is expressed', () => {
    for (const watchPatterns of [[], undefined]) {
      const config = {
        services: {
          'svc-example': managedService(),
          'svc-forecasts': unmanagedSeeder({ watchPatterns }),
        },
      };
      assert.deepEqual(auditRailwayServiceConfig(config, ids, registry), []);
    }
  });

  it('accepts the broad contract and preserves extras outside scripts/ and shared/', () => {
    const broad = {
      services: {
        'svc-example': managedService(),
        'svc-forecasts': unmanagedSeeder({ watchPatterns: ['scripts/**', 'shared/**'] }),
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(broad, ids, registry), []);

    // A repo-rooted service can legitimately watch a Dockerfile or a server
    // helper; the fix must ADD the broad patterns, not replace those.
    const repoRooted = {
      services: {
        'svc-example': managedService(),
        'svc-forecasts': unmanagedSeeder({
          rootDirectory: '',
          watchPatterns: ['Dockerfile.seed-forecasts'],
        }),
      },
    };
    const drift = auditRailwayServiceConfig(repoRooted, ids, registry);
    assert.deepEqual(drift[0].watchPatterns.expected, [
      'Dockerfile.seed-forecasts',
      'scripts/**',
      'shared/**',
    ]);
  });

  it('does not second-guess a managed service or a non-seeder', () => {
    // A managed seeder's exact closure is intentionally narrow; the broad
    // contract must not fight it.
    assert.deepEqual(
      auditRailwayServiceConfig({ services: { 'svc-example': managedService() } }, ids, registry),
      [],
    );

    const notASeeder = {
      services: {
        'svc-example': managedService(),
        'svc-web': {
          source: { repo: 'koala73/worldmonitor', rootDirectory: '' },
          build: { watchPatterns: ['src/**'] },
          deploy: { startCommand: 'npm run start' },
          variables: {},
        },
      },
    };
    assert.deepEqual(auditRailwayServiceConfig(notASeeder, ids, registry), []);
  });
});

describe('audit CLI argument parsing', () => {
  // The value this resolves selects which Railway environment --apply mutates.
  it('accepts both the space-separated and equals forms', () => {
    assert.equal(readArgument(['node', 's', '--environment', 'staging'], '--environment', 'production'), 'staging');
    assert.equal(readArgument(['node', 's', '--environment=staging'], '--environment', 'production'), 'staging');
    assert.equal(readArgument(['node', 's', '--apply', '--environment=staging'], '--environment', 'production'), 'staging');
  });

  it('falls back only when the flag is genuinely absent', () => {
    assert.equal(readArgument(['node', 's', '--apply'], '--environment', 'production'), 'production');
  });

  it('refuses a flag with no value instead of silently defaulting', () => {
    assert.throws(() => readArgument(['node', 's', '--environment'], '--environment', 'production'), /requires a value/);
    assert.throws(() => readArgument(['node', 's', '--environment', '--apply'], '--environment', 'production'), /requires a value/);
    assert.throws(() => readArgument(['node', 's', '--environment='], '--environment', 'production'), /requires a value/);
  });
});

// Verify-the-verifier. Every layer below feeds ONE fleet-wide equality check,
// and a layer that silently stops detecting makes both sides of that equality
// shrink together on the next regeneration. These fixtures pin each layer's
// behaviour directly, so a broken detector fails here rather than passing a
// co-evolved comparison.
describe('closure detection layers', () => {
  it('matches recursive relay inventory inputs at the component root and below it', () => {
    assert.equal(pathPatternMatches('src/components/**/*.ts', 'src/components/NewsPanel.ts'), true);
    assert.equal(pathPatternMatches('src/components/**/*.ts', 'src/components/map/NestedPanel.ts'), true);
    assert.equal(pathPatternMatches('src/components/**/*.ts', 'src/components/map/NestedPanel.css'), false);
  });

  const registry = RAILWAY_SERVICE_REGISTRY;

  describe('the container model derived from a Dockerfile', () => {
    it('detects the tsx loader and the dynamic roots the image copies in', () => {
      // scripts/validate-resilience-sensitivity.mjs dynamic-imports
      // ../server/worldmonitor/resilience/v1/*.ts. Without tsx and a server/
      // dynamic root the walk cannot follow those edges, and the derived
      // closure silently loses the entire server graph.
      const contract = dockerfileContainerContract(
        'Dockerfile.seed-bundle-resilience-validation',
        repoRoot,
      );
      assert.equal(contract.hasTsx, true, 'this image installs tsx and sets NODE_OPTIONS');
      assert.ok(
        contract.dynamicRoots.some((dir) => dir.endsWith('/server')),
        'server/ is COPYd into this image, so dynamic imports can land there',
      );
    });

    it('reports no tsx for an image that does not use it', () => {
      // A blanket `hasTsx: true` would resolve .ts specifiers for containers
      // that would crash on them, so this must not be a constant.
      const contract = dockerfileContainerContract('Dockerfile.relay', repoRoot);
      assert.equal(contract.hasTsx, false);
    });
  });

  describe('the manifests a Dockerfile installs from', () => {
    it('matches whole COPY tokens, never substrings', () => {
      // `package.json` is a suffix of `scripts/package.json`. A substring test
      // reports the ROOT manifest for every image that copies the scripts one,
      // which watches a file the image never reads while the real one may go
      // unwatched.
      assert.deepEqual(
        [...manifestsCopiedBy('COPY scripts/package.json scripts/package-lock.json ./scripts/\n')].sort(),
        ['scripts/package-lock.json', 'scripts/package.json'],
      );
      assert.deepEqual(
        [...manifestsCopiedBy('COPY package.json package-lock.json ./\n')].sort(),
        ['package-lock.json', 'package.json'],
      );
    });

    it('finds nothing in an image that pins its tooling inline', () => {
      // Dockerfile.seed-bundle-resilience-validation installs tsx@4.21.0 with
      // --no-package-lock and copies no manifest, so it genuinely has no
      // manifest dependency to watch. Inventing one would be a permanent
      // false "stale watch path".
      assert.deepEqual([...manifestsCopiedBy('RUN npm install --no-package-lock tsx@4.21.0\n')], []);
      assert.deepEqual([...manifestsCopiedBy('COPY --from=source /upstream/package.json ./\n')], []);
    });
  });

  describe('the build inputs each deploy mode contributes', () => {
    it('gives a scripts-rooted nixpacks service its own three build files', () => {
      assert.deepEqual(
        [...buildInputsFor({ deployMode: 'nixpacks-root-scripts' }, repoRoot)].sort(),
        ['scripts/nixpacks.toml', 'scripts/package-lock.json', 'scripts/package.json'],
      );
    });

    it('gives a repo-rooted nixpacks service BOTH dependency trees', () => {
      // The ROOT nixpacks.toml runs `npm ci`, `npm install` AND
      // `npm install --prefix scripts`, so a bump in either tree rebuilds the
      // image while appearing in no import graph.
      assert.deepEqual(
        [...buildInputsFor({ deployMode: 'nixpacks-root-repo' }, repoRoot)].sort(),
        [
          'nixpacks.toml',
          'package-lock.json',
          'package.json',
          'scripts/package-lock.json',
          'scripts/package.json',
        ],
      );
    });

    it('gives a Dockerfile service its definition plus every direct file input', () => {
      const relay = [...buildInputsFor(
        { deployMode: 'dockerfile', dockerfile: 'Dockerfile.relay' },
        repoRoot,
      )].sort();
      const relaySource = readFileSync(resolve(repoRoot, 'Dockerfile.relay'), 'utf8');
      const copied = repositoryCopyInputs(relaySource);
      copied.files.delete('.');
      assert.deepEqual(
        relay,
        [
          '.dockerignore',
          'Dockerfile.relay',
          ...copied.files,
          ...RELAY_INVENTORY_BUILD_INPUTS,
        ].sort(),
      );

      // Directory sources are verified through the runtime-surface walk. Exact
      // config files copied beside them are build inputs in their own right.
      assert.deepEqual(
        [...buildInputsFor(
          { deployMode: 'dockerfile', dockerfile: 'Dockerfile.seed-bundle-resilience-validation' },
          repoRoot,
        )].sort(),
        [
          '.dockerignore',
          'Dockerfile.seed-bundle-resilience-validation',
          'tsconfig.api.json',
          'tsconfig.json',
        ],
      );
    });
  });

  describe('the runtime surface', () => {
    it('reaches the server TypeScript graph of the tsx container', () => {
      // The exact regression #6204's second review found: a scripts-only,
      // tsx-less walk returned ZERO server/ paths for this service, and it had
      // just lost the broad fallback that was covering for that.
      const entry = registry.find((e) => e.service === 'seed-bundle-resilience-validation');
      const { runtimeFiles } = resolveRuntimeSurface(entry, repoRoot);
      for (const pinned of [
        'server/worldmonitor/resilience/v1/_dimension-scorers.ts',
        'server/worldmonitor/resilience/v1/_shared.ts',
        'server/worldmonitor/resilience/v1/_pillar-membership.ts',
        'server/worldmonitor/resilience/v1/_indicator-registry.ts',
        // Reached only THROUGH the server graph — proof the walk followed the
        // edge rather than merely listing the four dynamic-import targets.
        'server/_shared/redis.ts',
      ]) {
        assert.ok(runtimeFiles.has(pinned), `runtime surface must reach ${pinned}`);
        assert.ok(
          new Set(entry.watchPatterns).has(pinned),
          `${entry.service} must watch ${pinned}`,
        );
      }
    });

    it('follows a spawned script into its own imports', () => {
      // scripts/ais-relay.cjs runs seed-climate-news.mjs via execFile with no
      // import statement anywhere between them, so the spawned script AND its
      // subgraph are reachable only through the literal + fixed-point layers.
      const entry = registry.find((e) => e.service === 'ais-relay');
      const { runtimeFiles } = resolveRuntimeSurface(entry, repoRoot);
      assert.ok(runtimeFiles.has('scripts/seed-climate-news.mjs'), 'the spawned script');
      assert.ok(runtimeFiles.has('scripts/_climate-news-helpers.mjs'), 'and what IT imports');
    });

    it('claims both copies of a file that shared/ mirrors', () => {
      // shared/ exists at the repository root and under scripts/. ais-relay.cjs
      // resolves `../shared` FIRST, so stopping at the first resolving base
      // watched the copy the service does not load.
      const entry = registry.find((e) => e.service === 'ais-relay');
      const watched = new Set(entry.watchPatterns);
      assert.ok(watched.has('shared/stocks.json'), 'the copy requireShared actually loads');
      assert.ok(watched.has('scripts/shared/stocks.json'), 'and the mirrored sibling');
    });

    it('includes exact tsx runtime declarations from a scripts-root seeder', () => {
      const entry = registry.find((candidate) => candidate.service === 'seed-bundle-resilience');
      const { runtimeFiles } = resolveRuntimeSurface(entry, repoRoot);
      assert.ok(runtimeFiles.has('scripts/scorecard/v1/_score-country.mts'));
    });
  });

  it('reports a build input that is watched by nobody', () => {
    // The positive case for the missing-build-inputs direction, which is new
    // and had only ever been observed passing.
    const entry = { deployMode: 'nixpacks-root-scripts' };
    const watched = new Set(['scripts/package.json']);
    const missing = [...buildInputsFor(entry, repoRoot)]
      .filter((file) => !watched.has(file))
      .sort();
    assert.deepEqual(missing, ['scripts/nixpacks.toml', 'scripts/package-lock.json']);
  });
});

describe('critical ingestion Railway registry contract', () => {
  const registry = RAILWAY_SERVICE_REGISTRY;
  // Cron pins stay an explicit literal: these are production schedules and a
  // silent edit to one should fail loudly rather than be rubber-stamped by
  // reading the same file the change lives in.
  const expected = new Map([
    ['seed-conflict-intel', '*/15 * * * *'],
    ['seed-gdelt-intel', '*/15 * * * *'],
    ['seed-supply-chain-trade', '0 */6 * * *'],
    ['seed-comtrade-bilateral-hs4', '0 6 1 * *'],
    ['seed-bundle-market-backup', '*/5 * * * *'],
    ['seed-bundle-derived-signals', '*/5 * * * *'],
    ['seed-bundle-portwatch', '0 */1 * * *'],
    ['seed-bundle-portwatch-port-activity', '0 */12 * * *'],
  ]);

  // Closure coverage is DERIVED from the same predicate the audit uses to decide
  // what --apply pushes to Railway. A hardcoded list here would let a future
  // registry entry ship narrow watch paths to production with its dependency
  // closure never verified.
  const closureManaged = managedRailwayServices(registry)
    .filter((entry) => Array.isArray(entry.watchPatterns) && entry.watchPatterns.length > 0);

  it('audit-manages the always-on Umami collector with its exact image inputs', () => {
    const collector = registry.find((entry) => entry.service === 'umami');
    assert.ok(collector, 'umami must be registered');

    const dockerfileSource = readFileSync(resolve(repoRoot, collector.dockerfile), 'utf8');
    const copied = repositoryCopyInputs(dockerfileSource);
    assert.deepEqual(
      [...copied.directories],
      [],
      'directory COPY inputs need an explicit recursive watch-path contract',
    );
    assert.deepEqual(
      [...collector.watchPatterns].sort(),
      ['.dockerignore', collector.dockerfile, ...copied.files].sort(),
      'Umami must rebuild for every repository input copied into its image, and only those inputs',
    );
    assert.ok(
      managedRailwayServices(registry).includes(collector),
      'Umami must participate in the live operational-config audit',
    );

    const liveCollector = service({
      cronSchedule: null,
      dockerfilePath: 'Dockerfile.umami',
      watchPatterns: [...collector.watchPatterns],
      variables: { DATABASE_URL: 'postgres://configured' },
    });
    const drift = auditRailwayServiceConfig(
      { services: { 'svc-umami': liveCollector } },
      new Map([['umami', 'svc-umami']]),
      [collector],
    );
    assert.deepEqual(drift, [{
      service: 'umami',
      serviceId: 'svc-umami',
      missingService: false,
      watchPatterns: null,
      cronSchedule: null,
      rootDirectory: { actual: 'scripts', expected: '' },
      missingRequiredEnv: ['APP_SECRET'],
    }]);
  });

  it('every cron pin names a service that is registry-managed', () => {
    const managedNames = new Set(closureManaged.map((entry) => entry.service));
    for (const serviceName of expected.keys()) {
      assert.ok(managedNames.has(serviceName), `${serviceName} must be registry-managed`);
    }
  });

  it('covers every managed service with watch paths', () => {
    assert.ok(closureManaged.length >= expected.size);
  });

  for (const entry of closureManaged) {
    const serviceName = entry.service;
    it(`${serviceName} pins its cron and complete runtime dependency closure`, () => {
      if (expected.has(serviceName)) {
        assert.equal(entry.cronSchedule, expected.get(serviceName));
      }
      assert.ok(Array.isArray(entry.watchPatterns), `${serviceName} must declare watchPatterns`);
      assert.ok(entry.watchPatterns.length > 0, `${serviceName} watchPatterns must not be empty`);
      assert.equal(
        new Set(entry.watchPatterns).size,
        entry.watchPatterns.length,
        `${serviceName} watchPatterns must not contain duplicates`,
      );
      assert.ok(!entry.watchPatterns.includes('scripts/**'), `${serviceName} must not watch every seeder`);
      assert.ok(!entry.watchPatterns.includes('shared/**'), `${serviceName} must not watch all shared data`);
      for (const watchedPath of entry.watchPatterns) {
        if (watchedPath.includes('*')) {
          assert.equal(
            serviceName === 'ais-relay' && RELAY_INVENTORY_BUILD_INPUTS.includes(watchedPath),
            true,
            `${serviceName} may use only closed inventory-builder globs`,
          );
        }
        assert.ok(
          patternHasRepositoryMatch(watchedPath),
          `${serviceName} watchPatterns references missing ${watchedPath}`,
        );
      }

      const { unresolved, runtimeFiles, converged } = resolveRuntimeSurface(entry, repoRoot);
      assert.deepEqual(unresolved, [], `${serviceName} runtime graph must resolve`);
      assert.ok(
        converged,
        `${serviceName} spawn-edge walk did not reach a fixed point; its closure is incomplete`,
      );

      const watched = new Set(entry.watchPatterns);
      const missingRuntimeFiles = [...runtimeFiles]
        .filter((file) => file !== RELAY_GENERATED_RUNTIME_OUTPUT || serviceName !== 'ais-relay')
        .filter((file) => ![...watched].some((pattern) => pathPatternMatches(pattern, file)))
        .sort();
      assert.deepEqual(
        missingRuntimeFiles,
        [],
        `${serviceName} watchPatterns omit runtime dependencies`,
      );

      // The reverse direction. Without it a watch path that drops out of the
      // import graph lingers forever in a hand-typed 44-entry array, rebuilding
      // the service on changes it no longer depends on -- the exact cost the
      // exact-path registry was introduced to eliminate.
      const buildInputs = buildInputsFor(entry, repoRoot);
      const staleWatchedFiles = [...watched]
        .filter((file) => !runtimeFiles.has(file) && !buildInputs.has(file))
        .sort();
      assert.deepEqual(
        staleWatchedFiles,
        [],
        `${serviceName} watchPatterns contain paths that are no longer runtime dependencies`,
      );

      // The other direction. A build input that is not watched is a manifest or
      // build config whose change rebuilds the image without ever triggering
      // the build — the silently-skipped deployment this registry exists to
      // prevent, in the one class the import walk is blind to.
      const missingBuildInputs = [...buildInputs]
        .filter((file) => !watched.has(file))
        .sort();
      assert.deepEqual(
        missingBuildInputs,
        [],
        `${serviceName} watchPatterns omit build inputs`,
      );
    });
  }
});
