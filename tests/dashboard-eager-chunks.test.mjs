import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const distDir = resolve(repoRoot, 'dist');
const dashboardHtml = resolve(distDir, 'dashboard.html');

// Large static config DATA TABLES intentionally kept OFF the eager dashboard
// critical path (#4404 — main.js diet round 2). Each must (a) build as its own
// chunk and (b) NOT appear in dashboard.html modulepreload or be statically
// imported by the main entry chunk. A re-added @/config barrel value re-export
// or a new eager consumer would re-eagerise the table and fail this guard.
//
// Dist-gated: skips when dist/dashboard.html is absent. CI builds the dashboard
// before `npm run test:data` (the step added in #4393), so this runs in CI.
const DEFERRED_TABLE_CHUNKS = ['tech-geo-data', 'airports-data'];

describe('eager chunk budget: lazy-only config data tables stay off the entry', { skip: !existsSync(dashboardHtml) }, () => {
  const html = readFileSync(dashboardHtml, 'utf-8');
  const assetsDir = resolve(distDir, 'assets');
  const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const mainFile = assets.find((f) => /^main-[A-Za-z0-9_-]+\.js$/.test(f));
  const mainJs = mainFile ? readFileSync(resolve(assetsDir, mainFile), 'utf-8') : '';

  for (const chunk of DEFERRED_TABLE_CHUNKS) {
    it(`${chunk}: built as its own isolated chunk`, () => {
      assert.ok(
        assets.some((f) => f.startsWith(`${chunk}-`) && f.endsWith('.js')),
        `${chunk}-*.js chunk should exist (manualChunks rule present)`,
      );
    });

    it(`${chunk}: absent from dashboard.html modulepreload`, () => {
      assert.ok(
        !html.includes(chunk),
        `${chunk} must not be eagerly modulepreloaded in dashboard.html — a barrel value re-export or eager consumer re-eagerised it`,
      );
    });

    it(`${chunk}: not statically imported by the main entry chunk`, () => {
      assert.ok(mainFile, 'main-*.js entry chunk should exist in dist/assets');
      // A STATIC import is `from"./<chunk>-hash.js"` / `import"./<chunk>-hash.js"`.
      // The bare filename also appears in Vite's dynamic-import preload manifest
      // (`"assets/<chunk>-hash.js"` inside an array) — that's expected for a lazy
      // chunk and must NOT fail the guard, so match the static-import form only.
      const staticImportRe = new RegExp(`(?:from|import)"\\./${chunk}-[A-Za-z0-9_-]+\\.js"`);
      assert.ok(
        !staticImportRe.test(mainJs),
        `${chunk} must not be statically imported by ${mainFile} (dynamic preload-manifest references are fine)`,
      );
    });
  }
});
