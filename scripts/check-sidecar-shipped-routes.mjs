#!/usr/bin/env node
/**
 * Shipped sidecar route check (#9906).
 *
 * The desktop app ships `api/` as a Tauri resource, without `node_modules`,
 * and the sidecar imports every route module under it on demand. A route that
 * imports an npm package, or a file the resources leave out, cannot load on
 * desktop. The sidecar catches ERR_MODULE_NOT_FOUND, logs it once and sends
 * the request to the cloud, so nothing visibly breaks while the user is online.
 * v2.11.6 shipped 13 such routes. CI never saw them: the sidecar suite tests
 * fixture handlers, and `unit` only checks that the handler bundles exist.
 *
 * This check copies the resources listed in src-tauri/tauri.conf.json into a
 * temp directory with the layout Tauri gives them (`../api` becomes
 * `_up_/api`), then imports every route the sidecar's route table would load.
 * It copies rather than symlinks: Node resolves a symlinked module through its
 * real path, which would find the repository's node_modules and hide the bug.
 *
 * Build the handler bundles first (build-sidecar-sebuf, build-sidecar-handlers).
 * Run it with the Node the desktop ships, since that is what loads the routes.
 *
 * Run: node scripts/check-sidecar-shipped-routes.mjs [--root <repo-root>]
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isMainModule } from './lib/main-module.mjs';

// The bundled runtime is large and loads nothing from api/.
const SKIPPED_RESOURCES = new Set(['sidecar/node']);

// Routes allowed to fail to load on desktop, keyed by route module. Each must
// stay cloud-preferred in the sidecar, which the check verifies, so the
// desktop only tries it locally when the cloud cannot answer either.
export const CLOUD_ONLY_ROUTES = new Map([
  // Serves seeded Redis snapshots the desktop does not hold, and imports
  // @vercel/functions and aws4fetch for its R2 shadow read.
  ['bootstrap.js', '/api/bootstrap'],
]);

/** Tauri places a resource path's leading `../` segments under `_up_/`. */
export function shippedResourcePath(entry) {
  return entry.replace(/^(\.\.\/)+/, (ups) => '_up_/'.repeat(ups.length / 3));
}

export function stageShippedResources(root, stageDir) {
  const tauriDir = path.join(root, 'src-tauri');
  const config = JSON.parse(readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const resources = config.bundle?.resources;
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error('src-tauri/tauri.conf.json has no bundle.resources list');
  }
  for (const entry of resources) {
    if (SKIPPED_RESOURCES.has(entry)) continue;
    const source = path.resolve(tauriDir, entry);
    if (!existsSync(source)) throw new Error(`bundle resource ${entry} does not exist (${source})`);
    cpSync(source, path.join(stageDir, shippedResourcePath(entry)), { recursive: true, dereference: true });
  }
}

/** Mirrors buildRouteTable() in src-tauri/sidecar/local-api-server.mjs. */
export function listRouteModules(apiDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('_')) files.push(absolute);
    }
  };
  walk(apiDir);
  return files.sort();
}

/** Every api/{domain}/v1/[rpc].ts must have its bundle, or the check proves nothing for it. */
export function findMissingBundles(apiDir) {
  return readdirSync(apiDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(apiDir, d.name, 'v1', '[rpc].ts')))
    .map((d) => d.name)
    .filter((domain) => !existsSync(path.join(apiDir, domain, 'v1', '[rpc].js')));
}

/**
 * @param {string} root
 * @param {{ isCloudPreferred: (pathname: string) => boolean, cloudOnlyRoutes?: Map<string, string> }} options
 */
export async function checkShippedRoutes(root, { isCloudPreferred, cloudOnlyRoutes = CLOUD_ONLY_ROUTES }) {
  const stageDir = mkdtempSync(path.join(os.tmpdir(), 'wm-sidecar-shipped-'));
  try {
    stageShippedResources(root, stageDir);
    const apiDir = [path.join(stageDir, 'api'), path.join(stageDir, '_up_', 'api')].find((dir) => existsSync(dir));
    if (!apiDir) throw new Error('the bundle resources ship no api/ directory');
    const missingBundles = findMissingBundles(apiDir);
    const routes = listRouteModules(apiDir);
    const failures = [];
    for (const [route, pathname] of cloudOnlyRoutes) {
      if (!isCloudPreferred(pathname)) {
        failures.push({ route, reason: `exempt as cloud-only, but the sidecar does not treat ${pathname} as cloud-preferred` });
      }
    }
    for (const modulePath of routes) {
      const route = path.relative(apiDir, modulePath).split(path.sep).join('/');
      if (cloudOnlyRoutes.has(route)) continue;
      try {
        const mod = await import(pathToFileURL(modulePath).href);
        if (typeof mod.default !== 'function') failures.push({ route, reason: `default export is ${typeof mod.default}` });
      } catch (error) {
        const reason = String(error?.message ?? error).split('\n')[0].split(stageDir).join('<resources>');
        failures.push({ route, reason });
      }
    }
    return { routes: routes.length, missingBundles, failures };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { root };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const { root } = parseArgs(process.argv.slice(2));
  const { __testing__ } = await import(pathToFileURL(path.join(root, 'src-tauri/sidecar/local-api-server.mjs')).href);
  const { routes, missingBundles, failures } = await checkShippedRoutes(root, { isCloudPreferred: __testing__.isCloudPreferred });
  let failed = false;
  if (missingBundles.length > 0) {
    console.error(`::error::sidecar handler bundles not built for: ${missingBundles.join(', ')}. Run scripts/build-sidecar-handlers.mjs first.`);
    failed = true;
  }
  if (routes === 0) {
    console.error('::error::found no sidecar route modules in the shipped api/ directory');
    failed = true;
  }
  for (const { route, reason } of failures) {
    console.error(`::error::shipped sidecar route api/${route} does not load on Node ${process.version}: ${reason}`);
  }
  if (failures.length > 0) failed = true;
  console.log(`shipped sidecar routes: ${failures.length} failed of ${routes} (${CLOUD_ONLY_ROUTES.size} exempt as cloud-only) on Node ${process.version}`);
  // Route modules can leave timers or sockets open; the verdict is already known.
  process.exit(failed ? 1 : 0);
}
