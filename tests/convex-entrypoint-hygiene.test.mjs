import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const convexRoot = resolve(repoRoot, 'convex');

// Mirrors convex/dist/cjs/bundler/index.js:303 (ENTRY_POINT_EXTENSIONS). A file
// outside this list is never analyzed, whatever else it contains.
const ENTRY_POINT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx'];

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * The exact filter `convex deploy` applies when it decides which files under
 * `convex/` become backend modules — bundler/index.js:336-395, in the same
 * order. Reproduced rather than imported because it is not exported, and the
 * whole point of this gate is to answer "would the deploy push this file?"
 * without a network round trip to Convex.
 */
function isConvexEntryPoint(relPath, readSource) {
  const { base } = parse(relPath);
  if (!ENTRY_POINT_EXTENSIONS.some((extension) => relPath.endsWith(extension))) return false;
  if (relPath.startsWith(`_generated${sep}`)) return false;
  if (base.startsWith('.')) return false;
  if (base.startsWith('#')) return false;
  if (base === 'schema.ts' || base === 'schema.js') return false;
  // The rule that decides this whole class of bug: two or more dots in the base
  // name (`x.test.ts`, `x.helpers.ts`) makes Convex skip the file. One dot
  // (`x.ts`) makes it a backend module.
  if ((base.match(/\./g) || []).length > 1) return false;
  if (relPath.includes(' ')) return false;
  // Trailing filter: a .ts/.tsx file with no import and no export is dropped.
  if (relPath.endsWith('.ts') || relPath.endsWith('.tsx')) {
    return /^\s{0,100}(import|export)/m.test(readSource());
  }
  return true;
}

function convexEntryPoints() {
  return listFiles(convexRoot)
    .map((path) => relative(convexRoot, path))
    .filter((relPath) => isConvexEntryPoint(relPath, () => readFileSync(join(convexRoot, relPath), 'utf8')))
    .sort();
}

describe('convex entry-point hygiene', () => {
  // `convex deploy` evaluates every module it pushes in a Convex isolate, where
  // `import.meta` does not exist. One such file fails the WHOLE push with
  // `InvalidModules ... import.meta unsupported`, so an unrelated merge that
  // adds one helper strands every pending convex/ change in main — which is
  // exactly what #6232 did (Convex production never received it).
  it('pushes no module that uses import.meta', () => {
    const offenders = convexEntryPoints().filter(
      (relPath) => readFileSync(join(convexRoot, relPath), 'utf8').includes('import.meta'),
    );
    assert.deepEqual(
      offenders,
      [],
      `these files are pushed to Convex and use import.meta, which fails the deploy: ${offenders.join(', ')}`,
    );
  });

  // Stronger and simpler than the rule above, and the reason it can hold: test
  // scaffolding has no business running in the production backend. `*.test.ts`
  // already satisfies it by accident (two dots). Every other file in the
  // directory must earn the same skip on purpose.
  it('pushes no file from convex/__tests__', () => {
    const offenders = convexEntryPoints().filter((relPath) => relPath.startsWith(`__tests__${sep}`));
    assert.deepEqual(
      offenders,
      [],
      `test scaffolding must never become a Convex backend module — give these a two-dot name: ${offenders.join(', ')}`,
    );
  });

  // Convex names every pushed module by its path, and the server rejects a path
  // component holding anything but alphanumerics, underscores or periods. The
  // convex npm package does NOT check this locally — the only "no" comes from
  // `evaluate_push`, i.e. post-merge, on main. `admission-snapshot.ts` (#6470)
  // therefore passed every required gate and then took the whole production
  // push down with `InvalidConfig: ... is not a valid path to a Convex module`,
  // stranding every other convex/ change behind it exactly as #6232 did.
  it('pushes no module whose path a Convex module name cannot express', () => {
    const legalComponent = /^[A-Za-z0-9_.]+$/;
    const offenders = convexEntryPoints().filter((relPath) =>
      relPath.split(sep).some((component) => !legalComponent.test(component)),
    );
    assert.deepEqual(
      offenders,
      [],
      `Convex module paths allow only alphanumerics, underscores and periods per component — rename these (hyphens are the usual culprit): ${offenders.join(', ')}`,
    );
  });

  // Guards the guard: if the filter above ever stops recognising real modules,
  // both assertions pass over an empty list and prove nothing.
  it('recognises the real backend modules', () => {
    const entryPoints = convexEntryPoints();
    assert.ok(entryPoints.length > 20, `expected the convex module fleet, found ${entryPoints.length}`);
    for (const expected of ['apiKeys.ts', join('companyMonitoring', 'accounts.ts'), 'crons.ts']) {
      assert.ok(entryPoints.includes(expected), `${expected} must be recognised as a pushed module`);
    }
  });
});
