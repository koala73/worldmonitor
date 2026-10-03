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
  build: {
    outDir: 'dist/plugin',
    copyPublicDir: false,
    rollupOptions: { input: { plugin: resolve(__dirname, 'plugin.html'), country: resolve(__dirname, 'country.html'), market: resolve(__dirname, 'market.html') } },
  },
});
