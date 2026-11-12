import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

// Vercel deploys middleware.ts as an Edge Function and refuses the deployment
// when a JavaScript module in its graph imports a `.ts` file ("referencing
// unsupported modules"). Local typecheck and esbuild bundling both accept that
// import, so only this walk catches it before a preview deploy fails. It reads
// esbuild's resolved graph rather than parsing source, so comments, strings and
// extensionless specifiers are handled the way a bundler handles them.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function jsModulesImportingTs(root, entry) {
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    packages: 'external',
    logLevel: 'silent',
  });
  const inputs = Object.entries(metafile.inputs);
  const offenders = inputs
    .filter(([file]) => /\.(mjs|js)$/.test(file))
    .flatMap(([file, { imports }]) =>
      imports
        .filter((dependency) => !dependency.external && /\.(ts|tsx|mts|cts)$/.test(dependency.path))
        .map((dependency) => `${file} imports ${dependency.original ?? dependency.path}`),
    );
  return { modules: inputs.length, offenders };
}

test('no JavaScript module bundled into middleware.ts imports a TypeScript file', async () => {
  const { modules, offenders } = await jsModulesImportingTs(ROOT, 'middleware.ts');
  assert.ok(modules > 5, `resolved only ${modules} modules; the graph walk is broken`);
  assert.deepEqual(offenders, [], `Edge middleware cannot bundle these imports:\n${offenders.join('\n')}`);
});

test('the walk flags real TypeScript imports from JavaScript and ignores commented ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wm-edge-js-imports-'));
  try {
    await writeFile(join(dir, 'entry.ts'), "import './shared.mjs';\n");
    await writeFile(
      join(dir, 'shared.mjs'),
      [
        "// import './commented.ts';",
        "/* import { value } from './block-commented.ts'; */",
        "const label = \"import './in-string.ts'\";",
        "export{value}from'./compact.ts';",
        "import './extensionless';",
        "const lazy = () => import('./dynamic.ts');",
        'export { label, lazy };',
      ].join('\n'),
    );
    for (const name of ['commented', 'block-commented', 'in-string', 'compact', 'extensionless', 'dynamic']) {
      await writeFile(join(dir, `${name}.ts`), 'export const value = 1;\n');
    }
    const { offenders } = await jsModulesImportingTs(dir, 'entry.ts');
    assert.deepEqual(offenders.sort(), [
      'shared.mjs imports ./compact.ts',
      'shared.mjs imports ./dynamic.ts',
      'shared.mjs imports ./extensionless',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
