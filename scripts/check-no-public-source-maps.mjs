#!/usr/bin/env node
// Deploy gate: fail a build whose output would publish source maps.
//
// Production maps go to Sentry only (shared/source-map-policy.ts). The Vite
// configs and the wm-strip-private-source-maps plugin enforce that; this gate
// re-checks the final tree after every build step (blog, /pro, dashboard,
// embed plugin) so a new bundler, plugin, or copied public/ file cannot
// reintroduce a public map unnoticed. Previews and opted-in local builds,
// which publish maps deliberately, skip the check.
//
// Usage: node --import tsx scripts/check-no-public-source-maps.mjs [dir=dist]

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shouldEmitPublicSourceMaps } from '../shared/source-map-policy.ts';

const SOURCE_MAP_FILE = /\.map(\.br|\.gz)?$/i;
// HTML too: an inline <script> or <style> can carry an inline data: map.
const TEXT_ASSET = /\.(c|m)?js$|\.css$|\.html?$/i;
// Matches the trailing //# or /*# pragma, including inline data: maps.
const SOURCE_MAPPING_URL = /[/][/*][#@]\s*sourceMappingURL=/;

export async function findPublicSourceMapLeaks(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const mapFiles = [];
  const referencingFiles = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (SOURCE_MAP_FILE.test(entry.name)) {
      mapFiles.push(relative(dir, path));
    } else if (TEXT_ASSET.test(entry.name)) {
      const source = await readFile(path, 'utf8');
      if (SOURCE_MAPPING_URL.test(source)) referencingFiles.push(relative(dir, path));
    }
  }
  return { mapFiles: mapFiles.sort(), referencingFiles: referencingFiles.sort() };
}

async function main() {
  const dir = process.argv[2] ?? 'dist';
  if (shouldEmitPublicSourceMaps(process.env)) {
    console.log(`[source-maps] public maps are allowed for this build; skipping check of ${dir}`);
    return;
  }
  const { mapFiles, referencingFiles } = await findPublicSourceMapLeaks(dir);
  if (mapFiles.length === 0 && referencingFiles.length === 0) {
    console.log(`[source-maps] OK: no source maps or sourceMappingURL references in ${dir}`);
    return;
  }
  const show = (list) => list.slice(0, 20).map((p) => `  - ${p}`).join('\n') + (list.length > 20 ? `\n  … and ${list.length - 20} more` : '');
  if (mapFiles.length) console.error(`[source-maps] ${mapFiles.length} source map file(s) would be published:\n${show(mapFiles)}`);
  if (referencingFiles.length) console.error(`[source-maps] ${referencingFiles.length} file(s) reference a source map:\n${show(referencingFiles)}`);
  console.error('[source-maps] Production maps must go to Sentry only. Build them hidden and delete them after upload; see shared/source-map-policy.ts.');
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
