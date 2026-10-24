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
const IMPORT_SPECIFIER = /(?:^|[\s;])(?:import|export)\s(?:[^'"]*?from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function importSpecifiers(source) {
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? match[2]);
}

function relativeImports(file) {
  return importSpecifiers(readFileSync(file, 'utf8')).filter((specifier) => specifier.startsWith('.'));
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

test('the import scan sees every static, side-effect and dynamic import form', () => {
  const source = [
    "import { a } from './named.ts';",
    "import {\n  b,\n} from './multiline.ts';",
    "import {c}from './unspaced.ts';",
    "export {d}from './unspaced-reexport.ts';",
    "export * from './star.ts';",
    "import fromage from './fromage.ts';",
    "import './side-effect.ts';",
    "const lazy = import('./dynamic.ts');",
    "export const label = 'from';",
    "export default './not-an-import.ts';",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), [
    './named.ts',
    './multiline.ts',
    './unspaced.ts',
    './unspaced-reexport.ts',
    './star.ts',
    './fromage.ts',
    './side-effect.ts',
    './dynamic.ts',
  ]);
});
