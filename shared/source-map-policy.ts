import { readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface SourceMapEnv {
  VERCEL_ENV?: string;
  WM_EMIT_SOURCEMAPS?: string;
  SENTRY_AUTH_TOKEN?: string;
}

/**
 * Previews serve public maps for readable attribution (#7382), and a local
 * build can opt in with WM_EMIT_SOURCEMAPS=1. A production deploy never does:
 * its maps go to Sentry and nowhere else.
 */
export function shouldEmitPublicSourceMaps(env: SourceMapEnv): boolean {
  if (env.VERCEL_ENV === 'production') return false;
  return env.WM_EMIT_SOURCEMAPS === '1' || env.VERCEL_ENV === 'preview';
}

/**
 * Vite `build.sourcemap` value. Maps built only for the Sentry upload are
 * 'hidden': Sentry matches them by debug ID, so the bundles need no
 * sourceMappingURL comment pointing at a file that is never served.
 */
export function viteSourcemapSetting(env: SourceMapEnv): boolean | 'hidden' {
  if (shouldEmitPublicSourceMaps(env)) return true;
  return env.SENTRY_AUTH_TOKEN ? 'hidden' : false;
}

const SOURCE_MAP_FILE = /\.map(\.br|\.gz)?$/i;

/**
 * Delete every source map (and precompressed copy) under `dir`. Returns the
 * removed paths relative to `dir`. A missing directory removes nothing.
 */
export async function removeSourceMaps(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const maps = entries
    .filter((entry) => entry.isFile() && SOURCE_MAP_FILE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  await Promise.all(maps.map((path) => rm(path)));
  return maps.map((path) => relative(dir, path));
}
