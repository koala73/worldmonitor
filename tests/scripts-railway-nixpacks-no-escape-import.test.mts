/**
 * Regression test for #3811: relative imports in scripts that ship via the
 * Railway nixpacks build with `root_dir=scripts` MUST NOT escape `scripts/`,
 * because nixpacks packages only `scripts/` contents into `/app/` in the
 * container. An `import '../server/_shared/X.mjs'` resolves to
 * `/server/_shared/X.mjs` at runtime — a path that doesn't exist — and
 * crashes the worker on startup with `ERR_MODULE_NOT_FOUND`.
 *
 * The original #3811 regression covered three registered Railway services:
 *   - seed-forecasts        — node scripts/seed-forecasts.mjs
 *   - simulation-worker     — node scripts/process-simulation-tasks.mjs
 *   - deep-forecast-worker  — node scripts/process-deep-forecast-tasks.mjs
 *
 * This guard now also covers standalone `seed-*` cron entry points that use
 * the same root-scripts packaging contract. (See
 * docs/railway-seed-consolidation-runbook.md for the service list and
 * Dockerfile.digest-notifications for the cherry-pick alternative.)
 *
 * Approach: BFS from each entry script, follow relative imports and
 * _bundle-runner section script references, assert no resolved path escapes
 * `scripts/`. Skips bare-package and `node:*` imports.
 *
 * Companion to the header comment in
 * `scripts/_simulation-queue-constants.mjs`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectRelativeRuntimeImports,
  extractEdges,
  parseDockerfileCopy,
  stripComments,
} from './_lib/import-graph-walk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const scriptsDir = resolve(repoRoot, 'scripts');

// Registry-derived entry points cover bundles and workers. Conservatively scan
// unregistered seed-* scripts as scripts-root services too, but exclude entries
// the registry explicitly classifies as repo-root or Dockerfile deployments,
// plus exact child scripts COPY'd into a registered Dockerfile image.
interface RailwayServiceEntry {
  entry: string;
  deployMode: 'nixpacks-root-scripts' | 'nixpacks-root-repo' | 'dockerfile';
  dockerfile?: string;
  service: string;
  documentedAt: string;
}

const registry = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
) as RailwayServiceEntry[];

const REGISTERED_NIXPACKS_ENTRY_POINTS = registry
  .filter((r) => r.deployMode === 'nixpacks-root-scripts')
  .map((r) => r.entry);
const NON_SCRIPTS_ROOT_ENTRY_FILES = new Set(
  registry
    .filter((r) => r.deployMode !== 'nixpacks-root-scripts')
    .map((r) => resolve(repoRoot, r.entry)),
);
const DOCKERFILE_COPIED_SCRIPT_FILES = new Set(
  registry
    .filter((r) => r.deployMode === 'dockerfile' && r.dockerfile)
    .flatMap((r) => {
      const dockerfile = readFileSync(resolve(repoRoot, r.dockerfile!), 'utf8');
      return [...parseDockerfileCopy(dockerfile).files]
        .filter((file) => file.startsWith('scripts/'))
        .map((file) => resolve(repoRoot, file));
    }),
);
const STANDALONE_SEED_ENTRY_POINTS = readdirSync(scriptsDir)
  .filter((file) => /^seed-.*\.(?:mjs|cjs|js)$/.test(file))
  .map((file) => `scripts/${file}`)
  .filter((entry) => {
    const absEntry = resolve(repoRoot, entry);
    return !NON_SCRIPTS_ROOT_ENTRY_FILES.has(absEntry) && !DOCKERFILE_COPIED_SCRIPT_FILES.has(absEntry);
  });
const ENTRY_POINTS = [...new Set([...REGISTERED_NIXPACKS_ENTRY_POINTS, ...STANDALONE_SEED_ENTRY_POINTS])];
const BUNDLE_ENTRY_FILES = new Set(
  REGISTERED_NIXPACKS_ENTRY_POINTS.map((entry) => resolve(repoRoot, entry)),
);

const BUNDLE_SECTION_SCRIPT_RE = /\bscript\s*:\s*['"]([^'"]+\.(?:mjs|cjs|js))['"]/gm;

function collectBundleSectionScripts(filePath: string): string[] {
  // Strip comments first so the gate and the extraction agree on the same
  // source: `script:` section entries are the _bundle-runner orchestrator
  // shape, so scan registry entry points AND any nested orchestrator reached
  // in the BFS (a bundle that spawns a sub-bundle), but skip unrelated files
  // (and files that mention `_bundle-runner` only in a comment) so a stray
  // `script: 'x.mjs'` literal can't fake an escape.
  const src = stripComments(readFileSync(filePath, 'utf8'));
  if (!BUNDLE_ENTRY_FILES.has(filePath) && !src.includes('_bundle-runner')) {
    return [];
  }

  const out: string[] = [];
  let m: RegExpExecArray | null;
  BUNDLE_SECTION_SCRIPT_RE.lastIndex = 0;
  while ((m = BUNDLE_SECTION_SCRIPT_RE.exec(src)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

function escapesScriptsDir(absResolved: string): boolean {
  const rel = relative(scriptsDir, absResolved);
  return rel.startsWith('..') || resolve(rel) === absResolved;
}

describe('scripts/ Railway nixpacks packaging — no escape imports', () => {
  it('classifies scripts-root, repo-root, and Dockerfile child seeders correctly', () => {
    assert.ok(ENTRY_POINTS.includes('scripts/seed-fire-detections.mjs'));
    assert.ok(!ENTRY_POINTS.includes('scripts/seed-market-quotes.mjs'));
    assert.ok(!ENTRY_POINTS.includes('scripts/seed-chokepoint-flows.mjs'));
  });

  it('scanner recognizes every supported literal runtime import form', () => {
    const edges = extractEdges([
      "const ready = true; import value from './same-line.mjs';",
      "import './side-effect.mjs';",
      "export { value } from './exported.mjs';",
      "await import('./dynamic.mjs');",
      "const required = require('./required.cjs');",
    ].join('\n'));

    assert.deepEqual(
      new Set(edges.staticSpecs),
      new Set(['./same-line.mjs', './side-effect.mjs', './exported.mjs']),
    );
    assert.deepEqual(new Set(edges.dynamicSpecs), new Set(['./dynamic.mjs']));
    assert.deepEqual(new Set(edges.requireSpecs), new Set(['./required.cjs']));
  });

  for (const entry of ENTRY_POINTS) {
    it(`entry ${entry} and its transitive scripts/ deps never import outside scripts/`, () => {
      const visited = new Set<string>();
      const queue: string[] = [resolve(repoRoot, entry)];
      const violations: Array<{ from: string; spec: string; resolved: string }> = [];

      while (queue.length > 0) {
        const file = queue.shift()!;
        if (visited.has(file)) continue;
        visited.add(file);

        let imports: Set<string>;
        try {
          imports = collectRelativeRuntimeImports(file);
        } catch (err) {
          assert.fail(`Could not read ${file}: ${(err as Error).message}`);
        }

        for (const spec of imports) {
          const resolved = resolve(dirname(file), spec);
          if (escapesScriptsDir(resolved)) {
            violations.push({
              from: relative(repoRoot, file),
              spec,
              resolved: relative(repoRoot, resolved),
            });
            continue;
          }
          // Stay inside scripts/: follow if it's a .mjs/.cjs/.js sibling so
          // we catch deeper transitive escapes (e.g. a helper added later
          // that imports from ../server/_shared/X).
          if (/\.(mjs|cjs|js)$/.test(resolved)) {
            queue.push(resolved);
          }
        }

        for (const spec of collectBundleSectionScripts(file)) {
          const resolved = resolve(scriptsDir, spec);
          if (escapesScriptsDir(resolved)) {
            violations.push({
              from: relative(repoRoot, file),
              spec,
              resolved: relative(repoRoot, resolved),
            });
            continue;
          }
          queue.push(resolved);
        }
      }

      if (violations.length > 0) {
        const lines = violations.map(
          (v) =>
            `  ${v.from}\n    imports '${v.spec}'\n    -> ${v.resolved} (escapes scripts/)`,
        );
        assert.fail(
          `Found ${violations.length} import(s) that escape scripts/ in the ` +
            `Railway nixpacks build closure. These will crash the worker on ` +
            `startup with ERR_MODULE_NOT_FOUND because the container only has ` +
            `scripts/ contents at /app/. Either move the dependency into ` +
            `scripts/ (preferred — see scripts/_simulation-queue-constants.mjs ` +
            `for the #3811 fix pattern) or migrate the service to a custom ` +
            `Dockerfile that cherry-picks the file (see Dockerfile.digest-` +
            `notifications). Violations:\n${lines.join('\n')}`,
        );
      }
    });
  }
});
