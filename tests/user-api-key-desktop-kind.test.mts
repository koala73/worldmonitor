/**
 * Plan 2026-10-25-001 U3 — validators fail closed on key kind (KTD3, KTD8).
 *
 * Both `wm_` validators share the Redis entry `user-api-key:<hash>`:
 *   - server/_shared/user-api-key.ts (gateway, premium-check, MCP, v2 webhooks)
 *   - api/_user-api-key.js (bootstrap, OAuth, telegram-feed)
 *
 * Every producer now writes one shape, `{ v, userId, keyId, name, keyKind,
 * scopes?, companyMonitoringAccountId? }`. The generic validators accept only
 * `keyKind === 'api'`. An entry without the current version field, or with a
 * missing/unknown kind, is never trusted and never turned into a 401 — it is
 * re-validated at Convex and rewritten — so API customers see no 401 window
 * across the deploy. The desktop-aware variants return the principal with its
 * kind and hash for U4 (gateway, premium-check, bootstrap).
 *
 * The harness is HTTP-level (stubbed `fetch`) so the two modules exercise their
 * real Redis and Convex clients and genuinely share one cache map.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  UserApiKeyUnavailableError,
  invalidateApiKeyCache,
  validateUserApiKey,
  validateUserApiKeyPrincipal,
} from '../server/_shared/user-api-key.ts';
import {
  __clearLocalUnavailableBackoffForTests,
  __resetKeyPrefixCacheForTests,
} from '../server/_shared/redis.ts';
import {
  resolveBootstrapUserKeyAccess,
  validateBootstrapDesktopKeyAccess,
  validateBootstrapUserApiAccess,
  validateBootstrapUserApiKey,
  validateBootstrapUserApiKeyPrincipal,
  validateUserApiKeyHash,
} from '../api/_user-api-key.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_PREFIX = 'user-api-key:';
const NEG_SENTINEL = '__WM_NEG__';

type ConvexAnswer = unknown | { status: number; body?: unknown } | Error;

interface Harness {
  redis: Map<string, string>;
  validateCalls: number;
  entitlementCalls: number;
  deletes: string[];
  gets: string[];
  validateQueue: ConvexAnswer[];
  entitlementQueue: ConvexAnswer[];
}

const ENV_KEYS = [
  'CONVEX_SITE_URL',
  'CONVEX_SERVER_SHARED_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_SHA',
  'LOCAL_API_MODE',
  'DODO_PAYMENTS_ENVIRONMENT',
] as const;
const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

let harness: Harness;
let keySeq = 0;

function uniqueKey(): string {
  keySeq += 1;
  return `wm_${keySeq.toString(16).padStart(40, '0')}`;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function isHttpAnswer(answer: unknown): answer is { status: number; body?: unknown } {
  return typeof answer === 'object' && answer !== null && 'status' in answer && typeof (answer as { status: unknown }).status === 'number'
    && !('userId' in answer);
}

function answer(queue: ConvexAnswer[], label: string): Response {
  if (queue.length === 0) throw new Error(`Unexpected Convex ${label} request`);
  const next = queue.shift();
  if (next instanceof Error) throw next;
  if (isHttpAnswer(next)) return json(next.body ?? { error: 'upstream' }, next.status);
  return json(next);
}

function runCommand(command: unknown[]): { result: unknown } {
  const [verb, key, ...rest] = command as [string, string, ...string[]];
  switch (verb.toUpperCase()) {
    case 'GET':
      harness.gets.push(key);
      return { result: harness.redis.get(key) ?? null };
    case 'SET':
      harness.redis.set(key, String(rest[0]));
      return { result: 'OK' };
    case 'DEL':
      harness.deletes.push(key);
      return { result: harness.redis.delete(key) ? 1 : 0 };
    default:
      throw new Error(`Unexpected Redis command ${verb}`);
  }
}

function installHarness(): Harness {
  harness = {
    redis: new Map(),
    validateCalls: 0,
    entitlementCalls: 0,
    deletes: [],
    gets: [],
    validateQueue: [],
    entitlementQueue: [],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';

    if (url.startsWith('https://redis.test/get/')) {
      return json(runCommand(['GET', decodeURIComponent(url.slice('https://redis.test/get/'.length))]));
    }
    if (url.startsWith('https://redis.test/del/')) {
      return json(runCommand(['DEL', decodeURIComponent(url.slice('https://redis.test/del/'.length))]));
    }
    if (url === 'https://redis.test/') {
      return json(runCommand(JSON.parse(body) as unknown[]));
    }
    if (url === 'https://redis.test/pipeline') {
      const commands = JSON.parse(body) as unknown[][];
      return json(commands.map((command) => runCommand(command)));
    }
    if (url === 'https://convex.test/api/internal-validate-api-key') {
      harness.validateCalls += 1;
      assert.equal((init?.headers as Record<string, string>)['x-convex-shared-secret'], 'shared-secret');
      return answer(harness.validateQueue, 'validate');
    }
    if (url === 'https://convex.test/api/internal-entitlements') {
      harness.entitlementCalls += 1;
      return answer(harness.entitlementQueue, 'entitlements');
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
  return harness;
}

function cached(keyHash: string): unknown {
  const raw = harness.redis.get(`${CACHE_PREFIX}${keyHash}`);
  return raw === undefined ? undefined : JSON.parse(raw);
}

function seed(keyHash: string, value: unknown): void {
  harness.redis.set(`${CACHE_PREFIX}${keyHash}`, JSON.stringify(value));
}

function convexRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'key_1', userId: 'user_owner', name: 'laptop', keyKind: 'api', ...overrides };
}

function proEntitlement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planKey: 'pro_monthly',
    validUntil: Date.now() + 86_400_000,
    features: { tier: 1, apiAccess: false, desktopKeyAccess: true, maxDesktopKeys: 2 },
    ...overrides,
  };
}

beforeEach(() => {
  for (const name of ENV_KEYS) originalEnv.set(name, process.env[name]);
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'shared-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.LOCAL_API_MODE;
  __resetKeyPrefixCacheForTests();
  __clearLocalUnavailableBackoffForTests();
  console.warn = () => {};
  installHarness();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  for (const name of ENV_KEYS) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetKeyPrefixCacheForTests();
  __clearLocalUnavailableBackoffForTests();
});

describe('cache contract shared by both producers', () => {
  it('pins one cache version constant across the TypeScript and JavaScript validators', () => {
    const extract = (file: string) => {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      const match = src.match(/USER_API_KEY_CACHE_VERSION\s*=\s*(\d+)\s*;/);
      assert.ok(match, `USER_API_KEY_CACHE_VERSION not found in ${file}`);
      return match[1];
    };
    assert.equal(extract('server/_shared/user-api-key.ts'), extract('api/_user-api-key.js'));
  });

  it('both producers write the same shape, with keyId always set', async () => {
    const tsKey = uniqueKey();
    const jsKey = uniqueKey();
    harness.validateQueue.push(convexRow({ id: 'key_ts' }), convexRow({ id: 'key_js' }));

    const ts = await validateUserApiKey(tsKey);
    assert.ok(ts);
    assert.equal(ts.keyId, 'key_ts');
    const js = await validateBootstrapUserApiKey(jsKey);
    assert.deepEqual(js, { ok: true, userId: 'user_owner' });

    const tsEntry = cached(await sha256Hex(tsKey)) as Record<string, unknown>;
    const jsEntry = cached(await sha256Hex(jsKey)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(tsEntry).sort(), Object.keys(jsEntry).sort());
    assert.deepEqual(tsEntry, { v: tsEntry.v, userId: 'user_owner', keyId: 'key_ts', name: 'laptop', keyKind: 'api' });
    assert.deepEqual(jsEntry, { v: jsEntry.v, userId: 'user_owner', keyId: 'key_js', name: 'laptop', keyKind: 'api' });
    assert.equal(typeof tsEntry.v, 'number');
    assert.equal(tsEntry.v, jsEntry.v);
  });

  it('a warm current entry costs the TypeScript validator one Redis read', async () => {
    const key = uniqueKey();
    harness.validateQueue.push(convexRow());
    assert.ok(await validateUserApiKeyPrincipal(key));
    const entryKey = `${CACHE_PREFIX}${await sha256Hex(key)}`;
    harness.gets = [];

    assert.ok(await validateUserApiKeyPrincipal(key));
    assert.equal(harness.validateCalls, 1);
    assert.deepEqual(harness.gets.filter((k) => k.endsWith(entryKey)), [entryKey]);
  });

  it('keyId is set whichever producer filled the cache', async () => {
    const key = uniqueKey();
    const keyHash = await sha256Hex(key);
    harness.validateQueue.push(convexRow({ id: 'key_from_js' }));
    await validateBootstrapUserApiKey(key);
    const viaTs = await validateUserApiKey(key);
    assert.equal(viaTs?.keyId, 'key_from_js');
    assert.equal(harness.validateCalls, 1);

    const other = uniqueKey();
    harness.validateQueue.push(convexRow({ id: 'key_from_ts' }));
    await validateUserApiKey(other);
    const viaJs = await validateBootstrapUserApiKeyPrincipal(other);
    assert.equal(viaJs.ok, true);
    assert.equal(viaJs.ok && viaJs.keyId, 'key_from_ts');
    assert.equal(harness.validateCalls, 2);
    assert.equal(typeof cached(keyHash), 'object');
  });
});

describe('activeKeyRank rides the shared entry (KTD5)', () => {
  it('both producers carry a Convex rank through the entry and the principal, same version', async () => {
    const viaTs = uniqueKey();
    harness.validateQueue.push(convexRow({ id: 'key_r1', activeKeyRank: 2 }));
    assert.equal((await validateUserApiKeyPrincipal(viaTs))?.activeKeyRank, 2);
    const tsEntry = cached(await sha256Hex(viaTs)) as Record<string, unknown>;
    assert.equal(tsEntry.activeKeyRank, 2);
    assert.equal(tsEntry.v, 2, 'an optional field does not bump the entry version');
    // The other producer reads the same entry warm.
    const viaJsWarm = await validateBootstrapUserApiKeyPrincipal(viaTs);
    assert.equal(viaJsWarm.ok && viaJsWarm.activeKeyRank, 2);

    const viaJs = uniqueKey();
    harness.validateQueue.push(convexRow({ id: 'key_r2', activeKeyRank: 0 }));
    const js = await validateBootstrapUserApiKeyPrincipal(viaJs);
    assert.equal(js.ok && js.activeKeyRank, 0);
    assert.equal((cached(await sha256Hex(viaJs)) as Record<string, unknown>).activeKeyRank, 0);
    assert.equal((await validateUserApiKeyPrincipal(viaJs))?.activeKeyRank, 0);
    assert.equal(harness.validateCalls, 2);
  });

  it('a malformed rank from Convex is dropped, not trusted, and the key still validates', async () => {
    for (const bad of [-1, 1.5, '2', null]) {
      const key = uniqueKey();
      harness.validateQueue.push(convexRow({ id: 'key_bad', activeKeyRank: bad }));
      const principal = await validateUserApiKeyPrincipal(key);
      assert.ok(principal, String(bad));
      assert.equal('activeKeyRank' in principal, false, String(bad));
    }
  });

  it('a current entry poisoned with a malformed rank is re-validated, never trusted', async () => {
    const key = uniqueKey();
    const keyHash = await sha256Hex(key);
    harness.redis.set(`${CACHE_PREFIX}${keyHash}`, JSON.stringify({ v: 2, userId: 'user_owner', keyId: 'k', keyKind: 'api', activeKeyRank: 'zero' }));
    harness.validateQueue.push(convexRow({ id: 'key_fresh', activeKeyRank: 1 }));
    assert.equal((await validateUserApiKeyPrincipal(key))?.activeKeyRank, 1);
    assert.equal(harness.validateCalls, 1);
  });
});

describe('generic validators reject desktop keys (AE2)', () => {
  it('TypeScript validator rejects a desktop key from cold and caches the full entry', async () => {
    const key = uniqueKey();
    harness.validateQueue.push(convexRow({ keyKind: 'desktop' }));
    assert.equal(await validateUserApiKey(key), null);
    assert.equal(harness.validateCalls, 1);
    const entry = cached(await sha256Hex(key)) as Record<string, unknown>;
    assert.equal(entry.keyKind, 'desktop');
    assert.equal(entry.keyId, 'key_1');

    // Warm: still rejected, and no second Convex call (the entry is current).
    assert.equal(await validateUserApiKey(key), null);
    assert.equal(harness.validateCalls, 1);
  });

  it('JavaScript validator rejects a desktop key from cold and warm', async () => {
    const key = uniqueKey();
    harness.validateQueue.push(convexRow({ keyKind: 'desktop' }));
    assert.deepEqual(await validateBootstrapUserApiKey(key), {
      ok: false, status: 401, error: 'Invalid API key', reason: 'invalid',
    });
    assert.equal(harness.validateCalls, 1);
    assert.deepEqual(await validateBootstrapUserApiKey(key), {
      ok: false, status: 401, error: 'Invalid API key', reason: 'invalid',
    });
    assert.equal(harness.validateCalls, 1);
    // The desktop entry must not be negative-cached: U4's desktop-aware path reads it.
    assert.notEqual(cached(await sha256Hex(key)), NEG_SENTINEL);
  });

  it('OAuth hash validator rejects a desktop key', async () => {
    const key = uniqueKey();
    harness.validateQueue.push(convexRow({ keyKind: 'desktop' }));
    const result = await validateUserApiKeyHash(await sha256Hex(key));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 401);
  });

  it('generic validators reject a desktop entry written by the desktop-aware TypeScript variant', async () => {
    const key = uniqueKey();
    harness.validateQueue.push(convexRow({ keyKind: 'desktop' }));
    const principal = await validateUserApiKeyPrincipal(key);
    assert.equal(principal?.keyKind, 'desktop');
    assert.equal(harness.validateCalls, 1);

    assert.equal(await validateUserApiKey(key), null);
    const js = await validateBootstrapUserApiKey(key);
    assert.equal(js.ok, false);
    assert.equal(!js.ok && js.status, 401);
    assert.equal(harness.validateCalls, 1, 'desktop entry is current: no re-fetch');
  });

  it('generic validators reject a desktop entry written by the desktop-aware JavaScript variant', async () => {
    const key = uniqueKey();
    harness.validateQueue.push(convexRow({ keyKind: 'desktop' }));
    const principal = await validateBootstrapUserApiKeyPrincipal(key);
    assert.equal(principal.ok, true);
    assert.equal(principal.ok && principal.keyKind, 'desktop');

    assert.equal(await validateUserApiKey(key), null);
    const js = await validateBootstrapUserApiKey(key);
    assert.equal(js.ok, false);
    assert.equal(harness.validateCalls, 1);
  });
});

describe('missing or unknown keyKind is re-validated, never granted from the cache', () => {
  for (const [label, kind] of [['missing', undefined], ['unknown', 'enterprise']] as const) {
    it(`${label} keyKind in a versioned entry: TypeScript re-fetches, denies a desktop answer`, async () => {
      const key = uniqueKey();
      const keyHash = await sha256Hex(key);
      seed(keyHash, { v: 2, userId: 'user_owner', keyId: 'key_1', name: 'laptop', ...(kind === undefined ? {} : { keyKind: kind }) });
      harness.validateQueue.push(convexRow({ keyKind: 'desktop' }));
      assert.equal(await validateUserApiKey(key), null);
      assert.equal(harness.validateCalls, 1, 'entry must not be trusted: Convex consulted');
      assert.equal((cached(keyHash) as Record<string, unknown>).keyKind, 'desktop');
    });

    it(`${label} keyKind in a versioned entry: TypeScript re-fetches, grants an api answer`, async () => {
      const key = uniqueKey();
      const keyHash = await sha256Hex(key);
      seed(keyHash, { v: 2, userId: 'user_owner', keyId: 'key_1', name: 'laptop', ...(kind === undefined ? {} : { keyKind: kind }) });
      harness.validateQueue.push(convexRow());
      const result = await validateUserApiKey(key);
      assert.equal(result?.userId, 'user_owner');
      assert.equal(harness.validateCalls, 1);
      assert.equal((cached(keyHash) as Record<string, unknown>).keyKind, 'api');
    });

    it(`${label} keyKind in a versioned entry: JavaScript re-fetches, denies a desktop answer`, async () => {
      const key = uniqueKey();
      seed(await sha256Hex(key), { v: 2, userId: 'user_owner', keyId: 'key_1', ...(kind === undefined ? {} : { keyKind: kind }) });
      harness.validateQueue.push(convexRow({ keyKind: 'desktop' }));
      const result = await validateBootstrapUserApiKey(key);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.status, 401);
      assert.equal(harness.validateCalls, 1);
    });

    it(`${label} keyKind in a versioned entry: JavaScript re-fetches, grants an api answer`, async () => {
      const key = uniqueKey();
      seed(await sha256Hex(key), { v: 2, userId: 'user_owner', keyId: 'key_1', ...(kind === undefined ? {} : { keyKind: kind }) });
      harness.validateQueue.push(convexRow());
      assert.deepEqual(await validateBootstrapUserApiKey(key), { ok: true, userId: 'user_owner' });
      assert.equal(harness.validateCalls, 1);
    });
  }

  it('an unknown keyKind from Convex itself is never granted by either validator', async () => {
    const tsKey = uniqueKey();
    harness.validateQueue.push(convexRow({ keyKind: 'enterprise' }));
    await assert.rejects(validateUserApiKey(tsKey), UserApiKeyUnavailableError);
    assert.equal(cached(await sha256Hex(tsKey)), undefined, 'contract drift is not cached');

    const jsKey = uniqueKey();
    harness.validateQueue.push(convexRow({ keyKind: 'enterprise' }));
    const js = await validateBootstrapUserApiKey(jsKey);
    assert.equal(js.ok, false);
    assert.notEqual(!js.ok && js.status, 200);
    assert.equal(cached(await sha256Hex(jsKey)), undefined);

    const principal = await validateUserApiKeyPrincipal(uniqueKey()).catch((err: unknown) => err);
    // Queue is empty: the variant hits the stubbed Convex and gets "Unexpected request" → unavailable.
    assert.ok(principal instanceof UserApiKeyUnavailableError);
  });
});

describe('pre-change generic entries authenticate through re-fetch — no 401 window (KTD8)', () => {
  const LEGACY_SHAPES: Array<[string, Record<string, unknown>]> = [
    ['api/_user-api-key.js shape ({userId, keyId, name})', { userId: 'user_owner', keyId: 'key_old', name: 'ci' }],
    ['raw Convex row cached by the gateway ({id, userId, name})', { id: 'key_old', userId: 'user_owner', name: 'ci' }],
    ['userId only', { userId: 'user_owner' }],
  ];

  for (const [label, entry] of LEGACY_SHAPES) {
    it(`TypeScript: ${label} → Convex re-fetch, principal granted, cache rewritten with keyId`, async () => {
      const key = uniqueKey();
      const keyHash = await sha256Hex(key);
      seed(keyHash, entry);
      harness.validateQueue.push(convexRow({ id: 'key_fresh' }));
      const result = await validateUserApiKey(key);
      assert.equal(result?.userId, 'user_owner');
      assert.equal(result?.keyId, 'key_fresh');
      assert.equal(harness.validateCalls, 1);
      const rewritten = cached(keyHash) as Record<string, unknown>;
      assert.equal(rewritten.keyKind, 'api');
      assert.equal(rewritten.keyId, 'key_fresh');
      assert.equal(typeof rewritten.v, 'number');

      // Second call is a current-shape hit: no further Convex traffic.
      assert.equal((await validateUserApiKey(key))?.userId, 'user_owner');
      assert.equal(harness.validateCalls, 1);
    });

    it(`JavaScript: ${label} → Convex re-fetch, principal granted, cache rewritten with keyId`, async () => {
      const key = uniqueKey();
      const keyHash = await sha256Hex(key);
      seed(keyHash, entry);
      harness.validateQueue.push(convexRow({ id: 'key_fresh' }));
      assert.deepEqual(await validateBootstrapUserApiKey(key), { ok: true, userId: 'user_owner' });
      assert.equal(harness.validateCalls, 1);
      const rewritten = cached(keyHash) as Record<string, unknown>;
      assert.equal(rewritten.keyId, 'key_fresh');
      assert.equal(rewritten.keyKind, 'api');
      assert.deepEqual(await validateBootstrapUserApiKey(key), { ok: true, userId: 'user_owner' });
      assert.equal(harness.validateCalls, 1);
    });
  }

  it('a Convex row without keyKind (backend predating U2) is an api key in both validators', async () => {
    const tsKey = uniqueKey();
    harness.validateQueue.push({ id: 'key_1', userId: 'user_owner', name: 'ci' });
    const ts = await validateUserApiKey(tsKey);
    assert.equal(ts?.userId, 'user_owner');
    assert.equal((cached(await sha256Hex(tsKey)) as Record<string, unknown>).keyKind, 'api');

    const jsKey = uniqueKey();
    harness.validateQueue.push({ id: 'key_1', userId: 'user_owner', name: 'ci' });
    assert.deepEqual(await validateBootstrapUserApiKey(jsKey), { ok: true, userId: 'user_owner' });
    assert.equal((cached(await sha256Hex(jsKey)) as Record<string, unknown>).keyKind, 'api');
  });

  it('a stale entry for a key Convex no longer knows is dropped, not kept', async () => {
    const key = uniqueKey();
    const keyHash = await sha256Hex(key);
    seed(keyHash, { userId: 'user_owner', keyId: 'key_old', name: 'ci' });
    harness.validateQueue.push(null);
    assert.equal(await validateUserApiKey(key), null);
    assert.notDeepEqual(cached(keyHash), { userId: 'user_owner', keyId: 'key_old', name: 'ci' });
  });
});

describe('revocation', () => {
  it('invalidateApiKeyCache deletes the desktop entry under the shared key name', async () => {
    const key = uniqueKey();
    const keyHash = await sha256Hex(key);
    harness.validateQueue.push(convexRow({ keyKind: 'desktop' }));
    const principal = await validateUserApiKeyPrincipal(key);
    assert.equal(principal?.keyKind, 'desktop');
    assert.ok(cached(keyHash));

    await invalidateApiKeyCache(keyHash);
    assert.deepEqual(harness.deletes, [`${CACHE_PREFIX}${keyHash}`]);
    assert.equal(cached(keyHash), undefined);

    // Convex now says revoked: both validators deny and no stale grant survives.
    harness.validateQueue.push(null);
    assert.equal(await validateUserApiKeyPrincipal(key), null);
    assert.equal(harness.validateCalls, 2);
  });

  it('Convex-side revocation and account deletion still delete the literal key name', () => {
    for (const file of ['convex/payments/cacheActions.ts', 'convex/accountDeletion/sideEffects.ts']) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      assert.match(src, /`user-api-key:\$\{/, `${file} must delete user-api-key:<hash>`);
    }
    const revoke = readFileSync(resolve(ROOT, 'api/invalidate-user-api-key-cache.ts'), 'utf8');
    assert.match(revoke, /invalidateApiKeyCache\(keyHash\)/);
  });
});

describe('Convex outage keeps the retryable 503', () => {
  it('TypeScript: cold miss during an outage throws UserApiKeyUnavailableError', async () => {
    harness.validateQueue.push({ status: 503 });
    await assert.rejects(validateUserApiKey(uniqueKey()), UserApiKeyUnavailableError);
  });

  it('TypeScript: a stale entry during an outage throws, and is neither granted nor negative-cached', async () => {
    const key = uniqueKey();
    const keyHash = await sha256Hex(key);
    seed(keyHash, { userId: 'user_owner', keyId: 'key_old', name: 'ci' });
    harness.validateQueue.push({ status: 503 });
    await assert.rejects(validateUserApiKey(key), UserApiKeyUnavailableError);
    assert.notEqual(cached(keyHash), NEG_SENTINEL);
  });

  it('TypeScript: desktop-aware variant throws the same error', async () => {
    harness.validateQueue.push(new Error('socket hang up'));
    await assert.rejects(validateUserApiKeyPrincipal(uniqueKey()), UserApiKeyUnavailableError);
  });

  it('JavaScript: cold and stale-entry outages return the 503 contract', async () => {
    harness.validateQueue.push({ status: 503 });
    const cold = await validateBootstrapUserApiKey(uniqueKey());
    assert.equal(cold.ok, false);
    assert.equal(!cold.ok && cold.status, 503);
    assert.equal(!cold.ok && cold.unavailable, true);
    assert.equal(!cold.ok && cold.headers?.['Retry-After'], '5');

    const key = uniqueKey();
    seed(await sha256Hex(key), { userId: 'user_owner', keyId: 'key_old', name: 'ci' });
    harness.validateQueue.push({ status: 503 });
    const stale = await validateBootstrapUserApiKey(key);
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.status, 503);

    harness.validateQueue.push({ status: 503 });
    const principal = await validateBootstrapUserApiKeyPrincipal(uniqueKey());
    assert.equal(principal.ok, false);
    assert.equal(!principal.ok && principal.status, 503);
  });
});

describe('desktop-aware variants', () => {
  it('TypeScript variant returns kind and hash for desktop and api keys', async () => {
    const desktop = uniqueKey();
    harness.validateQueue.push(convexRow({ id: 'key_d', keyKind: 'desktop' }));
    assert.deepEqual(await validateUserApiKeyPrincipal(desktop), {
      userId: 'user_owner', keyId: 'key_d', keyKind: 'desktop', keyHash: await sha256Hex(desktop),
    });

    const api = uniqueKey();
    harness.validateQueue.push(convexRow({ id: 'key_a' }));
    assert.deepEqual(await validateUserApiKeyPrincipal(api), {
      userId: 'user_owner', keyId: 'key_a', keyKind: 'api', keyHash: await sha256Hex(api),
    });

    // Warm reads come from the shared entry.
    assert.equal((await validateUserApiKeyPrincipal(desktop))?.keyKind, 'desktop');
    assert.equal(harness.validateCalls, 2);
  });

  it('TypeScript variant rejects malformed keys, unknown keys, and Company Monitoring bindings', async () => {
    assert.equal(await validateUserApiKeyPrincipal('wm_short'), null);
    assert.equal(harness.validateCalls, 0);

    harness.validateQueue.push(null);
    assert.equal(await validateUserApiKeyPrincipal(uniqueKey()), null);

    harness.validateQueue.push(convexRow({
      scopes: ['company_monitoring:read'],
      companyMonitoringAccountId: 'cm_account_01K1A2B3C4D5E6F7G8H9J0K1M2',
    }));
    assert.equal(await validateUserApiKeyPrincipal(uniqueKey()), null);
  });

  it('JavaScript variant returns kind and hash and rejects the same inputs', async () => {
    const desktop = uniqueKey();
    harness.validateQueue.push(convexRow({ id: 'key_d', keyKind: 'desktop' }));
    assert.deepEqual(await validateBootstrapUserApiKeyPrincipal(desktop), {
      ok: true, userId: 'user_owner', keyId: 'key_d', keyKind: 'desktop', keyHash: await sha256Hex(desktop),
    });

    const api = uniqueKey();
    harness.validateQueue.push(convexRow({ id: 'key_a' }));
    assert.deepEqual(await validateBootstrapUserApiKeyPrincipal(api), {
      ok: true, userId: 'user_owner', keyId: 'key_a', keyKind: 'api', keyHash: await sha256Hex(api),
    });

    const malformed = await validateBootstrapUserApiKeyPrincipal('wm_short');
    assert.equal(malformed.ok, false);
    assert.equal(!malformed.ok && malformed.status, 401);

    harness.validateQueue.push(convexRow({
      scopes: ['company_monitoring:read'],
      companyMonitoringAccountId: 'cm_account_01K1A2B3C4D5E6F7G8H9J0K1M2',
    }));
    const scoped = await validateBootstrapUserApiKeyPrincipal(uniqueKey());
    assert.equal(scoped.ok, false);
    assert.equal(!scoped.ok && scoped.status, 401);
  });
});

describe('bootstrap desktop entitlement check (merged features)', () => {
  let userSeq = 0;
  const user = () => `user_desktop_${++userSeq}`;

  it('admits a covered Pro owner carrying desktopKeyAccess', async () => {
    const userId = user();
    harness.entitlementQueue.push(proEntitlement());
    const result = await validateBootstrapDesktopKeyAccess(userId);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.entitlement.planKey, 'pro_monthly');
    // The same entitlement cache serves the API-plan check: one Convex read.
    const api = await validateBootstrapUserApiAccess(userId);
    assert.equal(api.ok, false);
    assert.equal(!api.ok && api.status, 403);
    assert.equal(harness.entitlementCalls, 1);
  });

  it('admits an API-plan owner (R8 upgrade case) through apiAccess', async () => {
    harness.entitlementQueue.push({
      planKey: 'api_starter',
      validUntil: Date.now() + 86_400_000,
      features: { tier: 2, apiAccess: true },
    });
    const result = await validateBootstrapDesktopKeyAccess(user());
    assert.equal(result.ok, true);
  });

  it('denies free and lapsed owners with 403 and keeps the billing contract', async () => {
    harness.entitlementQueue.push({ planKey: 'free', validUntil: 0, features: { tier: 0, apiAccess: false } });
    const free = await validateBootstrapDesktopKeyAccess(user());
    assert.equal(free.ok, false);
    assert.equal(!free.ok && free.status, 403);

    harness.entitlementQueue.push(proEntitlement({ validUntil: Date.now() - 1_000 }));
    const expired = await validateBootstrapDesktopKeyAccess(user());
    assert.equal(expired.ok, false);
    assert.equal(!expired.ok && expired.status, 403);

    harness.entitlementQueue.push({
      planKey: 'free', validUntil: 0, features: { tier: 0 }, billingStatus: 'subscription_lapsed',
    });
    const lapsed = await validateBootstrapDesktopKeyAccess(user());
    assert.equal(lapsed.ok, false);
    assert.equal(!lapsed.ok && lapsed.status, 403);
    assert.equal(!lapsed.ok && lapsed.headers?.['X-Billing-Verification'], 'subscription_lapsed');

    const missing = await validateBootstrapDesktopKeyAccess('');
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.status, 403);
  });

  it('a Pro row without the flag (unmerged legacy shape) is denied, never widened', async () => {
    harness.entitlementQueue.push(proEntitlement({ features: { tier: 1, apiAccess: false } }));
    const result = await validateBootstrapDesktopKeyAccess(user());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 403);
  });

  it('entitlement outage returns the retryable 503 contract', async () => {
    harness.entitlementQueue.push({ status: 500 });
    const result = await validateBootstrapDesktopKeyAccess(user());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 503);
    assert.equal(!result.ok && result.reason, 'entitlement_verification_unavailable');
  });

  it('a cached entitlement serves the desktop check without Convex', async () => {
    const userId = user();
    harness.redis.set(`entitlements:test:${userId}`, JSON.stringify(proEntitlement()));
    const result = await validateBootstrapDesktopKeyAccess(userId);
    assert.equal(result.ok, true);
    assert.equal(harness.entitlementCalls, 0);
  });

  it('a warm pre-deploy Pro entry (no desktopKeyAccess field) is a miss for the desktop check and is refetched once', async () => {
    const userId = user();
    const legacy = proEntitlement({ features: { tier: 1, apiAccess: false, mcpAccess: true } });
    harness.redis.set(`entitlements:test:${userId}`, JSON.stringify(legacy));
    harness.entitlementQueue.push(proEntitlement());
    const result = await validateBootstrapDesktopKeyAccess(userId);
    assert.equal(result.ok, true, 'the merged row from Convex admits the owner');
    assert.equal(harness.entitlementCalls, 1);
    const rewritten = JSON.parse(harness.redis.get(`entitlements:test:${userId}`) ?? 'null') as { features?: { desktopKeyAccess?: boolean } };
    assert.equal(rewritten.features?.desktopKeyAccess, true, 'the refetch rewrites the entry in the merged shape');
    assert.equal((await validateBootstrapDesktopKeyAccess(userId)).ok, true);
    assert.equal(harness.entitlementCalls, 1, 'the rewritten entry is served from cache');
  });

  it('the api-access check keeps serving a pre-deploy entry without a refetch', async () => {
    const userId = user();
    harness.redis.set(`entitlements:test:${userId}`, JSON.stringify({
      planKey: 'api_starter', validUntil: Date.now() + 86_400_000, features: { tier: 2, apiAccess: true, mcpAccess: true },
    }));
    assert.equal((await validateBootstrapUserApiAccess(userId)).ok, true);
    assert.equal(harness.entitlementCalls, 0, 'the api-access decision never reads the desktop field');
  });

  it('a pre-deploy entry for a free or lapsed owner is not refetched (tier 0 cannot hold desktop keys)', async () => {
    const userId = user();
    harness.redis.set(`entitlements:test:${userId}`, JSON.stringify({ planKey: 'free', validUntil: Date.now() + 86_400_000, features: { tier: 0, apiAccess: false } }));
    const result = await validateBootstrapDesktopKeyAccess(userId);
    assert.equal(result.ok, false);
    assert.equal(harness.entitlementCalls, 0);
  });
});

describe('resolveBootstrapUserKeyAccess (bootstrap scope)', () => {
  let userSeq = 0;
  const user = () => `user_scope_${++userSeq}`;
  const apiPrincipal = (userId: string, activeKeyRank?: number) => ({
    userId, keyId: 'key_1', keyKind: 'api' as const, keyHash: 'a'.repeat(64),
    ...(activeKeyRank === undefined ? {} : { activeKeyRank }),
  });
  const desktopPrincipal = (userId: string, activeKeyRank?: number) => ({ ...apiPrincipal(userId, activeKeyRank), keyKind: 'desktop' as const });

  it('an entitlement outage on the api check is returned as is: ONE Convex call, no desktop fallback', async () => {
    const userId = user();
    harness.entitlementQueue.push({ status: 503 });
    const result = await resolveBootstrapUserKeyAccess(apiPrincipal(userId, 0));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 503);
    assert.equal(!result.ok && result.reason, 'entitlement_verification_unavailable');
    assert.equal(harness.entitlementCalls, 1, 'the desktop check must not re-dial a dependency that just failed');
  });

  it('a 403 from the api check falls through to the desktop check (one cached read, no second Convex call)', async () => {
    const userId = user();
    harness.entitlementQueue.push(proEntitlement());
    const result = await resolveBootstrapUserKeyAccess(apiPrincipal(userId, 0));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.scope, 'desktop');
    assert.equal(harness.entitlementCalls, 1);
  });

  it('R5: desktop-kind keys of an owner without apiAccess are capped by rank too', async () => {
    const userId = user();
    harness.entitlementQueue.push(proEntitlement());
    assert.equal((await resolveBootstrapUserKeyAccess(desktopPrincipal(userId, 1))).ok, true);
    const third = await resolveBootstrapUserKeyAccess(desktopPrincipal(userId, 2));
    assert.equal(third.ok, false);
    assert.equal(!third.ok && third.status, 403);
    assert.equal(!third.ok && third.error, 'Desktop key limit reached for this account');
    const unknown = await resolveBootstrapUserKeyAccess(desktopPrincipal(userId));
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.error, 'Pro subscription required');
  });

  it('R8: a desktop key of an API-plan owner is admitted without a rank', async () => {
    const userId = user();
    harness.entitlementQueue.push({ planKey: 'api_starter', validUntil: Date.now() + 86_400_000, features: { tier: 2, apiAccess: true } });
    const result = await resolveBootstrapUserKeyAccess(desktopPrincipal(userId));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.scope, 'desktop');
  });
});
