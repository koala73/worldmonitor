/**
 * Minimal stand-in for the two `vite` exports God's Eye View's config uses.
 *
 * `src/gev/vite.config.js` is imported by server/gev/gev-api-server.mjs to
 * harvest its proxy middleware. That import would otherwise drag the whole
 * Vite package — plus rollup and esbuild — into the production container, for
 * the sake of two functions that are trivial and one plugin we skip anyway.
 *
 * scripts/build-gev-api.mjs aliases `vite` to this file when bundling the
 * standalone server, mirroring what docker/build-handlers.mjs already does
 * for World Monitor's own API handlers: self-contained ESM, no node_modules.
 *
 * In dev and preview the real Vite is loaded normally — this shim is only
 * ever reached through the bundler alias.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Vite's `defineConfig` is identity at runtime; it exists for typing. */
export function defineConfig(config) {
  return config;
}

/**
 * A faithful-enough `loadEnv`.
 *
 * Upstream calls `loadEnv(mode, __dirname, '')` — the empty prefix means "every
 * key, not just VITE_-prefixed ones" — and then only uses the result to fill
 * variables that are NOT already in `process.env`. So the container path,
 * where every key arrives through the environment, works even if this returns
 * nothing. Reading the files anyway keeps `node server/gev/serve.mjs` behaving
 * the same as the dev server for someone debugging locally.
 *
 * Deliberately simple: `KEY=value` lines, `#` comments, optional surrounding
 * quotes. No interpolation, no multi-line values — upstream's .env files use
 * none, and quietly mis-parsing a credential is worse than not reading it.
 */
export function loadEnv(mode, envDir, prefixes = 'VITE_') {
  const prefixList = Array.isArray(prefixes) ? prefixes : [prefixes];
  const files = [
    '.env',
    '.env.local',
    `.env.${mode}`,
    `.env.${mode}.local`,
  ];

  const out = {};
  for (const file of files) {
    const path = join(envDir, file);
    if (!existsSync(path)) continue;
    let contents;
    try {
      contents = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    for (const rawLine of contents.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (!prefixList.some((p) => key.startsWith(p))) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1)
        || (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  }
  return out;
}
