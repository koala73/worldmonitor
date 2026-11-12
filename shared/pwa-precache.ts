import type { Plugin } from 'vite';
import type { ManifestTransform, RuntimeCaching } from 'workbox-build';

export const appChunkRuntimeCache: RuntimeCaching = {
  urlPattern: ({ url, sameOrigin }) => sameOrigin && /^\/assets\/.+\.(?:js|css)$/i.test(url.pathname),
  handler: 'StaleWhileRevalidate',
  options: {
    cacheName: 'app-chunks',
    // Retain a complete build; the generated-worker guard checks this capacity.
    expiration: { maxEntries: 512, maxAgeSeconds: 30 * 24 * 60 * 60 },
    cacheableResponse: { statuses: [200] },
  },
};

export function createDashboardPrecache(): { plugin: Plugin; manifestTransform: ManifestTransform } {
  let shellFiles: Set<string> | undefined;

  return {
    plugin: {
      name: 'wm-dashboard-precache',
      apply: 'build',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const entry = Object.values(bundle).find((output) =>
          output.type === 'chunk' && output.isEntry && output.name === 'main',
        );
        if (!entry) throw new Error('[pwa] dashboard entry is missing');

        const files = new Set<string>();
        const visit = (fileName: string) => {
          if (files.has(fileName)) return;
          const chunk = bundle[fileName];
          if (!chunk || chunk.type !== 'chunk') return;
          files.add(fileName);
          for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(css);
          for (const imported of chunk.imports) visit(imported);
        };
        // Dynamic imports belong in the runtime cache, including other HTML entries.
        visit(entry.fileName);
        shellFiles = files;
      },
    },
    manifestTransform(entries) {
      if (!shellFiles) throw new Error('[pwa] dashboard bundle has not been collected');
      const files = shellFiles;
      const manifest = entries.filter(({ url }) => files.has(url));
      const included = new Set(manifest.map(({ url }) => url));
      const missing = [...files].filter((file) => !included.has(file));
      if (missing.length) throw new Error(`[pwa] dashboard precache is missing: ${missing.join(', ')}`);
      return { manifest, warnings: [] };
    },
  };
}
