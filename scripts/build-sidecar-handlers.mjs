/**
 * Compiles per-domain RPC handlers into bundled ESM .js files so the Tauri
 * sidecar's buildRouteTable() can load them.
 *
 * Two supported layouts are discovered:
 * - legacy: api/{domain}/v{major}/[rpc].ts
 * - version-major: api/v{major}/{domain}/[rpc].ts
 *
 * Run: node scripts/build-sidecar-handlers.mjs
 */

import { build } from 'esbuild';
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const apiDir = path.join(ROOT, 'api');

// Skip the catch-all [domain] directory (handled by build-sidecar-sebuf.mjs)
const SKIP_DIRS = new Set(['[domain]', '[[...path]]']);

const VERSION_DIRECTORY = /^v\d+$/;

function relativeApiPath(apiRoot, filePath) {
  return path.relative(apiRoot, filePath).split(path.sep).join('/');
}

export async function discoverSidecarHandlerEntries(apiRoot = apiDir) {
  const entries = [];
  const topDirs = await readdir(apiRoot, { withFileTypes: true });

  for (const topDir of topDirs) {
    if (!topDir.isDirectory() || SKIP_DIRS.has(topDir.name)) continue;

    const topPath = path.join(apiRoot, topDir.name);
    if (VERSION_DIRECTORY.test(topDir.name)) {
      const domains = await readdir(topPath, { withFileTypes: true });
      for (const domain of domains) {
        if (!domain.isDirectory()) continue;
        const tsFile = path.join(topPath, domain.name, '[rpc].ts');
        if (existsSync(tsFile)) {
          entries.push({ entryPoint: tsFile, relativePath: relativeApiPath(apiRoot, tsFile) });
        }
      }
      continue;
    }

    const versions = await readdir(topPath, { withFileTypes: true });
    for (const version of versions) {
      if (!version.isDirectory() || !VERSION_DIRECTORY.test(version.name)) continue;
      const tsFile = path.join(topPath, version.name, '[rpc].ts');
      if (existsSync(tsFile)) {
        entries.push({ entryPoint: tsFile, relativePath: relativeApiPath(apiRoot, tsFile) });
      }
    }
  }

  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function buildSidecarHandlers() {
  const entries = await discoverSidecarHandlerEntries();
  if (entries.length === 0) {
    console.log('build:sidecar-handlers  no domain handlers found, skipping');
    return;
  }

  try {
    await build({
      entryPoints: entries.map(({ entryPoint }) => entryPoint),
      outdir: ROOT,
      outbase: ROOT,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      treeShaking: true,
      // Resolve @/ alias to src/
      alias: { '@': path.join(ROOT, 'src') },
    });

    // Report results
    let totalKB = 0;
    for (const { entryPoint } of entries) {
      const jsFile = entryPoint.replace(/\.ts$/, '.js');
      if (existsSync(jsFile)) {
        const { size } = await stat(jsFile);
        totalKB += size / 1024;
      }
    }
    console.log(`build:sidecar-handlers  ${entries.length} domains  ${totalKB.toFixed(0)} KB total`);
  } catch (err) {
    console.error('build:sidecar-handlers failed:', err.message);
    process.exitCode = 1;
  }
}

const invokedFromCli =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedFromCli) {
  await buildSidecarHandlers();
}
