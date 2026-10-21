import { sentryVitePlugin } from '@sentry/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import pkg from '../package.json';
import { getSentryBuildMetadata } from '../shared/sentry-build-metadata';

// Mirrors the root config's gate. WORLDMONITOR-11Y and -107 are marketing-bundle
// events that arrived with zero usable frames, so covering only the dashboard
// would leave this half of the surface unreadable.
const uploadSourceMapsToSentry = Boolean(process.env.SENTRY_AUTH_TOKEN);
const sentryBuild = getSentryBuildMetadata(pkg.version, process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev');

const STATIC_SCRIPT_NONCE = 'wm-static-bootstrap';

function isWelcomeHtml(hostId: string) {
  return hostId === 'welcome.html' || hostId.endsWith('/welcome.html');
}

function isWelcomeHydrationPreload(dep: string) {
  const basename = dep.split('/').pop() ?? dep;
  return basename.startsWith('index-') && basename.endsWith('.js');
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_HASH__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev'),
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(uploadSourceMapsToSentry
      ? [sentryVitePlugin({
          org: 'elie-habib',
          project: 'worldmonitor',
          authToken: process.env.SENTRY_AUTH_TOKEN,
          telemetry: false,
          release: {
            name: sentryBuild.release,
            inject: false,
            dist: sentryBuild.dist,
            // The root build publishes the release after both bundles build.
            create: false,
            finalize: false,
            setCommits: false,
            deploy: false,
          },
          sourcemaps: {
            // This bundle emits into ../public/pro, which the root build copies
            // wholesale into dist — a leftover map would ship publicly whatever
            // the root's preview flag says. Always sweep them, so public output
            // stays exactly as it is today (no marketing maps served).
            filesToDeleteAfterUpload: ['../public/pro/**/*.map'],
          },
        })]
      : []),
  ],
  base: '/pro/',
  // Local WebMCP testing uses chrome://flags/#enable-webmcp-testing instead of
  // an origin-trial token. Keep the browser security gates aligned with the
  // production homepage so the flag-based smoke exercises the real boundary.
  server: {
    headers: {
      'Origin-Agent-Cluster': '?1',
      'Permissions-Policy': 'tools=(self)',
    },
  },
  html: {
    cspNonce: STATIC_SCRIPT_NONCE,
  },
  build: {
    // Built only to be uploaded; filesToDeleteAfterUpload removes them again.
    sourcemap: uploadSourceMapsToSentry,
    // @clerk/clerk-js ships as one monolithic vendor SDK (~3MB) that can't be
    // split further; it's already dynamically imported (services/clerk.ts)
    // so it never loads on first paint. Raise the warning threshold to match.
    chunkSizeWarningLimit: 3500,
    modulePreload: {
      resolveDependencies: (filename, deps, context) => {
        if (context.hostType !== 'html') return deps;

        const hostId = 'hostId' in context && typeof context.hostId === 'string'
          ? context.hostId
          : filename;
        if (!isWelcomeHtml(hostId)) return deps;

        return deps.filter(dep => !isWelcomeHydrationPreload(dep));
      },
    },
    outDir: path.resolve(__dirname, '../public/pro'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        welcome: path.resolve(__dirname, 'welcome.html'),
      },
      output: {
        // Split the Sentry SDK into its own stable chunk. It's a critical-path
        // dependency (initSentry() runs before render to catch early errors, so
        // it isn't deferrable), but pulling it out of the catch-all vendor chunk
        // keeps it cacheable across the frequent app-code redeploys that would
        // otherwise re-bust its bytes.
        manualChunks: (id) => {
          if (id.includes('/node_modules/@sentry/')) return 'sentry';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
