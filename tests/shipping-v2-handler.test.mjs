/**
 * Functional tests for ShippingV2Service handlers. Tests the typed handlers
 * directly (not the HTTP gateway). Covers the security invariants the legacy
 * edge functions enforced:
 *   - routeIntelligence: PRO gate, iso2 regex, hs2 non-digit stripping,
 *     cargoType coercion to legal enum, wire-shape byte-for-byte with partner
 *     contract (camelCase field names, ISO-8601 fetchedAt).
 *   - registerWebhook: PRO gate, SSRF guards (https-only, private IP, cloud
 *     metadata), chokepointIds whitelist, alertThreshold 0-100 range,
 *     subscriberId / secret format (wh_ + 24 hex / 64 hex), 30-day TTL
 *     atomic pipeline (SET + SADD + EXPIRE).
 *   - listWebhooks: PRO gate, owner-filter isolation, `secret` never in response.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeCtx(headers = {}) {
  const req = new Request('https://worldmonitor.app/api/v2/shipping/route-intelligence', {
    method: 'GET',
    headers,
  });
  return { request: req, pathParams: {}, headers };
}

function proCtx() {
  return makeCtx({ 'X-WorldMonitor-Key': 'pro-test-key' });
}

let routeIntelligence;
let registerWebhook;
let listWebhooks;
let webhookShared;
let ValidationError;
let ApiError;

describe('ShippingV2Service handlers', () => {
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

    const riMod = await import('../server/worldmonitor/shipping/v2/route-intelligence.ts');
    const rwMod = await import('../server/worldmonitor/shipping/v2/register-webhook.ts');
    const lwMod = await import('../server/worldmonitor/shipping/v2/list-webhooks.ts');
    webhookShared = await import('../server/worldmonitor/shipping/v2/webhook-shared.ts');
    routeIntelligence = riMod.routeIntelligence;
    registerWebhook = rwMod.registerWebhook;
    listWebhooks = lwMod.listWebhooks;
    const gen = await import('../src/generated/server/worldmonitor/shipping/v2/service_server.ts');
    ValidationError = gen.ValidationError;
    ApiError = gen.ApiError;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  describe('routeIntelligence', () => {
    it('rejects non-PRO callers with 403', async () => {
      await assert.rejects(
        () => routeIntelligence(makeCtx(), { fromIso2: 'AE', toIso2: 'NL', cargoType: '', hs2: '' }),
        (err) => err instanceof ApiError && err.statusCode === 403,
      );
    });

    it('rejects malformed fromIso2 with ValidationError', async () => {
      // Stub redis GET for CHOKEPOINT_STATUS_KEY so the handler never panics.
      globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), { status: 200 });
      // 'usa' uppercases to 'USA' (3 chars) — regex `^[A-Z]{2}$` rejects.
      await assert.rejects(
        () => routeIntelligence(proCtx(), { fromIso2: 'usa', toIso2: 'NL', cargoType: '', hs2: '' }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'fromIso2',
      );
    });

    it('preserves partner wire shape with ISO-8601 fetchedAt and camelCase fields', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), { status: 200 });
      const before = Date.now();
      const res = await routeIntelligence(proCtx(), {
        fromIso2: 'AE',
        toIso2: 'NL',
        cargoType: 'tanker',
        hs2: '27',
      });
      const after = Date.now();

      // Partner-visible top-level fields — exact names, camelCase, full set.
      assert.deepEqual(new Set(Object.keys(res)).size, 10);
      assert.equal(res.fromIso2, 'AE');
      assert.equal(res.toIso2, 'NL');
      assert.equal(res.cargoType, 'tanker');
      assert.equal(res.hs2, '27');
      assert.equal(typeof res.primaryRouteId, 'string');
      assert.ok(Array.isArray(res.chokepointExposures));
      assert.ok(Array.isArray(res.bypassOptions));
      assert.match(res.warRiskTier, /^WAR_RISK_TIER_/);
      assert.equal(typeof res.disruptionScore, 'number');

      // fetchedAt must be ISO-8601, NOT epoch ms — partners parse this string directly.
      assert.match(res.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      const parsedTs = Date.parse(res.fetchedAt);
      assert.ok(parsedTs >= before && parsedTs <= after, 'fetchedAt within request window');
    });

    it('defaults hs2 to "27" when blank or all non-digits', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), { status: 200 });
      const res1 = await routeIntelligence(proCtx(), { fromIso2: 'AE', toIso2: 'NL', cargoType: '', hs2: '' });
      const res2 = await routeIntelligence(proCtx(), { fromIso2: 'AE', toIso2: 'NL', cargoType: '', hs2: 'abc' });
      assert.equal(res1.hs2, '27');
      assert.equal(res2.hs2, '27');
    });

    it('coerces unknown cargoType to container', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), { status: 200 });
      const res = await routeIntelligence(proCtx(), {
        fromIso2: 'AE',
        toIso2: 'NL',
        cargoType: 'spaceship',
        hs2: '',
      });
      assert.equal(res.cargoType, 'container');
    });
  });

  describe('registerWebhook', () => {
    // Capture pipeline commands dispatched to Upstash for the happy-path Redis stub.
    function stubRedisOk() {
      const calls = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        // Upstash pipeline returns one result per command.
        return new Response(
          JSON.stringify(body.map(() => ({ result: 'OK' }))),
          { status: 200 },
        );
      };
      return calls;
    }

    it('rejects callers without an API key with 401 (tenant-isolation gate)', async () => {
      // Without this gate, Clerk-authenticated pro callers with no X-WorldMonitor-Key
      // collapse into a shared 'anon' fingerprint bucket and can see each other's
      // webhooks. Must fire before any premium check.
      await assert.rejects(
        () => registerWebhook(makeCtx(), {
          callbackUrl: 'https://hooks.example.com/wm',
          chokepointIds: [],
          alertThreshold: 50,
        }),
        (err) => err instanceof ApiError && err.statusCode === 401,
      );
    });

    it('rejects missing callbackUrl with ValidationError', async () => {
      await assert.rejects(
        () => registerWebhook(proCtx(), { callbackUrl: '', chokepointIds: [], alertThreshold: 50 }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'callbackUrl',
      );
    });

    it('SSRF guards reject http:// (must be https)', async () => {
      await assert.rejects(
        () => registerWebhook(proCtx(), {
          callbackUrl: 'http://hooks.example.com/wm',
          chokepointIds: [],
          alertThreshold: 50,
        }),
        (err) => err instanceof ValidationError && /https/.test(err.violations[0].description),
      );
    });

    it('SSRF guards reject localhost, RFC1918, and cloud metadata hostnames', async () => {
      const blockedHosts = [
        'https://localhost/hook',
        'https://127.0.0.1/hook',
        'https://10.0.0.1/hook',
        'https://192.168.1.1/hook',
        'https://169.254.169.254/latest/meta-data/',
        'https://metadata.google.internal/',
      ];
      for (const callbackUrl of blockedHosts) {
        await assert.rejects(
          () => registerWebhook(proCtx(), { callbackUrl, chokepointIds: [], alertThreshold: 50 }),
          (err) => err instanceof ValidationError,
          `expected SSRF block for ${callbackUrl}`,
        );
      }
    });

    it('rejects unknown chokepointIds', async () => {
      await assert.rejects(
        () => registerWebhook(proCtx(), {
          callbackUrl: 'https://hooks.example.com/wm',
          chokepointIds: ['not_a_real_chokepoint'],
          alertThreshold: 50,
        }),
        (err) => err instanceof ValidationError && /Unknown chokepoint/.test(err.violations[0].description),
      );
    });

    // alert_threshold 0..100 range is enforced primarily by buf.validate at
    // the wire layer. The handler re-enforces it so direct invocations
    // (internal jobs, test harnesses, future transports) can't store out-of-
    // range values — cheap invariant-at-the-boundary (#3287 review nit 1).
    it('rejects alertThreshold > 100 with ValidationError', async () => {
      await assert.rejects(
        () => registerWebhook(proCtx(), {
          callbackUrl: 'https://hooks.example.com/wm',
          chokepointIds: [],
          alertThreshold: 9999,
        }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'alertThreshold',
      );
    });

    it('rejects alertThreshold < 0 with ValidationError', async () => {
      await assert.rejects(
        () => registerWebhook(proCtx(), {
          callbackUrl: 'https://hooks.example.com/wm',
          chokepointIds: [],
          alertThreshold: -1,
        }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'alertThreshold',
      );
    });

    it('happy path returns wh_-prefixed subscriberId and 64-char hex secret; issues SET + SADD + EXPIRE pipeline with 30-day TTL', async () => {
      const calls = stubRedisOk();
      const res = await registerWebhook(proCtx(), {
        callbackUrl: 'https://hooks.example.com/wm',
        chokepointIds: [],
        alertThreshold: 60,
      });

      // Partner-visible shape: subscriberId + secret only (no extras).
      assert.deepEqual(Object.keys(res).sort(), ['secret', 'subscriberId']);
      assert.match(res.subscriberId, /^wh_[0-9a-f]{24}$/);
      assert.match(res.secret, /^[0-9a-f]{64}$/);

      // Exactly one Redis pipeline call with 3 commands in order.
      assert.equal(calls.length, 1);
      const pipeline = calls[0];
      assert.equal(pipeline.length, 3);
      assert.equal(pipeline[0][0], 'SET');
      assert.ok(pipeline[0][1].startsWith('webhook:sub:wh_'), 'SET key is webhook:sub:wh_*:v1');
      assert.equal(pipeline[0][3], 'EX');
      assert.equal(pipeline[0][4], String(86400 * 30), '30-day TTL on the webhook record');
      assert.equal(pipeline[1][0], 'SADD');
      assert.ok(pipeline[1][1].startsWith('webhook:owner:'), 'SADD key is webhook:owner:*:v1');
      assert.equal(pipeline[2][0], 'EXPIRE');
      assert.equal(pipeline[2][1], pipeline[1][1], 'EXPIRE targets same owner index key');
      assert.equal(pipeline[2][2], String(86400 * 30));
    });

    it('alertThreshold omitted (undefined) applies the legacy default of 50', async () => {
      const calls = stubRedisOk();
      await registerWebhook(proCtx(), {
        callbackUrl: 'https://hooks.example.com/wm',
        chokepointIds: [],
        // alertThreshold omitted — proto3 `optional int32` arrives as undefined
      });
      const record = JSON.parse(calls[0][0][2]);
      assert.equal(record.alertThreshold, 50);
    });

    it('alertThreshold explicit 0 is preserved (deliver every alert)', async () => {
      // #3242 followup #4 — proto3 `optional` lets the handler distinguish
      // "partner explicitly sent 0" from "partner omitted the field". The
      // pre-fix handler coerced both to 50, silently dropping the partner's
      // intent to receive every disruption.
      const calls = stubRedisOk();
      await registerWebhook(proCtx(), {
        callbackUrl: 'https://hooks.example.com/wm',
        chokepointIds: [],
        alertThreshold: 0,
      });
      const record = JSON.parse(calls[0][0][2]);
      assert.equal(record.alertThreshold, 0);
    });

    it('empty chokepointIds subscribes to the full CHOKEPOINT_REGISTRY', async () => {
      const calls = stubRedisOk();
      await registerWebhook(proCtx(), {
        callbackUrl: 'https://hooks.example.com/wm',
        chokepointIds: [],
        alertThreshold: 50,
      });
      const record = JSON.parse(calls[0][0][2]);
      assert.ok(record.chokepointIds.length > 0, 'empty list expands to registry');
      assert.equal(record.chokepointIds.length, webhookShared.VALID_CHOKEPOINT_IDS.size);
    });
  });

  describe('listWebhooks', () => {
    it('rejects callers without an API key with 401 (tenant-isolation gate)', async () => {
      // Mirror of registerWebhook: the defense-in-depth ownerTag check collapses
      // when callers fall through to 'anon', so we reject unauthenticated callers
      // before hitting Redis.
      await assert.rejects(
        () => listWebhooks(makeCtx(), {}),
        (err) => err instanceof ApiError && err.statusCode === 401,
      );
    });

    it('returns empty webhooks array when SMEMBERS is empty', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify([{ result: [] }]), { status: 200 });
      const res = await listWebhooks(proCtx(), {});
      assert.deepEqual(res, { webhooks: [] });
    });

    it('filters out records whose ownerTag does not match the caller fingerprint (cross-tenant isolation)', async () => {
      const otherOwnerRecord = {
        subscriberId: 'wh_deadbeef000000000000beef',
        ownerTag: 'someone-elses-hash',
        callbackUrl: 'https://other.example/hook',
        chokepointIds: ['hormuz_strait'],
        alertThreshold: 50,
        createdAt: '2026-04-01T00:00:00.000Z',
        active: true,
        secret: 'other-caller-secret-never-returned',
      };
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.length === 1 && body[0][0] === 'SMEMBERS') {
          return new Response(
            JSON.stringify([{ result: ['wh_deadbeef000000000000beef'] }]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify(body.map(() => ({ result: JSON.stringify(otherOwnerRecord) }))),
          { status: 200 },
        );
      };
      const res = await listWebhooks(proCtx(), {});
      assert.deepEqual(res.webhooks, [], 'mismatched ownerTag must not leak across callers');
    });

    it('omits `secret` from matched records — partner contract invariant', async () => {
      // Build a record whose ownerTag matches the caller's SHA-256 fingerprint.
      const key = 'pro-test-key';
      const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
      const ownerTag = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      const record = {
        subscriberId: 'wh_abc123456789012345678901',
        ownerTag,
        callbackUrl: 'https://hooks.example.com/wm',
        chokepointIds: ['hormuz_strait'],
        alertThreshold: 60,
        createdAt: '2026-04-01T00:00:00.000Z',
        active: true,
        secret: 'must-not-be-in-response',
      };
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.length === 1 && body[0][0] === 'SMEMBERS') {
          return new Response(
            JSON.stringify([{ result: [record.subscriberId] }]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify(body.map(() => ({ result: JSON.stringify(record) }))),
          { status: 200 },
        );
      };
      const res = await listWebhooks(proCtx(), {});
      assert.equal(res.webhooks.length, 1);
      const [summary] = res.webhooks;
      assert.equal(summary.subscriberId, record.subscriberId);
      assert.equal(summary.callbackUrl, record.callbackUrl);
      assert.ok(!('secret' in summary), '`secret` must never appear in ListWebhooks response');
    });
  });
});
