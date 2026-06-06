import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dirname, '..', 'scripts');
const bundlePath = join(scriptsDir, 'seed-bundle-regional.mjs');
const bundleSource = readFileSync(bundlePath, 'utf8');

// ── Source assertions (cheap regression guards on the bypass wiring) ──
describe('seed-bundle-regional briefs cooldown — source', () => {
  it('bypasses the cooldown when the last run failed coverage (recordCount=0)', () => {
    assert.ok(
      bundleSource.includes('recordCount'),
      'shouldRunBriefs must reference recordCount to check coverage status',
    );
  });

  it('reads the bypass signal from the bare-shape seed-meta key', () => {
    assert.ok(
      bundleSource.includes("'seed-meta:intelligence:regional-briefs'"),
      'BRIEF_META_KEY must point at the bare-shape seed-meta key (where recordCount lives)',
    );
  });

  it('keeps the normal cooldown skip below the coverage-fail bypass', () => {
    const bypassIdx = bundleSource.indexOf('bypassing cooldown to retry');
    const skipIdx = bundleSource.indexOf('skipping (cooldown');
    assert.ok(bypassIdx >= 0, 'missing coverage-fail bypass branch');
    assert.ok(skipIdx >= 0, 'missing normal cooldown skip branch');
    assert.ok(
      bypassIdx < skipIdx,
      'the recordCount=0 bypass must be evaluated BEFORE the cooldown skip returns false',
    );
  });
});

// ── Behavioral assertions (run shouldRunBriefs against a stubbed Redis) ──
describe('seed-bundle-regional shouldRunBriefs — behavior', () => {
  let shouldRunBriefs;
  let BRIEF_COOLDOWN_MS;
  const realFetch = global.fetch;
  const realEnv = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };

  // Stub Redis GET /get/<key> → returns whatever `nextMeta` is set to,
  // wrapped in the Upstash `{ result }` envelope. The seed-meta is bare
  // shape `{ fetchedAt, recordCount }` (NOT enveloped), matching writeSeedMeta.
  let nextMeta = null;
  function stubFetch(meta) {
    nextMeta = meta;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ result: nextMeta === null ? null : JSON.stringify(nextMeta) }),
    });
  }

  before(async () => {
    // Set fake creds BEFORE import so getRedisCredentials() doesn't exit and
    // loadEnvFile (which only fills unset vars) doesn't pull real creds.
    process.env.UPSTASH_REDIS_REST_URL = 'http://stub.local';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
    const mod = await import('../scripts/seed-bundle-regional.mjs');
    shouldRunBriefs = mod.shouldRunBriefs;
    BRIEF_COOLDOWN_MS = mod.BRIEF_COOLDOWN_MS;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  after(() => {
    if (realEnv.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = realEnv.url;
    if (realEnv.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = realEnv.token;
  });

  it('runs when the meta key is missing (first run)', async () => {
    stubFetch(null);
    assert.equal(await shouldRunBriefs(), true);
  });

  it('runs when the last run is older than the cooldown', async () => {
    stubFetch({ fetchedAt: Date.now() - (BRIEF_COOLDOWN_MS + 60_000), recordCount: 6 });
    assert.equal(await shouldRunBriefs(), true);
  });

  it('skips when a fresh, successful run is within the cooldown', async () => {
    stubFetch({ fetchedAt: Date.now() - 60_000, recordCount: 6 });
    assert.equal(await shouldRunBriefs(), false);
  });

  it('bypasses the cooldown to retry when a fresh run failed coverage (recordCount=0)', async () => {
    // This is the self-healing path: a transient OpenRouter-credits outage
    // wrote recordCount=0 within the cooldown window; without the bypass the
    // EMPTY_DATA crit would persist for ~5 more days.
    stubFetch({ fetchedAt: Date.now() - 60_000, recordCount: 0 });
    assert.equal(await shouldRunBriefs(), true);
  });

  it('treats a missing recordCount within cooldown as a coverage fail and retries', async () => {
    stubFetch({ fetchedAt: Date.now() - 60_000 });
    assert.equal(await shouldRunBriefs(), true);
  });

  it('runs defensively when Redis returns a non-ok response', async () => {
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    assert.equal(await shouldRunBriefs(), true);
  });
});
