import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// The Railway "derived-signals" seed bundle deploys with rootDirectory=scripts,
// which means the repo-root `shared/` folder is NOT present in the container.
// Scripts that need shared/* assets at runtime must import them from
// `scripts/shared/*` instead. `scripts/shared/*` is a byte-for-byte mirror
// of the subset of `shared/*` used by the Railway seeders.
//
// This test locks the mirror so a drift between `shared/X` and
// `scripts/shared/X` cannot slip through code review. When adding new
// mirrored files, append them to MIRRORED_FILES.

const MIRRORED_FILES = [
  'geography.js',
  'iso2-to-region.json',
  'iso3-to-iso2.json',
  'un-to-iso2.json',
];

describe('scripts/shared/ mirrors shared/', () => {
  for (const relPath of MIRRORED_FILES) {
    it(`${relPath} is identical between shared/ and scripts/shared/`, () => {
      const canonical = readFileSync(join(repoRoot, 'shared', relPath), 'utf-8');
      const mirror = readFileSync(join(repoRoot, 'scripts', 'shared', relPath), 'utf-8');
      assert.equal(
        mirror,
        canonical,
        `scripts/shared/${relPath} drifted from shared/${relPath}. ` +
          `Run: cp shared/${relPath} scripts/shared/${relPath}`,
      );
    });
  }

  it('scripts/shared has a package.json marking it as ESM', () => {
    // Required because scripts/package.json does NOT set "type": "module",
    // so scripts/shared/geography.js (ESM syntax) would otherwise be parsed
    // ambiguously when Railway loads it from rootDirectory=scripts.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'scripts/shared/package.json'), 'utf-8'));
    assert.equal(pkg.type, 'module');
  });
});

describe('regional snapshot seed scripts use scripts/shared/ (not repo-root shared/)', () => {
  // Guards the Railway rootDirectory=scripts runtime: an import whose
  // resolved absolute path falls OUTSIDE scripts/shared/ (e.g. repo-root
  // shared/) will ERR_MODULE_NOT_FOUND at runtime on Railway because the
  // shared/ dir is not copied into the deploy root.
  const FILES_THAT_MUST_USE_MIRROR = [
    'scripts/seed-regional-snapshots.mjs',
    'scripts/regional-snapshot/actor-scoring.mjs',
    'scripts/regional-snapshot/balance-vector.mjs',
    'scripts/regional-snapshot/evidence-collector.mjs',
    'scripts/regional-snapshot/scenario-builder.mjs',
  ];

  const scriptsSharedAbs = resolve(repoRoot, 'scripts/shared');

  // Match any runtime `import ... from '<path>'` (ignores JSDoc `import()`
  // type annotations which live inside /** */ comments). Only looks at
  // lines that start with optional whitespace + `import`.
  const RUNTIME_IMPORT_RE = /^\s*import\s[^\n]*?\bfrom\s+['"]([^'"]+)['"]/gm;

  for (const rel of FILES_THAT_MUST_USE_MIRROR) {
    it(`${rel} resolves all shared/ imports to scripts/shared/`, () => {
      const src = readFileSync(join(repoRoot, rel), 'utf-8');
      const fileAbs = resolve(repoRoot, rel);
      const fileDir = dirname(fileAbs);

      const offending = [];
      for (const match of src.matchAll(RUNTIME_IMPORT_RE)) {
        const specifier = match[1];
        // Only inspect relative paths that land in a shared/ directory.
        if (!/\/shared\//.test(specifier)) continue;
        if (!specifier.startsWith('.')) continue;
        const resolved = resolve(fileDir, specifier);
        if (!resolved.startsWith(scriptsSharedAbs)) {
          offending.push(`  ${specifier} → ${resolved}`);
        }
      }

      assert.equal(
        offending.length,
        0,
        `${rel} has runtime import(s) that escape scripts/shared/:\n${offending.join('\n')}\n` +
          `Railway service rootDirectory=scripts means these paths escape the deploy root. ` +
          `Mirror the needed file into scripts/shared/ and update the import.`,
      );
    });
  }
});
