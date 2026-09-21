import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const wmRoot = path.resolve(__dirname, '..');
const wmSrc = path.resolve(wmRoot, 'src');

/**
 * Loopback host for the React rewrite + vanilla WM pair.
 * Always IPv4 `127.0.0.1` in local/dev so Windows never binds :3030 on [::1]
 * while :3020 proxies to 127.0.0.1 (ECONNREFUSED / AggregateError).
 *
 * Production does not use this hop: the browser calls same-origin `/api/*`
 * (empty getConfiguredWebApiBaseUrl on non-worldmonitor hosts), and the
 * deploy edge / nginx must reverse-proxy `/api` — same contract as vanilla
 * self-hosted WM (`docker/nginx.conf.template`).
 */
function resolveDevHost(env: Record<string, string>): string {
  return env.DEV_HOST || process.env.DEV_HOST || '127.0.0.1';
}

function resolveDevApiProxy(env: Record<string, string>, host: string): string {
  if (process.env.WM_API_PROXY) return process.env.WM_API_PROXY;
  if (env.WM_API_PROXY) return env.WM_API_PROXY;
  const port = env.WM_API_PORT || process.env.WM_API_PORT || '3030';
  return `http://${host}:${port}`;
}

/** Preview / production-like same-origin `/api` upstream. */
function resolveProdApiProxy(env: Record<string, string>): string {
  return (
    process.env.WM_API_PROXY ||
    env.WM_API_PROXY ||
    process.env.WM_PROD_API_PROXY ||
    env.WM_PROD_API_PROXY ||
    'https://api.worldmonitor.app'
  );
}

function apiProxy(target: string, label: string) {
  return {
    target,
    changeOrigin: true,
    secure: target.startsWith('https'),
    configure: (proxy: { on: (event: string, fn: (...args: unknown[]) => void) => void }) => {
      proxy.on('error', (err: unknown, _req: unknown, res: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[wm-react ${label} proxy]`, message);
        const serverRes = res as import('http').ServerResponse | undefined;
        if (serverRes && 'writeHead' in serverRes && !serverRes.headersSent) {
          serverRes.writeHead(502);
          serverRes.end(
            `WM API proxy error (${label} → ${target}). Start vanilla on matching host or set WM_API_PROXY.`,
          );
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const devHost = resolveDevHost(env);
  const devApi = resolveDevApiProxy(env, devHost);
  const prodApi = resolveProdApiProxy(env);

  return {
    plugins: [react()],
    // Serve vanilla public assets (/data/countries.geojson, /map-styles, …)
    publicDir: path.resolve(wmRoot, 'public'),
    resolve: {
      alias: {
        '@': wmSrc,
        '@wm-shared': path.resolve(wmRoot, 'shared'),
        '@react': path.resolve(__dirname, 'src'),
        child_process: path.resolve(wmSrc, 'shims/child-process.ts'),
        'node:child_process': path.resolve(wmSrc, 'shims/child-process.ts'),
        '@loaders.gl/worker-utils/dist/lib/process-utils/child-process-proxy.js': path.resolve(
          wmSrc,
          'shims/child-process-proxy.ts',
        ),
      },
      // One MapLibre copy for DeckCompatibleMap + MapboxOverlay (duplicate
      // instances break interleaved / overlay projection).
      dedupe: ['maplibre-gl', 'mapbox-gl'],
    },
    worker: {
      format: 'es',
    },
    server: {
      host: devHost,
      port: 3020,
      strictPort: true,
      proxy: {
        '/wm-mcp': {
          target: 'https://worldmonitor.app',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/wm-mcp/, '/mcp'),
        },
        // Same-origin `/api` → vanilla WM (must share DEV_HOST family with :3030)
        '/api': apiProxy(devApi, 'dev'),
      },
    },
    // Production smoke: `vite preview` keeps same-origin `/api` (CORS-safe on loopback)
    // by proxying to the public API — mirrors nginx /api → API_UPSTREAM.
    preview: {
      host: devHost,
      port: 3020,
      strictPort: true,
      proxy: {
        '/wm-mcp': {
          target: 'https://worldmonitor.app',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/wm-mcp/, '/mcp'),
        },
        '/api': apiProxy(prodApi, 'preview'),
      },
    },
    optimizeDeps: {
      include: [
        'maplibre-gl',
        'deck.gl',
        '@deck.gl/core',
        '@deck.gl/layers',
        '@deck.gl/mapbox',
      ],
    },
  };
});
