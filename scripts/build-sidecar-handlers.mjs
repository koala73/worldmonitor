/**
 * Compiles per-domain RPC handlers (api/{domain}/v1/[rpc].ts) into bundled
 * ESM .js files so the Tauri sidecar's buildRouteTable() can load them.
 *
 * Versioned route families live at api/v{N}/{domain}/[rpc].ts instead (the
 * first was api/v2/shipping). Those are NOT bundled by default: each one has
 * to be declared below as deliberately cloud-routed — and mirrored in the
 * sidecar's `cloudOnlyRouteFamilyPrefixes` — or this build fails. Before
 * #5907 the v1-only glob simply never saw them, so the family reached the
 * desktop only through the sidecar's 404 cloud fallback, an accidental
 * routing decision nothing recorded. tests/sidecar-desktop-path-decisions
 * .test.mjs holds the declaration, the sidecar and server/worldmonitor/ in
 * step.
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

/**
 * Versioned families (`v{N}/{domain}`) the desktop deliberately does not bundle.
 * The sidecar routes each prefix to the cloud on purpose (#5907):
 *
 * - v2/shipping — route-intelligence reads seed-owned Redis the desktop has no
 *   credentials for (an empty 200 locally, so the `!ok` fallback would never
 *   fire), and the webhook family persists registrations server-side and is
 *   Pro-gated in src/shared/premium-paths.ts; the gate lives at the cloud.
 */
export const CLOUD_ONLY_ROUTE_FAMILIES = new Set(['v2/shipping']);

const VERSION_DIR = /^v\d+$/;

// Discover all api/{domain}/v1/[rpc].ts entry points, and every versioned
// api/v{N}/{domain}/[rpc].ts family so an undeclared one cannot slip past.
const entries = [];
const undeclaredFamilies = [];
const skippedFamilies = [];
const dirs = await readdir(apiDir, { withFileTypes: true });
for (const d of dirs) {
  if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
  if (VERSION_DIR.test(d.name)) {
    const versionDir = path.join(apiDir, d.name);
    for (const family of await readdir(versionDir, { withFileTypes: true })) {
      if (!family.isDirectory()) continue;
      if (!existsSync(path.join(versionDir, family.name, '[rpc].ts'))) continue;
      const key = `${d.name}/${family.name}`;
      (CLOUD_ONLY_ROUTE_FAMILIES.has(key) ? skippedFamilies : undeclaredFamilies).push(key);
    }
    continue;
  }
  const tsFile = path.join(apiDir, d.name, 'v1', '[rpc].ts');
  if (existsSync(tsFile)) {
    entries.push(tsFile);
  }
}

if (undeclaredFamilies.length > 0) {
  console.error(
    `build:sidecar-handlers  undeclared versioned route family: ${undeclaredFamilies.join(', ')}\n` +
    '  Either bundle it for the desktop sidecar or add it to CLOUD_ONLY_ROUTE_FAMILIES ' +
    'here AND to cloudOnlyRouteFamilyPrefixes in src-tauri/sidecar/local-api-server.mjs (#5907).',
  );
  process.exit(1);
}
for (const key of skippedFamilies) {
  console.log(`build:sidecar-handlers  api/${key} declared cloud-only, not bundled (#5907)`);
}

if (entries.length === 0) {
  console.log('build:sidecar-handlers  no domain handlers found, skipping');
  process.exit(0);
}

try {
  await build({
    entryPoints: entries,
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
  for (const entry of entries) {
    const jsFile = entry.replace(/\.ts$/, '.js');
    if (existsSync(jsFile)) {
      const { size } = await stat(jsFile);
      totalKB += size / 1024;
    }
  }
  console.log(`build:sidecar-handlers  ${entries.length} domains  ${totalKB.toFixed(0)} KB total`);
} catch (err) {
  console.error('build:sidecar-handlers failed:', err.message);
  process.exit(1);
}
