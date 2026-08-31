/**
 * #7437: Classify must read the digest from the install it belongs to.
 *
 * seedClassifyForVariant used to hardcode the production API host and
 * https.get, so a self-hosted relay asked production (non-200, swallowed)
 * and an in-network http:// API_BASE_URL threw. The request builder lives
 * in scripts/lib so these cases execute without importing the boot-on-require
 * relay — same reason as digest-stale-gate.cjs.
 *
 * Run: node --test tests/classify-digest-request.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const {
  DEFAULT_CLASSIFY_API_HOST,
  DEFAULT_CLASSIFY_API_BASE,
  resolveClassifyApiBase,
  buildClassifyDigestUrl,
  classifyDigestTransport,
  buildClassifyDigestHeaders,
  formatClassifyDigestFetchFailure,
  shouldWriteClassifySeedMeta,
} = require('../scripts/lib/classify-digest-request.cjs');

const relaySrc = readFileSync(resolve(__dirname, '..', 'scripts', 'ais-relay.cjs'), 'utf8');
const dockerfileSrc = readFileSync(resolve(__dirname, '..', 'Dockerfile.relay'), 'utf8');

function classifyFnSrc() {
  const start = relaySrc.indexOf('async function seedClassifyForVariant');
  const end = relaySrc.indexOf('\nasync function seedClassify()', start);
  assert.ok(start >= 0 && end > start, 'seedClassifyForVariant not found');
  return relaySrc.slice(start, end);
}

describe('classify digest request builder (#7437)', () => {
  it('defaults to the production API host when API_BASE_URL is unset', () => {
    assert.equal(DEFAULT_CLASSIFY_API_HOST, 'api.worldmonitor.app');
    assert.equal(DEFAULT_CLASSIFY_API_BASE, `https://${DEFAULT_CLASSIFY_API_HOST}`);
    assert.equal(resolveClassifyApiBase({}), DEFAULT_CLASSIFY_API_BASE);
    assert.equal(resolveClassifyApiBase({ API_BASE_URL: '   ' }), DEFAULT_CLASSIFY_API_BASE);
    assert.equal(
      buildClassifyDigestUrl('full', {}),
      `${DEFAULT_CLASSIFY_API_BASE}/api/news/v1/list-feed-digest?variant=full&lang=en`,
    );
  });

  it('honors API_BASE_URL, including an in-network http base with a trailing slash', () => {
    const env = { API_BASE_URL: 'http://worldmonitor:8080/' };
    assert.equal(resolveClassifyApiBase(env), 'http://worldmonitor:8080');
    assert.equal(
      buildClassifyDigestUrl('tech', env),
      'http://worldmonitor:8080/api/news/v1/list-feed-digest?variant=tech&lang=en',
    );
    assert.equal(classifyDigestTransport(buildClassifyDigestUrl('tech', env)), 'http');
  });

  it('selects https for the production default and encodes the variant', () => {
    const url = buildClassifyDigestUrl('happy go', { API_BASE_URL: 'https://api.example.test' });
    assert.equal(
      url,
      'https://api.example.test/api/news/v1/list-feed-digest?variant=happy%20go&lang=en',
    );
    assert.equal(classifyDigestTransport(url), 'https');
  });

  it('sends X-WorldMonitor-Key only when WORLDMONITOR_RELAY_KEY is set', () => {
    assert.deepEqual(
      buildClassifyDigestHeaders({ userAgent: 'WM-Test/1', relayKey: '' }),
      { Accept: 'application/json', 'User-Agent': 'WM-Test/1' },
    );
    assert.deepEqual(
      buildClassifyDigestHeaders({ userAgent: 'WM-Test/1', relayKey: 'relay-secret' }),
      {
        Accept: 'application/json',
        'User-Agent': 'WM-Test/1',
        'X-WorldMonitor-Key': 'relay-secret',
      },
    );
  });

  it('names the HTTP status so a failed digest fetch is not silent zeros', () => {
    assert.match(
      formatClassifyDigestFetchFailure(401, ''),
      /HTTP 401.*WORLDMONITOR_RELAY_KEY not set/,
    );
    assert.match(
      formatClassifyDigestFetchFailure(403, ''),
      /HTTP 403.*WORLDMONITOR_RELAY_KEY not set/,
    );
    assert.equal(
      formatClassifyDigestFetchFailure(502, ''),
      '[Classify] digest fetch failed: HTTP 502',
    );
    assert.equal(
      formatClassifyDigestFetchFailure(403, 'set'),
      '[Classify] digest fetch failed: HTTP 403',
    );
  });

  it('withholds seed-meta after an all-variant digest fetch failure', () => {
    assert.equal(shouldWriteClassifySeedMeta({ fetchOk: 0, fetchFailed: 5 }), false);
    assert.equal(shouldWriteClassifySeedMeta({ fetchOk: 1, fetchFailed: 4 }), true);
    assert.equal(shouldWriteClassifySeedMeta({ fetchOk: 0, fetchFailed: 0 }), true);
  });
});

describe('ais-relay Classify wiring (#7437)', () => {
  it('builds the digest request from the executable helper, not a hardcoded host', () => {
    const classifyFn = classifyFnSrc();
    assert.match(classifyFn, /buildClassifyDigestUrl\(variant\)/);
    assert.match(classifyFn, /classifyDigestTransport\(digestUrl\)/);
    assert.match(classifyFn, /buildClassifyDigestHeaders\(/);
    assert.doesNotMatch(classifyFn, /list-feed-digest\?variant=/);
    assert.doesNotMatch(classifyFn, /https\.get\(digestUrl/);
  });

  it('logs non-200 digest status and fetch errors instead of returning zeros silently', () => {
    const classifyFn = classifyFnSrc();
    assert.match(classifyFn, /formatClassifyDigestFetchFailure\(/);
    assert.match(classifyFn, /\[Classify\] digest fetch error:/);
    assert.match(classifyFn, /fetchFailed:\s*true/);
    assert.match(relaySrc, /shouldWriteClassifySeedMeta\(\{ fetchOk, fetchFailed \}\)/);
  });

  it('copies the helper into the relay image next to digest-stale-gate.cjs', () => {
    assert.match(
      dockerfileSrc,
      /COPY scripts\/lib\/classify-digest-request\.cjs \.\/scripts\/lib\/classify-digest-request\.cjs/,
    );
  });
});
