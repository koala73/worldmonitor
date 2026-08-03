// Shared esbuild harness for tests that need the EXECUTABLE feed catalog
// (tests/theater-presets.test.mts, tests/feed-catalog-drift.test.mts,
// tests/source-provenance.test.mts — #5956 review follow-up). The block was
// previously hand-copied across all three; a define or stub drift between the
// copies would make the guards disagree about the same registry.
//
// Why bundling at all: src/config/feeds.ts pulls `rssProxyUrl` →
// `import.meta.env.DEV`, and Node/tsx has no Vite env object, so the module
// cannot be imported directly. We esbuild-bundle with defines, stub the
// `@/utils` barrel so the bundle doesn't drag proxy → i18n → import.meta.glob
// (feeds.ts only needs rssProxyUrl, and identity is fine for name-based
// registries), then dynamically import the written bundle with a cache buster.
//
// This module is test infrastructure only — it lives under tests/ and is
// never shipped.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Plugin, type PluginBuild } from 'esbuild';

export interface BundleFeedsModuleOptions {
  /** Absolute repo root; used as absWorkingDir and for the `@` → src alias. */
  repoRoot: string;
  /** Temp dir the caller owns (its after()/exit cleanup removes it). */
  tempDir: string;
  /** Bundle file name inside tempDir. Defaults to 'feeds-bundle.mjs'. */
  outfileName?: string;
  /** Absolute entry point. Defaults to <repoRoot>/src/config/feeds.ts; pass a
   *  different src entry (e.g. a component module) to reuse the same stub +
   *  defines for a sibling bundle. */
  entryPoint?: string;
}

export async function bundleFeedsModule<T>(opts: BundleFeedsModuleOptions): Promise<T> {
  const { repoRoot, tempDir } = opts;
  const outfile = join(tempDir, opts.outfileName ?? 'feeds-bundle.mjs');
  mkdirSync(tempDir, { recursive: true });

  const stubUtilsPlugin: Plugin = {
    name: 'stub-utils-barrel',
    setup(buildApi: PluginBuild) {
      buildApi.onResolve({ filter: /^@\/utils$/ }, () => ({
        path: 'stub-utils',
        namespace: 'stub',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export function rssProxyUrl(url) { return url; }\n',
        loader: 'js',
      }));
    },
  };

  const result = await build({
    entryPoints: [opts.entryPoint ?? join(repoRoot, 'src/config/feeds.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    absWorkingDir: repoRoot,
    alias: { '@': join(repoRoot, 'src') },
    plugins: [stubUtilsPlugin],
    define: {
      'import.meta.env': JSON.stringify({
        DEV: false,
        PROD: true,
        SSR: false,
        MODE: 'test',
        BASE_URL: '/',
        VITE_VARIANT: 'full',
        VITE_RSS_DIRECT_TO_RELAY: 'false',
      }),
    },
  });

  writeFileSync(outfile, result.outputFiles[0]!.text, 'utf8');
  return (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as T;
}
