/**
 * Compiles all API handlers into self-contained ESM bundles so the
 * local-api-server.mjs sidecar can discover and load them without node_modules.
 *
 * Two passes:
 *   1. TypeScript handlers (api/**\/*.ts) → bundled .js at same path
 *   2. Plain JS handlers (api/*.js root level) → bundled in-place to inline npm deps
 *
 * Run: node docker/build-handlers.mjs
 */

import { build } from 'esbuild';
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const apiRoot = path.join(projectRoot, 'api');

// ── Pass 1: TypeScript handlers in subdirectories ─────────────────────────
async function findTsHandlers(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const handlers = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      handlers.push(...await findTsHandlers(fullPath));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.startsWith('_') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      handlers.push(fullPath);
    }
  }
  return handlers;
}

// ── Pass 2: Plain JS handlers at api/ root level ──────────────────────────
// NOTE: This pass only re-bundles JS files at the api/ root level (not subdirs).
// If TS handlers are ever added at the api/ root (not under api/<domain>/v1/),
// they would need to be handled in Pass 1 instead.
async function findJsHandlers(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(e =>
      e.isFile() &&
      e.name.endsWith('.js') &&
      !e.name.startsWith('_') &&
      !e.name.endsWith('.test.js') &&
      !e.name.endsWith('.test.mjs')
    )
    .map(e => path.join(dir, e.name));
}

async function compileHandlers(handlers, label) {
  if (handlers.length === 0) {
    console.log(`${label}: nothing to compile`);
    return 0;
  }
  console.log(`${label}: compiling ${handlers.length} handlers...`);

  const results = await Promise.allSettled(
    handlers.map(async (entryPoint) => {
      const outfile = entryPoint.replace(/\.ts$/, '.js');
      await build({
        entryPoints: [entryPoint],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        treeShaking: true,
        allowOverwrite: true,
        loader: { '.ts': 'ts' },
      });
      const { size } = await stat(outfile);
      return { file: path.relative(projectRoot, outfile), size };
    })
  );

  let ok = 0, failed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { file, size } = result.value;
      console.log(`  ✓ ${file}  (${(size / 1024).toFixed(1)} KB)`);
      ok++;
    } else {
      console.error(`  ✗ ${result.reason?.message || result.reason}`);
      failed++;
    }
  }
  return failed;
}

const tsHandlers = await findTsHandlers(apiRoot);
const jsHandlers = await findJsHandlers(apiRoot);

const tsFailed = await compileHandlers(tsHandlers, 'build-handlers [TS]');
// JS handlers bundled AFTER TS so compiled .js outputs don't get re-processed
const jsFailed = await compileHandlers(jsHandlers, 'build-handlers [JS]');

const totalFailed = tsFailed + jsFailed;
console.log(`\nbuild-handlers: complete (${totalFailed} failures)`);
if (totalFailed > 0) process.exit(1);
