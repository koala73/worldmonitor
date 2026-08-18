import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';

import { TRUSTED_RETURN_URL_ORIGINS } from '../convex/payments/returnUrlOrigin.ts';
import { DEBUGBEAR_RUM_HOSTS } from '../src/bootstrap/debugbear-rum.ts';
import { SENTRY_ALLOW_URLS } from '../src/bootstrap/sentry-allow-urls.ts';
import { WEB_DASHBOARD_VARIANTS } from '../src/config/variant-dashboard-html.ts';
import { DEBUGBEAR_RUM_HOSTS as MARKETING_DEBUGBEAR_RUM_HOSTS } from '../pro-test/src/debugbear-rum.ts';
import { SENTRY_ALLOW_URLS as MARKETING_SENTRY_ALLOW_URLS } from '../pro-test/src/sentry-allow-urls.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function read(relPath: string): string {
  return readFileSync(resolve(root, relPath), 'utf8');
}

/**
 * Every built `public/pro` chunk reachable from a marketing HTML entry, following
 * module imports transitively. Same walk tests/debugbear-rum.test.mts uses to prove a
 * script reaches the shipped bundle rather than only the source.
 */
function collectReachableProAssets(htmlRelPath: string): Set<string> {
  const entries = [...read(htmlRelPath).matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\/pro\/([^"']+\.js)["']/g)]
    .map((match) => match[1]!);
  const reachable = new Set<string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const asset = queue.shift()!;
    if (reachable.has(asset)) continue;
    reachable.add(asset);
    const source = read(`public/pro/${asset}`);
    for (const match of source.matchAll(/(?:from|import)\(\s*["']\.\/([^"']+\.js)["']\s*\)|from\s*["']\.\/([^"']+\.js)["']/g)) {
      const specifier = match[1] ?? match[2];
      if (specifier) queue.push(`assets/${specifier}`);
    }
  }

  return reachable;
}

/**
 * Sentry matches `allowUrls` against a frame's script URL, never a bare hostname
 * (`_getLastValidUrl` returns `frame.filename`), so assert on that shape.
 */
function scriptUrl(host: string): string {
  return `https://${host}/assets/main-C0ffee12.js`;
}

function admitsUrl(allowUrls: RegExp[], url: string): boolean {
  return allowUrls.some((pattern) => pattern.test(url));
}

function admits(allowUrls: RegExp[], host: string): boolean {
  return admitsUrl(allowUrls, scriptUrl(host));
}

/** Both copies must satisfy every behavioural assertion, not just the dashboard one. */
const ALLOWLISTS: ReadonlyArray<readonly [string, RegExp[]]> = [
  ['src/bootstrap/sentry-allow-urls.ts', SENTRY_ALLOW_URLS],
  ['pro-test/src/sentry-allow-urls.ts', MARKETING_SENTRY_ALLOW_URLS],
];

/**
 * The hosts that serve the app bundle, derived rather than restated.
 *
 * The source of truth is TRUSTED_RETURN_URL_ORIGINS, not SITE_VARIANTS: Vercel
 * serves the deployment on every attached domain, so non-variant hosts like
 * `api.worldmonitor.app` render the real dashboard too. That list already exists
 * because the identical drift broke checkout for 12 signed-in users on the API host
 * (WORLDMONITOR-K7 / -Q4) and is pinned in both directions by
 * tests/checkout-return-url-origin.test.mts.
 */
const SERVED_HOSTS = TRUSTED_RETURN_URL_ORIGINS.map((origin) => new URL(origin).host);

/**
 * Variant subdomains served by the web deployment, so a new variant fails here even
 * if nobody updates the origin list. WEB_DASHBOARD_VARIANTS (not SITE_VARIANTS) is
 * the web-served registry — it excludes desktop-only variants and is itself pinned
 * to vercel.json's /dashboard host rewrites by tests/deploy-config.test.mjs.
 */
const VARIANT_HOSTS = WEB_DASHBOARD_VARIANTS.map((variant) => `${variant}.worldmonitor.app`);

describe('Sentry allowUrls ingest allowlist (#6545)', () => {
  guardProBuiltOutput();
  it('derives a non-empty served-host population', () => {
    // Guards the enumerators themselves: an import that silently resolved to an
    // empty list would make every loop below iterate zero times and pass. Only
    // floors are asserted — comparing a mapped array's length to its source's is
    // self-comparison, since `.map()` cannot change it.
    assert.ok(SERVED_HOSTS.length >= 9, `expected at least 9 app-serving hosts, got ${SERVED_HOSTS.length}`);
    assert.ok(VARIANT_HOSTS.length >= 5, `expected at least 5 web variant hosts, got ${VARIANT_HOSTS.length}`);
  });

  it('admits a script URL from every host that serves the app', () => {
    for (const [label, allowUrls] of ALLOWLISTS) {
      for (const host of SERVED_HOSTS) {
        assert.equal(
          admits(allowUrls, host),
          true,
          `${label}: Sentry drops every exception from ${host} — add its subdomain to SENTRY_ALLOW_URLS`,
        );
      }
    }
  });

  it('admits every variant subdomain, even one absent from the origin list', () => {
    for (const [label, allowUrls] of ALLOWLISTS) {
      for (const host of VARIANT_HOSTS) {
        assert.equal(admits(allowUrls, host), true, `${label}: variant host ${host} is not admitted`);
      }
    }
  });

  it('admits every host the DebugBear RUM script loads on', () => {
    assert.ok(DEBUGBEAR_RUM_HOSTS.size > 0, 'DEBUGBEAR_RUM_HOSTS must not be empty');
    for (const [label, allowUrls] of ALLOWLISTS) {
      for (const host of DEBUGBEAR_RUM_HOSTS) {
        assert.equal(
          admits(allowUrls, host),
          true,
          `${label}: ${host} reports web vitals to DebugBear but its Sentry events are dropped`,
        );
      }
    }
  });

  it('admits Vercel preview deployments and non-default URL shapes', () => {
    for (const [label, allowUrls] of ALLOWLISTS) {
      for (const url of [
        'https://worldmonitor-git-codex-preview-eliewm.vercel.app/assets/main-abc.js',
        'https://worldmonitor.vercel.app/assets/main-abc.js',
        'http://worldmonitor.app/assets/main-abc.js',
        'https://worldmonitor.app:8443/assets/main-abc.js',
        'https://energy.worldmonitor.app',
      ]) {
        assert.equal(admitsUrl(allowUrls, url), true, `${label}: ${url} must be admitted`);
      }
    }
  });

  it('rejects lookalike hosts on both sides of the literal', () => {
    for (const [label, allowUrls] of ALLOWLISTS) {
      // Foreign prefix — the mandatory `https?://` keeps these out.
      for (const host of ['evilworldmonitor.app', 'notworldmonitor.app', 'example.com']) {
        assert.equal(admits(allowUrls, host), false, `${label}: ${host} must not be admitted`);
      }
      // Registrable-domain suffix — rejected only because the pattern is bounded
      // after `worldmonitor.app`. Without that boundary every one of these was
      // admitted, which is why the boundary is load-bearing and not cosmetic.
      for (const host of [
        'worldmonitor.app.evil.com',
        'www.worldmonitor.app.evil.com',
        'energy.worldmonitor.app.evil.com',
        'worldmonitor.appx.io',
        'worldmonitor.apple.com',
      ]) {
        assert.equal(admits(allowUrls, host), false, `${label}: suffix lookalike ${host} must not be admitted`);
      }
      // Vendor CNAMEs serve third-party scripts, not our bundle.
      for (const host of ['clerk.worldmonitor.app', 'abacus.worldmonitor.app']) {
        assert.equal(admits(allowUrls, host), false, `${label}: vendor host ${host} must not be admitted`);
      }
      // Nested URLs — unreachable through scriptUrl(), so asserted directly.
      // The leading `^` is what rejects these.
      for (const url of [
        'https://evil.example/?next=https://worldmonitor.app/x.js',
        'https://evil.example/#https://worldmonitor.app/x.js',
        'https://evil.example/?u=https://worldmonitor-git-x.vercel.app/a.js',
      ]) {
        assert.equal(admitsUrl(allowUrls, url), false, `${label}: nested URL ${url} must not be admitted`);
      }
    }
  });

  it('keeps the marketing allowlist identical to the dashboard allowlist', () => {
    // vercel.json rewrites `/` on every app host to the marketing
    // /pro/welcome.html, so both bundles run on these hosts and fixing one copy
    // alone just moves the blind spot.
    assert.deepEqual(
      MARKETING_SENTRY_ALLOW_URLS.map(String),
      SENTRY_ALLOW_URLS.map(String),
      'pro-test/src/sentry-allow-urls.ts drifted from src/bootstrap/sentry-allow-urls.ts',
    );
    assert.deepEqual(
      [...MARKETING_DEBUGBEAR_RUM_HOSTS].sort(),
      [...DEBUGBEAR_RUM_HOSTS].sort(),
      'pro-test/src/debugbear-rum.ts host set drifted from its dashboard sibling',
    );
  });

  it('ships the current allowlist in the built marketing bundle', { skip: shouldSkipProBuiltOutput() }, () => {
    // public/pro/ is built during the deploy since #6898, so this no longer
    // guards the stale-committed-bytes class it was written for. It still earns
    // its place as a build-integrity check: source parity above proves the
    // patterns are WRITTEN, this proves they SURVIVE bundling into the chunks
    // the entry graph actually reaches (minification, tree-shaking, chunk
    // splitting all sit between the two).
    for (const htmlPath of ['public/pro/index.html', 'public/pro/welcome.html']) {
      const reachable = collectReachableProAssets(htmlPath);
      assert.ok(reachable.size > 0, `${htmlPath} referenced no module chunks`);
      const bundled = [...reachable].map((asset) => read(`public/pro/${asset}`)).join('\n');
      for (const pattern of MARKETING_SENTRY_ALLOW_URLS) {
        assert.ok(
          bundled.includes(pattern.source),
          `${htmlPath} lost ${pattern.source} during bundling — re-run \`npm run build:pro\` and check the Sentry init survives tree-shaking`,
        );
      }
    }
  });

  it('wires the shared allowlist into both Sentry init sites', () => {
    // The behavioural assertions above prove the exported value. These prove the
    // SDK is handed THAT value: the assignment must be the whole property (so a
    // chained `.filter(...)` or a spread cannot narrow it), the identifier must be
    // the shared-module import (so a local shadow cannot satisfy it), and
    // `allowUrls` must appear exactly once (so a later key cannot override it).
    for (const relPath of ['src/bootstrap/sentry-init.ts', 'pro-test/src/sentry.ts']) {
      const src = read(relPath);
      assert.match(
        src,
        /^\s*allowUrls:\s*SENTRY_ALLOW_URLS\s*,\s*(?:\/\/.*)?$/m,
        `${relPath} must pass SENTRY_ALLOW_URLS to Sentry.init unmodified — a chained transform or a commented-out line means the guard tests a value production ignores`,
      );
      assert.match(
        src,
        /import\s*\{[^}]*\bSENTRY_ALLOW_URLS\b[^}]*\}\s*from\s*'\.\/sentry-allow-urls'/,
        `${relPath} must import SENTRY_ALLOW_URLS from the shared module this test asserts on — a local declaration of the same name keeps every other assertion green while production ships a different list`,
      );
      assert.equal(
        (src.match(/\ballowUrls\s*:/g) ?? []).length,
        1,
        `${relPath} must set allowUrls exactly once — a second key or a later spread silently overrides the shared list`,
      );
    }
  });
});
