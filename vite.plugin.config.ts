import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import pkg from './package.json';

export default defineConfig({
  base: '/plugin/',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      child_process: resolve(__dirname, 'src/shims/child-process.ts'),
      'node:child_process': resolve(__dirname, 'src/shims/child-process.ts'),
      '@loaders.gl/worker-utils/dist/lib/process-utils/child-process-proxy.js': resolve(__dirname, 'src/shims/child-process-proxy.ts'),
    },
  },
  define: {
    'import.meta.env.VITE_PMTILES_URL': JSON.stringify(''),
    'import.meta.env.VITE_COUNTRY_OVERRIDES_URL': JSON.stringify('/data/country-boundary-overrides.geojson'),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_HASH__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev'),
    __CLERK_JS_VERSION__: JSON.stringify(pkg.dependencies['@clerk/clerk-js'].replace(/^[\^~>=<\s]*/, '')),
  },
  worker: { format: 'es' },
  // The views run in a host sandbox on another origin, and Claude's sandbox
  // blocks <base>. URLs that JS builds (preloads, stylesheets, workers) must
  // therefore resolve against the chunk's own URL, not the document.
  // The MCP shell imports chunks from /plugin/assets/boot-N/, which only
  // rewrites .js files. JS deps stay relative so each boot attempt gets fresh
  // modules. Every other asset resolves to the canonical /plugin/ directory
  // on the chunk's origin. The HTML entry keeps its /plugin/ paths, which the
  // MCP shell validates and loads by absolute URL.
  experimental: {
    renderBuiltUrl: (filename, { hostType }) => {
      if (hostType !== 'js') return undefined;
      if (filename.endsWith('.js')) return { relative: true };
      return { runtime: `new URL(${JSON.stringify(`/plugin/${filename}`)}, import.meta.url).href` };
    },
  },
  build: {
    outDir: 'dist/plugin',
    copyPublicDir: false,
    rollupOptions: { input: { plugin: resolve(__dirname, 'plugin.html'), country: resolve(__dirname, 'country.html'), market: resolve(__dirname, 'market.html') } },
  },
});
