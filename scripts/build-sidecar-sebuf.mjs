/**
 * Compiles the sebuf catch-all gateway (api/[[...path]].ts) into a single
 * self-contained ESM bundle (api/[[...path]].js) so the Tauri sidecar's
 * buildRouteTable() can discover and load it.
 *
 * Run: node scripts/build-sidecar-sebuf.mjs
 * Or:  npm run build:sidecar-sebuf
 */

import { build } from 'esbuild';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const entryPoint = path.join(projectRoot, 'api', '[[...path]].ts');
const outfile = path.join(projectRoot, 'api', '[[...path]].js');

try {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    // Tree-shake unused exports for smaller bundle
    treeShaking: true,
  });

  const { size } = await stat(outfile);
  const sizeKB = (size / 1024).toFixed(1);
  console.log(`build:sidecar-sebuf  api/[[...path]].js  ${sizeKB} KB`);
} catch (err) {
  console.error('build:sidecar-sebuf failed:', err.message);
  process.exit(1);
}
