// Static guard: every scripts/*.mjs COPY'd into the relay container must
// have ALL its relative-path imports ALSO COPY'd. A missing transitive
// import looks like a silent Railway cron hang — the child process dies
// on ERR_MODULE_NOT_FOUND with output only on the parent's stderr, which
// is easy to miss when the relay handles many other messages.
//
// Historical failures this test would have caught:
// - 2026-04-14 to 2026-04-16: _seed-envelope-source.mjs added to
//   _seed-utils.mjs but not COPY'd, breaking chokepoint-flows for 32h
//   (fixed alongside PR #3128 port-activity work).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readCopyList(dockerfilePath) {
  const src = readFileSync(dockerfilePath, 'utf-8');
  const copied = new Set();
  // Matches: COPY scripts/foo.mjs ./scripts/foo.mjs
  const re = /^COPY\s+(scripts\/[^\s]+\.(mjs|cjs))\s+/gm;
  for (const m of src.matchAll(re)) copied.add(m[1]);
  return copied;
}

function collectRelativeImports(filePath) {
  const src = readFileSync(filePath, 'utf-8');
  const imports = new Set();
  // ESM: import ... from './x.mjs'   |  export ... from './x.mjs'
  const esmRe = /(?:^|\s|;)(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
  for (const m of src.matchAll(esmRe)) imports.add(m[1]);
  // CJS direct: require('./x.cjs')
  const cjsRe = /(?:^|[^a-zA-Z0-9_$])require\s*\(\s*['"](\.[^'"]+)['"]/g;
  for (const m of src.matchAll(cjsRe)) imports.add(m[1]);
  // CJS chained: createRequire(import.meta.url)('./x.cjs')
  //  — the final `('./x')` argument is applied to createRequire's return,
  //    not to a `require(` token, so the cjsRe above misses it.
  const createRequireRe = /createRequire\s*\([^)]*\)\s*\(\s*['"](\.[^'"]+)['"]/g;
  for (const m of src.matchAll(createRequireRe)) imports.add(m[1]);
  return imports;
}

function resolveImport(fromFile, relImport) {
  const abs = resolve(dirname(fromFile), relImport);
  if (existsSync(abs)) return abs;
  for (const ext of ['.mjs', '.cjs', '.js']) {
    if (existsSync(abs + ext)) return abs + ext;
  }
  return null;
}

describe('Dockerfile.relay — transitive-import closure', () => {
  const dockerfile = resolve(root, 'Dockerfile.relay');
  const copied = readCopyList(dockerfile);
  const entrypoints = [...copied].filter(p => p.endsWith('.mjs') || p.endsWith('.cjs'));

  it('COPY list is non-empty (sanity)', () => {
    assert.ok(copied.size > 0, 'Dockerfile.relay has no COPY scripts/*.mjs|cjs lines');
  });

  it('scanner catches both ESM imports and CJS require/createRequire', () => {
    // Regression guard for the scanner itself: _seed-utils.mjs has both
    // `import { ... } from './_seed-envelope-source.mjs'` (ESM) AND
    // `createRequire(import.meta.url)('./_proxy-utils.cjs')` (CJS). If
    // collectRelativeImports ever stops picking up either, a future
    // createRequire/require pointing at a new uncopied helper would slip
    // past the BFS test below without anyone noticing.
    const seedUtils = resolve(root, 'scripts/_seed-utils.mjs');
    const imports = collectRelativeImports(seedUtils);
    assert.ok(imports.has('./_seed-envelope-source.mjs'), 'ESM import not detected');
    assert.ok(imports.has('./_proxy-utils.cjs'), 'CJS createRequire not detected');

    const relayCjs = resolve(root, 'scripts/ais-relay.cjs');
    const relayImports = collectRelativeImports(relayCjs);
    assert.ok(relayImports.has('./_proxy-utils.cjs'), 'CJS require not detected');
  });

  // BFS the import graph from each COPY'd entrypoint. Every .mjs/.cjs reached
  // via a relative import must itself be COPY'd.
  it('every transitively-imported scripts/*.mjs|cjs is also COPY\'d', () => {
    const missing = [];
    const visited = new Set();
    const queue = entrypoints.map(p => resolve(root, p));
    while (queue.length) {
      const file = queue.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      if (!existsSync(file)) continue;
      for (const rel of collectRelativeImports(file)) {
        const resolved = resolveImport(file, rel);
        if (!resolved) continue;
        const relToRoot = resolved.startsWith(root + '/') ? resolved.slice(root.length + 1) : null;
        if (!relToRoot || !relToRoot.startsWith('scripts/')) continue;
        if (!copied.has(relToRoot)) {
          missing.push(`${relToRoot} (imported by ${file.slice(root.length + 1)})`);
        }
        queue.push(resolved);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Dockerfile.relay is missing COPY lines for:\n  ${missing.join('\n  ')}\n` +
      `Add a 'COPY <path> ./<path>' line per missing file.`,
    );
  });
});
