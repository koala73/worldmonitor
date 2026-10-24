import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Vercel deploys middleware.ts as an Edge Function and refuses the deployment
// when a JavaScript module in its graph imports a `.ts` file ("referencing
// unsupported modules"). Local typecheck and esbuild both accept that import,
// so only this walk catches it before a preview deploy fails.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_SPECIFIER = /(?:^|[\s;])(?:import|export)\s(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function relativeImports(file) {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_SPECIFIER)]
    .map((match) => match[1] ?? match[2])
    .filter((specifier) => specifier.startsWith('.'));
}

function middlewareJsGraph() {
  const queue = relativeImports(join(ROOT, 'middleware.ts'))
    .filter((specifier) => /\.(mjs|js)$/.test(specifier))
    .map((specifier) => resolve(ROOT, specifier));
  const seen = new Set();
  const offenders = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of relativeImports(file)) {
      const target = resolve(dirname(file), specifier);
      if (/\.(ts|tsx|mts|cts)$/.test(specifier)) {
        offenders.push(`${relative(ROOT, file)} imports ${specifier}`);
      } else if (/\.(mjs|js)$/.test(specifier)) {
        queue.push(target);
      }
    }
  }
  return { seen, offenders };
}

test('no JavaScript module bundled into middleware.ts imports a TypeScript file', () => {
  const { seen, offenders } = middlewareJsGraph();
  assert.ok(seen.size > 5, `walked only ${seen.size} modules; the import scan is broken`);
  assert.deepEqual(offenders, [], `Edge middleware cannot bundle these imports:\n${offenders.join('\n')}`);
});
