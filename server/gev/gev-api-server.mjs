/**
 * God's Eye View API — the 24 upstream proxy routes, served outside Vite.
 *
 * ## Why this exists
 *
 * Upstream implements its entire backend as Vite dev-server middleware inside
 * a 7,383-line `vite.config.js`. That is fine for a `vite dev` demo and
 * useless anywhere else: only 8 of its 19 proxy plugins register
 * `configurePreviewServer`, so `vite build && vite preview` serves a UI whose
 * every data layer 404s, and a docker or Tauri deployment has no backend at
 * all.
 *
 * ## Why it *lifts* rather than copies
 *
 * The obvious move — port each route into `api/` as a World Monitor handler —
 * means rewriting ~7,000 lines of upstream code, and every future re-vendor
 * becomes a manual reconciliation. Instead this module imports the vendored
 * config, calls its factory, and replays each proxy plugin's
 * `configureServer` hook against a plain Connect app.
 *
 * That works because those plugins touch exactly two properties of the object
 * Vite hands them: `server.middlewares` (28 call sites) and
 * `server.httpServer` (2, for the AIS websocket upgrade). `server.middlewares`
 * IS a Connect app in Vite, so the shim below is faithful rather than
 * approximate — including the mount-path semantics the handlers depend on
 * (see `remountUnderGev`).
 *
 * Net effect: upstream's backend code stays byte-identical in `src/gev/`, and
 * re-vendoring a newer God's Eye View picks up new routes for free.
 *
 * ## Mounting
 *
 * Routes are served under `/api/gev/*`, not `/api/*`. Three reasons:
 *   1. `/api/opensky` collides outright — World Monitor has its own.
 *   2. One nginx `location /api/gev/` beats 24 per-route rules.
 *   3. It stays collision-proof as both codebases grow.
 *
 * The client side of that agreement lives in the vendored tree; see
 * `scripts/vendor-gev-api-base.mjs` and the guard in
 * `tests/gev-api-contract.test.mjs`.
 */

import connect from 'connect';
// Static, not dynamic: scripts/build-gev-api.mjs bundles this whole module
// (upstream's config included) into one self-contained file for the docker
// runtime, and esbuild can only inline an import it can resolve statically.
// `vite` and `vite-plugin-cesium` are aliased to shims at bundle time.
import gevConfigFactory from '../../src/gev/vite.config.js';
import {
  GEV_API_PREFIX,
  applyGevEnvAliases,
  isGevProxyPlugin,
  remountUnderGev,
} from './gev-api-paths.mjs';

export { GEV_API_PREFIX, GEV_ENV_ALIASES, applyGevEnvAliases, remountUnderGev }
  from './gev-api-paths.mjs';

/**
 * Build the Connect app that serves God's Eye View's API.
 *
 * @param {object}  [options]
 * @param {import('node:http').Server|null} [options.httpServer]
 *        Needed only by the AIS live proxy, which attaches a websocket
 *        upgrade handler. Omit it and that one layer degrades; everything
 *        else works.
 * @param {string}  [options.mode='production'] Vite mode passed to the config.
 * @param {object}  [options.env=process.env]
 * @returns {Promise<{ app: import('connect').Server, routes: string[] }>}
 */
export async function createGevApiApp(options = {}) {
  const { httpServer = null, mode = 'production', env = process.env } = options;

  applyGevEnvAliases(env);

  if (typeof gevConfigFactory !== 'function') {
    throw new Error('src/gev/vite.config.js no longer default-exports a config factory');
  }
  const config = await gevConfigFactory({ mode, command: 'serve' });
  const plugins = (config.plugins ?? []).flat().filter(Boolean);

  const app = connect();
  const routes = [];

  // The shim standing in for Vite's ViteDevServer. Deliberately minimal: if a
  // future upstream plugin reaches for something else, it should fail loudly
  // here rather than silently no-op.
  const serverShim = {
    middlewares: {
      use(pathOrHandler, maybeHandler) {
        if (typeof pathOrHandler === 'function') {
          app.use(pathOrHandler);
          return;
        }
        const mounted = remountUnderGev(pathOrHandler);
        routes.push(mounted);
        app.use(mounted, maybeHandler);
      },
    },
    httpServer,
  };

  for (const plugin of plugins) {
    if (!isGevProxyPlugin(plugin)) continue;
    // configureServer and configurePreviewServer are the same installer on
    // every upstream plugin that declares both, so run exactly one.
    const hook = plugin.configureServer ?? plugin.configurePreviewServer;
    if (typeof hook === 'function') await hook(serverShim);
  }

  if (routes.length === 0) {
    throw new Error(
      'No God\'s Eye View proxy routes were registered — the vendored '
      + 'vite.config.js shape has changed. See server/gev/gev-api-server.mjs.',
    );
  }

  return { app, routes: routes.sort() };
}

/**
 * Mount the GEV API onto an existing Connect-style app.
 *
 * The app is inserted whole rather than per-route: its own internal mount
 * paths already carry the `/api/gev` prefix, so a single `use()` keeps
 * `req.url` intact for the inner router to strip.
 */
export async function mountGevApi(hostApp, options = {}) {
  const { app, routes } = await createGevApiApp(options);
  hostApp.use(app);
  return routes;
}
