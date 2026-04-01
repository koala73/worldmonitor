import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extract the shouldSuppressCspViolation function from main.ts source.
// We parse it as a standalone function to avoid importing the entire Sentry/App bootstrap.
const mainSrc = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
const fnMatch = mainSrc.match(/function shouldSuppressCspViolation\(([\s\S]*?)\): boolean \{([\s\S]*?)\nfunction |function shouldSuppressCspViolation\(([\s\S]*?)\): boolean \{([\s\S]*?)\n\}/);
assert.ok(fnMatch, 'shouldSuppressCspViolation must exist in src/main.ts');

// Build a callable version from the source text
const fnBody = (fnMatch[2] ?? fnMatch[4]).trim();
const fnParams = (fnMatch[1] ?? fnMatch[3])
  .split(',')
  .map(p => p.replace(/:.*/s, '').trim())
  .filter(Boolean);
// eslint-disable-next-line no-new-func
const suppress = new Function(...fnParams, fnBody);

describe('CSP violation filter (shouldSuppressCspViolation)', () => {
  describe('disposition gating', () => {
    it('suppresses report-only disposition', () => {
      assert.ok(suppress('report', 'connect-src', 'https://example.com', '', true));
    });

    it('allows enforce disposition', () => {
      assert.ok(!suppress('enforce', 'script-src', 'https://evil.com/inject.js', '', false));
    });

    it('allows empty disposition (browser did not set it)', () => {
      assert.ok(!suppress('', 'script-src', 'https://evil.com/inject.js', '', false));
    });
  });

  describe('connect-src HTTPS suppression (policy-aware)', () => {
    it('suppresses HTTPS connect-src when CSP allows https:', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://api.worldmonitor.app/api/oref-alerts', '', true));
    });

    it('suppresses HTTPS connect-src for tilecache.rainviewer.com', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://tilecache.rainviewer.com/v2/radar/abc/256/4/3/4/6/1_1.png', '', true));
    });

    it('suppresses HTTPS connect-src for Sentry ingest (origin-only)', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://o450.ingest.us.sentry.io', '', true));
    });

    it('suppresses HTTPS connect-src for Sentry ingest (with port and path)', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://o450.ingest.us.sentry.io:443/api/12345/envelope/', '', true));
    });

    it('suppresses HTTPS connect-src for foxnews HLS', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://247preview.foxnews.com/hls/live/stream.m3u8', '', true));
    });

    it('does NOT suppress HTTPS connect-src when CSP does not allow https:', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'https://api.worldmonitor.app/api/oref-alerts', '', false));
    });

    it('does NOT suppress HTTP connect-src even when CSP allows https:', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'http://insecure.example.com/api', '', true));
    });

    it('does NOT suppress non-connect-src HTTPS violations', () => {
      assert.ok(!suppress('enforce', 'script-src', 'https://evil.com/inject.js', '', true));
    });
  });

  describe('extension and injection filters', () => {
    it('suppresses chrome-extension source', () => {
      assert.ok(suppress('enforce', 'script-src', 'https://x.com/a.js', 'chrome-extension://abc/content.js', false));
    });

    it('suppresses moz-extension blocked URI', () => {
      assert.ok(suppress('enforce', 'script-src', 'moz-extension://abc/inject.js', '', false));
    });

    it('suppresses safari-web-extension', () => {
      assert.ok(suppress('enforce', 'script-src', 'safari-web-extension://abc', '', false));
    });
  });

  describe('scheme-only and special values', () => {
    it('suppresses blob (scheme-only)', () => {
      assert.ok(suppress('enforce', 'worker-src', 'blob', '', false));
    });

    it('suppresses blob: URI', () => {
      assert.ok(suppress('enforce', 'worker-src', 'blob:https://www.worldmonitor.app/abc', '', false));
    });

    it('suppresses eval', () => {
      assert.ok(suppress('enforce', 'script-src', 'eval', '', false));
    });

    it('suppresses inline for script-src-elem', () => {
      assert.ok(suppress('enforce', 'script-src-elem', 'inline', '', false));
    });

    it('suppresses inline regardless of directive (eval/inline catch-all)', () => {
      assert.ok(suppress('enforce', 'connect-src', 'inline', '', false));
    });

    it('suppresses data: URI', () => {
      assert.ok(suppress('enforce', 'img-src', 'data:image/png;base64,abc', '', false));
    });

    it('suppresses null blocked URI', () => {
      assert.ok(suppress('enforce', 'frame-src', 'null', '', false));
    });

    it('suppresses android-webview-video-poster', () => {
      assert.ok(suppress('enforce', 'img-src', 'android-webview-video-poster', '', false));
    });
  });

  describe('third-party noise', () => {
    it('suppresses Google Translate', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://translate.gstatic.com/_/translate_http', '', false));
    });

    it('suppresses Facebook Pixel', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://connect.facebook.net/en_US/fbevents.js', '', false));
    });

    it('suppresses googlevideo (YouTube embeds)', () => {
      assert.ok(suppress('enforce', 'media-src', 'https://rr1---sn-abc.googlevideo.com/videoplayback', '', false));
    });

    it('suppresses securly (school filter)', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://api.securly.com/v1/track', '', false));
    });

    it('suppresses manifest.webmanifest', () => {
      assert.ok(suppress('enforce', 'default-src', 'https://www.worldmonitor.app/manifest.webmanifest', '', false));
    });
  });

  describe('real violations pass through', () => {
    it('reports third-party script-src violation', () => {
      assert.ok(!suppress('enforce', 'script-src', 'https://evil.com/crypto-miner.js', '', true));
    });

    it('reports unknown frame-src violation', () => {
      assert.ok(!suppress('enforce', 'frame-src', 'https://malicious-iframe.com/phish', '', false));
    });

    it('reports HTTP connect-src even with https: allowed', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'http://insecure-api.com/leak', '', true));
    });

    it('reports ws: connect-src violation', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'ws://insecure-ws.com/socket', '', true));
    });
  });
});
