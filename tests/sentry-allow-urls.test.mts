import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEBUGBEAR_RUM_HOSTS } from '../src/bootstrap/debugbear-rum.ts';
import { SENTRY_ALLOW_URLS } from '../src/bootstrap/sentry-allow-urls.ts';
import { DEBUGBEAR_RUM_HOSTS as MARKETING_DEBUGBEAR_RUM_HOSTS } from '../pro-test/src/debugbear-rum.ts';
import { SENTRY_ALLOW_URLS as MARKETING_SENTRY_ALLOW_URLS } from '../pro-test/src/sentry-allow-urls.ts';
import { SITE_VARIANTS } from '../src/config/variant.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function read(relPath: string): string {
  return readFileSync(resolve(root, relPath), 'utf8');
}

/**
 * Sentry matches `allowUrls` against a frame's script URL, never a bare
 * hostname — assert on the shape the SDK actually sees.
 */
function scriptUrl(host: string): string {
  return `https://${host}/assets/main-C0ffee12.js`;
}

function admits(allowUrls: RegExp[], host: string): boolean {
  return allowUrls.some((pattern) => pattern.test(scriptUrl(host)));
}

/**
 * The hosts the app is served on, derived from the canonical variant list
 * rather than restated: `full` is the apex (plus `www.`), every other variant
 * is its own subdomain (`src/config/variant.ts`, `vercel.json` host rewrites).
 * Deriving it here is the point of the guard — a new variant added to
 * SITE_VARIANTS fails this test until `allowUrls` learns its subdomain.
 */
const SERVED_HOSTS = [
  'worldmonitor.app',
  'www.worldmonitor.app',
  ...SITE_VARIANTS.filter((variant) => variant !== 'full').map((variant) => `${variant}.worldmonitor.app`),
];

describe('Sentry allowUrls ingest allowlist (#6545)', () => {
  it('admits a script URL from every served variant host', () => {
    assert.ok(SERVED_HOSTS.length >= 7, `expected apex + www + 5 variant subdomains, got ${SERVED_HOSTS.length}`);
    for (const host of SERVED_HOSTS) {
      assert.equal(
        admits(SENTRY_ALLOW_URLS, host),
        true,
        `Sentry drops every browser event from ${host} — add its subdomain to SENTRY_ALLOW_URLS`,
      );
    }
  });

  it('admits every host the DebugBear RUM script loads on', () => {
    assert.ok(DEBUGBEAR_RUM_HOSTS.size > 0, 'DEBUGBEAR_RUM_HOSTS must not be empty');
    for (const host of DEBUGBEAR_RUM_HOSTS) {
      assert.equal(
        admits(SENTRY_ALLOW_URLS, host),
        true,
        `${host} reports web vitals to DebugBear but its Sentry events are dropped — the two lists describe the same population`,
      );
    }
  });

  it('admits Vercel preview deployments', () => {
    assert.equal(admits(SENTRY_ALLOW_URLS, 'worldmonitor-git-codex-preview-eliewm.vercel.app'), true);
  });

  it('rejects lookalike hosts', () => {
    for (const host of ['evilworldmonitor.app', 'notworldmonitor.app', 'example.com']) {
      assert.equal(
        admits(SENTRY_ALLOW_URLS, host),
        false,
        `${host} must not be admitted by the first-party allowlist`,
      );
    }
  });

  it('keeps the marketing allowlist identical to the dashboard allowlist', () => {
    // energy.worldmonitor.app/ rewrites to the marketing /pro/welcome.html
    // (vercel.json), so both bundles run on every variant host and a fix to one
    // copy alone just moves the blind spot.
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

  it('wires the shared allowlist into both Sentry init sites', () => {
    // The behavioural assertions above prove the exported value; these prove the
    // SDK is actually handed it, so an inline array left behind in either init
    // site cannot false-pass this guard.
    for (const relPath of ['src/bootstrap/sentry-init.ts', 'pro-test/src/sentry.ts']) {
      assert.match(
        read(relPath),
        /allowUrls:\s*SENTRY_ALLOW_URLS\b/,
        `${relPath} no longer passes SENTRY_ALLOW_URLS to Sentry.init — the guard tests a value production ignores`,
      );
    }
  });
});
