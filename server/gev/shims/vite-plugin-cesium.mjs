/**
 * Stand-in for `vite-plugin-cesium` in the standalone God's Eye View API.
 *
 * The vendored `src/gev/vite.config.js` imports and calls this plugin so its
 * dev server can serve Cesium's engine assets. The API server harvests only
 * the `*-proxy` plugins from that config and skips this one entirely, so the
 * real package — which pulls in Vite internals and copies ~14 MB of engine
 * files — has no business in the production container.
 *
 * Aliased in by scripts/build-gev-api.mjs. The real plugin is still used for
 * the browser build; see the root vite.config.ts.
 */

export default function cesium() {
  return { name: 'vite-plugin-cesium' };
}
