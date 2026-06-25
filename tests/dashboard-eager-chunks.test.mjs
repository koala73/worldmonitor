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
const DEFERRED_TABLE_CHUNKS = ['tech-geo-data', 'airports-data', 'ai-datacenters-data', 'geo-map-data'];
const DEFERRED_SENTRY_CHUNKS = ['sentry-init', 'sentry'];
// agent-bus-applier + shared/agent-bus-actions pull in zod (~69KB raw). They are
// only reachable through the lazy chat-analyst panel's action handler, so they
// must ship in the chat-analyst graph (agent-bus-actions chunk), NOT eager main.
// Re-adding a static `import { applyAgentBusAction }` to panel-layout would inline
// the subtree (and zod) into main — collapsing this chunk and failing the guard.
const DEFERRED_AGENT_BUS_CHUNKS = ['agent-bus-actions'];
// npm libs only needed by opt-in/non-boot features, lazy-loaded off the eager entry:
//   satellite.es  — satellite.js, loaded by the satellite layer (ensureSatelliteLib)
//   confetti.module — canvas-confetti, loaded on the first milestone celebration
// Re-adding a static `import` of either would re-eagerise it into main and fail this.
const DEFERRED_NPM_LIB_CHUNKS = ['satellite.es', 'confetti.module'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadDashboardBuild() {
  const html = readFileSync(dashboardHtml, 'utf-8');
  const assetsDir = resolve(distDir, 'assets');
  const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const mainFile = assets.find((f) => /^main-[A-Za-z0-9_-]+\.js$/.test(f));
  const mainJs = mainFile ? readFileSync(resolve(assetsDir, mainFile), 'utf-8') : '';
  const modulepreloadHrefs = [...html.matchAll(/<link\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\brel=["']modulepreload["']/.test(tag))
    .map((tag) => tag.match(/\bhref=["']([^"']+)["']/)?.[1])
    .filter(Boolean);
  return { html, assets, mainFile, mainJs, modulepreloadHrefs };
}

function hasModulepreloadForChunk(modulepreloadHrefs, chunk) {
  const escaped = escapeRegExp(chunk);
  const hrefRe = new RegExp(`(?:^|/)assets/${escaped}-[A-Za-z0-9_-]+\\.js$`);
  return modulepreloadHrefs.some((href) => hrefRe.test(href));
}

function registerDeferredChunkAssertions(chunks, options) {
  const { assets, mainFile, mainJs, modulepreloadHrefs } = loadDashboardBuild();

  for (const chunk of chunks) {
    const escaped = escapeRegExp(chunk);

    it(`${chunk}: built as its own isolated chunk`, () => {
      assert.ok(
        assets.some((f) => f.startsWith(`${chunk}-`) && f.endsWith('.js')),
        options.missingMessage(chunk),
      );
    });

    it(`${chunk}: absent from dashboard.html modulepreload`, () => {
      assert.ok(
        !hasModulepreloadForChunk(modulepreloadHrefs, chunk),
        options.preloadMessage(chunk),
      );
    });

    it(`${chunk}: not statically imported by the main entry chunk`, () => {
      assert.ok(mainFile, 'main-*.js entry chunk should exist in dist/assets');
      const staticImportRe = new RegExp(`(?:from|import)"\\./${escaped}-[A-Za-z0-9_-]+\\.js"`);
      assert.ok(
        !staticImportRe.test(mainJs),
        `${chunk} must not be statically imported by ${mainFile} (dynamic preload-manifest references are fine)`,
      );
    });
  }
}

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

describe('eager chunk budget: Sentry stays behind the deferred scheduler', { skip: !existsSync(dashboardHtml) }, () => {
  const html = readFileSync(dashboardHtml, 'utf-8');
  const assetsDir = resolve(distDir, 'assets');
  const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const mainFile = assets.find((f) => /^main-[A-Za-z0-9_-]+\.js$/.test(f));
  const mainJs = mainFile ? readFileSync(resolve(assetsDir, mainFile), 'utf-8') : '';

  for (const chunk of DEFERRED_SENTRY_CHUNKS) {
    it(`${chunk}: built as its own isolated chunk`, () => {
      assert.ok(
        assets.some((f) => f.startsWith(`${chunk}-`) && f.endsWith('.js')),
        `${chunk}-*.js chunk should exist (manualChunks rule present)`,
      );
    });

    it(`${chunk}: absent from dashboard.html modulepreload`, () => {
      const modulepreloadRe = new RegExp(`<link\\b[^>]+rel=["']modulepreload["'][^>]+href=["']/assets/${chunk}-[A-Za-z0-9_-]+\\.js["']`);
      assert.ok(
        !modulepreloadRe.test(html),
        `${chunk} must not be eagerly modulepreloaded in dashboard.html — Sentry must load through the deferred scheduler`,
      );
    });

    it(`${chunk}: not statically imported by the main entry chunk`, () => {
      assert.ok(mainFile, 'main-*.js entry chunk should exist in dist/assets');
      const staticImportRe = new RegExp(`(?:from|import)"\\./${chunk}-[A-Za-z0-9_-]+\\.js"`);
      assert.ok(
        !staticImportRe.test(mainJs),
        `${chunk} must not be statically imported by ${mainFile} (dynamic preload-manifest references are fine)`,
      );
    });
  }
});

describe('eager chunk budget: opt-in npm libs stay off the entry', { skip: !existsSync(dashboardHtml) }, () => {
  registerDeferredChunkAssertions(DEFERRED_NPM_LIB_CHUNKS, {
    missingMessage: (chunk) => `${chunk}-*.js chunk should exist — if missing, the lib was inlined into another chunk by a static import`,
    preloadMessage: (chunk) => `${chunk} must not be eagerly modulepreloaded — it loads on demand`,
  });
});

describe('eager chunk budget: agent-bus + zod stay behind the lazy chat-analyst panel', { skip: !existsSync(dashboardHtml) }, () => {
  registerDeferredChunkAssertions(DEFERRED_AGENT_BUS_CHUNKS, {
    missingMessage: (chunk) => `${chunk}-*.js chunk should exist — if it was inlined into main, a static import re-eagerised agent-bus-applier (and zod)`,
    preloadMessage: (chunk) => `${chunk} must not be eagerly modulepreloaded — agent-bus loads through the lazy chat-analyst panel`,
  });
});
