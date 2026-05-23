/**
 * Regression test for #3811: relative imports in scripts that ship via the
 * Railway nixpacks build with `root_dir=scripts` MUST NOT escape `scripts/`,
 * because nixpacks packages only `scripts/` contents into `/app/` in the
 * container. An `import '../server/_shared/X.mjs'` resolves to
 * `/server/_shared/X.mjs` at runtime — a path that doesn't exist — and
 * crashes the worker on startup with `ERR_MODULE_NOT_FOUND`.
 *
 * Three Railway services are affected:
 *   - seed-forecasts        — node scripts/seed-forecasts.mjs
 *   - simulation-worker     — node scripts/process-simulation-tasks.mjs
 *   - deep-forecast-worker  — node scripts/process-deep-forecast-tasks.mjs
 *
 * (See docs/railway-seed-consolidation-runbook.md for the service list and
 * Dockerfile.digest-notifications header for the cherry-pick alternative
 * we explicitly do NOT use for these three.)
 *
 * Approach: BFS from each entry script, follow relative imports, assert no
 * resolved path escapes `scripts/`. Skips bare-package and `node:*` imports.
 *
 * Companion to the header comment in
 * `scripts/_simulation-queue-constants.mjs`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const scriptsDir = resolve(repoRoot, 'scripts');

// Entry points derived from scripts/railway-services.json, the single
// source of truth for every script that runs as a Railway service. New
// services are added by editing the registry, NOT this array. The
// companion test tests/railway-services-registry-coverage.test.mts fails
// if any Dockerfile.* or runbook entry references a script that isn't
// in the registry — that's how drift is caught.
interface RailwayServiceEntry {
  entry: string;
  deployMode: 'nixpacks-root-scripts' | 'dockerfile';
  dockerfile?: string;
  service: string;
  documentedAt: string;
}

const registry = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
) as RailwayServiceEntry[];

const ENTRY_POINTS = registry
  .filter((r) => r.deployMode === 'nixpacks-root-scripts')
  .map((r) => r.entry);

const IMPORT_RE = /(?:^|[\s;])(?:import\b[\s\S]*?\bfrom|import|export\b[\s\S]*?\bfrom)\s+['"]([^'"]+)['"]/gm;

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

function collectRelativeImports(filePath: string): string[] {
  const src = readFileSync(filePath, 'utf8');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1]!;
    if (isRelative(spec)) out.push(spec);
  }
  return out;
}

function escapesScriptsDir(absResolved: string): boolean {
  const rel = relative(scriptsDir, absResolved);
  return rel.startsWith('..') || resolve(rel) === absResolved;
}

describe('scripts/ Railway nixpacks packaging — no escape imports', () => {
  for (const entry of ENTRY_POINTS) {
    it(`entry ${entry} and its transitive scripts/ deps never import outside scripts/`, () => {
      const visited = new Set<string>();
      const queue: string[] = [resolve(repoRoot, entry)];
      const violations: Array<{ from: string; spec: string; resolved: string }> = [];

      while (queue.length > 0) {
        const file = queue.shift()!;
        if (visited.has(file)) continue;
        visited.add(file);

        let imports: string[];
        try {
          imports = collectRelativeImports(file);
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
      }

      if (violations.length > 0) {
        const lines = violations.map(
          (v) =>
            `  ${v.from}\n    imports '${v.spec}'\n    → ${v.resolved} (escapes scripts/)`,
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
