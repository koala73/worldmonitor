import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRO_DIR = resolve(__dirname, '..', 'public', 'pro');
const ASSETS_DIR = resolve(PRO_DIR, 'assets');

// The pro-test build injects this nonce onto its static <link>/<script> tags
// (STATIC_SCRIPT_NONCE in pro-test/vite.config.ts) so the strict CSP admits the
// modulepreload hints.
const STATIC_NONCE = 'wm-static-bootstrap';

// A @sentry/core internal used only inside the SDK. It must live in the split
// sentry chunk and never be copied back into an entry chunk — that's the proof
// manualChunks actually deduplicated Sentry rather than inlining a second copy.
const SENTRY_ONLY_TOKEN = 'getCurrentScope';

function readAsset(name) {
  return readFileSync(resolve(ASSETS_DIR, name), 'utf8');
}

function entryChunksFor(html) {
  // Every hashed entry/vendor chunk the HTML pulls in (modulepreload or script),
  // minus the sentry chunk itself.
  return [...html.matchAll(/assets\/([A-Za-z0-9_-]+\.js)/g)]
    .map((m) => m[1])
    .filter((name, i, arr) => arr.indexOf(name) === i)
    .filter((name) => !/^sentry-/.test(name));
}

describe('pro Sentry chunk split contract (#5019)', () => {
  const sentryChunks = readdirSync(ASSETS_DIR).filter((f) => /^sentry-[A-Za-z0-9_-]+\.js$/.test(f));
  const indexHtml = readFileSync(resolve(PRO_DIR, 'index.html'), 'utf8');
  const welcomeHtml = readFileSync(resolve(PRO_DIR, 'welcome.html'), 'utf8');
  const htmlEntries = [
    ['index.html', indexHtml],
    ['welcome.html', welcomeHtml],
  ];

  it('emits exactly one Sentry chunk', () => {
    assert.equal(sentryChunks.length, 1, `expected exactly one sentry-*.js chunk, found ${sentryChunks.length}: ${sentryChunks.join(', ')}`);
  });

  const [sentryChunk] = sentryChunks;

  it('has the Sentry SDK actually in the split chunk', () => {
    assert.match(
      readAsset(sentryChunk),
      new RegExp(SENTRY_ONLY_TOKEN),
      `${sentryChunk} should contain the Sentry SDK (${SENTRY_ONLY_TOKEN})`,
    );
  });

  for (const [name, html] of htmlEntries) {
    it(`${name} modulepreloads the Sentry chunk with the CSP nonce`, () => {
      const link = html.match(new RegExp(`<link[^>]*\\bhref="/pro/assets/${sentryChunk}"[^>]*>`));
      assert.ok(link, `${name} must modulepreload /pro/assets/${sentryChunk} (keeps Sentry critical-path)`);
      const tag = link[0];
      assert.match(tag, /rel="modulepreload"/, `${name} Sentry preload must be rel="modulepreload"`);
      assert.match(tag, /\bcrossorigin\b/, `${name} Sentry preload must be crossorigin (module fetch)`);
      assert.match(tag, new RegExp(`nonce="${STATIC_NONCE}"`), `${name} Sentry preload must carry the ${STATIC_NONCE} nonce`);
    });

    it(`${name} entry chunks statically import the Sentry chunk`, () => {
      const importers = entryChunksFor(html).filter((chunk) => readAsset(chunk).includes(sentryChunk));
      assert.ok(
        importers.length > 0,
        `at least one ${name} entry chunk must statically import ${sentryChunk} (initSentry runs before render — it stays on the critical path)`,
      );
    });

    it(`${name} does not duplicate Sentry bytes back into its entry chunks`, () => {
      for (const chunk of entryChunksFor(html)) {
        assert.doesNotMatch(
          readAsset(chunk),
          new RegExp(SENTRY_ONLY_TOKEN),
          `${chunk} (referenced by ${name}) must not inline the Sentry SDK — it should import ${sentryChunk} instead`,
        );
      }
    });
  }
});
