// Static guard: docker/Dockerfile runs `npx tsc && npx vite build` on a
// `COPY . .` of the build context, and .dockerignore drops `tests`, `e2e`,
// docs and friends from that context. A file tsc type-checks (tsconfig.json
// `include`) that imports a path .dockerignore excludes compiles everywhere
// except inside the image build — and that build only runs when a release is
// published, so the break surfaces after the merge, at release time.
//
// Historical failure this test would have caught:
// - 2026-10-19: #9391 added src/e2e/country-qualified-signals-harness.ts
//   importing tests/fixtures/qualified-country-signals; v2.11.1's
//   "Publish Docker image" failed with TS2307 and no image shipped.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { relativeToRepoRoot } from './_lib/import-graph-walk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// The compiler options docker/Dockerfile's `npx tsc` runs with.
function repoTsOptions() {
  const { config } = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config, ts.sys, root).options;
}
const FIXTURE_TS_OPTIONS = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowImportingTsExtensions: true, noEmit: true, resolveJsonModule: true };

// One path segment of a Go filepath.Match pattern: `*`, `?`, `[...]` classes
// (`[!...]` / `[^...]` negate) and `\` escapes.
function segmentToRegex(seg) {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '\\' && i + 1 < seg.length) out += seg[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end === -1) { out += '\\['; continue; }
      let body = seg.slice(i + 1, end);
      if (body[0] === '!') body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\(?!.)/g, '\\\\')}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|\]\\/]/g, '\\$&');
  }
  return out;
}

// .dockerignore rules in file order; the last matching rule wins, a pattern
// that matches a directory excludes everything beneath it, and a `**` segment
// spans any number of directories, including zero.
function parseDockerignore(src) {
  return src.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const negate = line.startsWith('!');
    const segs = (negate ? line.slice(1) : line).replace(/^\/+/, '').replace(/\/+$/, '').split('/');
    let re = '';
    segs.forEach((seg, i) => {
      const last = i === segs.length - 1;
      if (seg === '**') re += last ? '.*' : '(?:.*/)?';
      else re += segmentToRegex(seg) + (last ? '' : '/');
    });
    return { negate, re: new RegExp(`^${re}$`) };
  });
}

function isExcluded(rules, relPath) {
  const parts = relPath.split('/');
  let excluded = false;
  for (const { negate, re } of rules) {
    for (let i = 1; i <= parts.length; i++) {
      if (re.test(parts.slice(0, i).join('/'))) { excluded = !negate; break; }
    }
  }
  return excluded;
}

// Every relative specifier tsc sees, read by TypeScript's own scanner: static,
// type-only, side-effect, re-export and literal dynamic imports, never text
// inside strings or comments.
function relativeSpecs(file) {
  const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf-8'), true, true);
  return new Set(importedFiles.map((f) => f.fileName).filter((spec) => spec.startsWith('.')));
}

function listSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listSources(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// Resolve the way tsc does (extensions, .tsx, index files, package.json
// `types`, `.js` → `.ts` mapping) via TypeScript's resolver. Non-module assets
// such as `import './x.css'` fall back to the literal path, since vite needs
// them in the build context too.
function resolveTsRelative(fromFile, spec, options) {
  const resolved = ts.resolveModuleName(spec, fromFile, options, ts.sys).resolvedModule?.resolvedFileName;
  if (resolved) return resolve(resolved);
  const literal = resolve(dirname(fromFile), spec);
  return existsSync(literal) && statSync(literal).isFile() ? literal : null;
}

// Walk the whole relative-import graph tsc follows from the entry files, not
// just the entries: a src → shared → tests chain breaks the image build too.
function findOffenders(repoRoot, entries, rules, options) {
  const offenders = [];
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    for (const spec of relativeSpecs(file)) {
      const target = resolveTsRelative(file, spec, options);
      if (!target) continue;
      const rel = relativeToRepoRoot(repoRoot, target);
      if (rel && isExcluded(rules, rel)) offenders.push(`${relativeToRepoRoot(repoRoot, file)} → ${rel}`);
      else if (!seen.has(target) && /\.(ts|tsx|mts|js|mjs)$/.test(target)) { seen.add(target); queue.push(target); }
    }
  }
  return offenders;
}

describe('docker/Dockerfile — tsc inputs stay inside the build context', () => {
  const rules = parseDockerignore(readFileSync(resolve(root, '.dockerignore'), 'utf-8'));
  const tsconfig = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf-8'));
  const excludedEntries = new Set((tsconfig.exclude ?? []).map((p) => resolve(root, p)));
  const files = tsconfig.include.flatMap((entry) => {
    const abs = resolve(root, entry);
    return statSync(abs).isDirectory() ? listSources(abs) : [abs];
  }).filter((f) => !excludedEntries.has(f));

  it('the matcher reads .dockerignore the way Docker does (sanity)', () => {
    assert.ok(files.length > 100, `expected the tsconfig include set to be large, got ${files.length}`);
    assert.equal(isExcluded(rules, 'tests/fixtures/qualified-country-signals.ts'), true);
    assert.equal(isExcluded(rules, 'e2e/runtime.spec.ts'), true);
    assert.equal(isExcluded(rules, 'src/e2e/country-qualified-signals-harness.ts'), false);
    assert.equal(isExcluded(rules, 'scripts/shared/comtrade.mjs'), false);
    assert.equal(isExcluded(rules, '.github/workflows/test.yml'), false);
    assert.equal(isExcluded(rules, '.github/CODEOWNERS'), true);
  });

  it('`**/` matches zero directories and `[...]` is a character class, as in Docker', () => {
    const r = parseDockerignore('**/fixtures\ntests/**/fixture.ts\nlogs/[ab].txt');
    assert.equal(isExcluded(r, 'fixtures/a.ts'), true);
    assert.equal(isExcluded(r, 'src/deep/fixtures/a.ts'), true);
    assert.equal(isExcluded(r, 'tests/fixture.ts'), true);
    assert.equal(isExcluded(r, 'tests/a/b/fixture.ts'), true);
    assert.equal(isExcluded(r, 'logs/a.txt'), true);
    assert.equal(isExcluded(r, 'logs/c.txt'), false);
  });

  it('follows imports transitively and resolves .tsx targets', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'docker-ctx-'));
    try {
      const put = (rel, body) => { mkdirSync(dirname(join(tmp, rel)), { recursive: true }); writeFileSync(join(tmp, rel), body); };
      put('src/app.ts', "import { helper } from '../shared/helper';\nimport View from './view';\n");
      put('src/view.tsx', "import { widget } from '../tests/fixtures/widget';\nexport default widget;\n");
      put('shared/helper.ts', "export { fixture as helper } from '../tests/fixtures/data';\n");
      put('tests/fixtures/data.ts', 'export const fixture = 1;\n');
      put('tests/fixtures/widget.tsx', 'export const widget = 1;\n');
      put('tests/fixtures/unused.ts', "import '../../src/app';\n");
      put('src/types.ts', "import type {\n  Shape,\n} from '../tests/typings';\nexport const note = \"from '../tests/fixtures/data'\";\n");
      put('tests/typings/index.d.ts', 'export interface Shape { a: number }\n');
      put('src/pkg.ts', "import type { Pkg } from '../tests/pkg-types';\n");
      put('tests/pkg-types/package.json', '{ "types": "./shapes.d.ts" }\n');
      put('tests/pkg-types/shapes.d.ts', 'export interface Pkg { b: number }\n');
      const entries = ['src/app.ts', 'src/types.ts', 'src/pkg.ts'].map((f) => join(tmp, f));
      const offenders = findOffenders(tmp, entries, parseDockerignore('tests'), FIXTURE_TS_OPTIONS);
      assert.deepEqual(offenders.sort(), [
        'shared/helper.ts → tests/fixtures/data.ts',
        'src/pkg.ts → tests/pkg-types/shapes.d.ts',
        'src/types.ts → tests/typings/index.d.ts',
        'src/view.tsx → tests/fixtures/widget.tsx',
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('no type-checked file imports a path .dockerignore drops', () => {
    assert.deepEqual(findOffenders(root, files, rules, repoTsOptions()), [], 'these imports resolve locally but are missing from the Docker build context; move the target under src/ or shared/');
  });
});
