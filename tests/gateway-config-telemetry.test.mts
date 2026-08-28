/**
 * #7277 — a missing MCP_INTERNAL_HMAC_SECRET was recorded as `auth_401`.
 *
 * The gateway answers the HMAC-attempt path correctly (500 CONFIGURATION),
 * but telemetry classified the server-side configuration failure as caller
 * authentication failure — hiding a deployment incident inside auth-noise
 * dashboards. The reason is now `hmac_secret_unconfigured` (#7281); a
 * malformed signature with the secret CONFIGURED keeps the authentication
 * reason.
 *
 * Asserted at the transport: USAGE_TELEMETRY=1 + a stubbed Axiom ingest
 * capture the exact event the gateway emits, via the ctx.waitUntil promises.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { INTERNAL_MCP_SIG_HEADER, INTERNAL_MCP_USER_ID_HEADER, INTERNAL_MCP_NONCE_HEADER } from '../server/_shared/mcp-internal-hmac.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const PATH = '/api/testdomain/v1/get-config-probe';

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

type UsageEvent = { reason?: string; status?: number; route?: string };

function installTelemetryCapture(): UsageEvent[] {
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  const events: UsageEvent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.axiom.co/')) {
      for (const event of JSON.parse(String(init?.body ?? '[]')) as UsageEvent[]) events.push(event);
      return Response.json({ ingested: 1 });
    }
    if (url.includes('redis.test')) {
      return Response.json([{ result: 1 }]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return events;
}

function makeCtx(): { ctx: { waitUntil: (p: Promise<unknown>) => void }; settle: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p) => pending.push(p) },
    settle: async () => {
      await Promise.allSettled(pending);
    },
  };
}

function makeSignedShapeRequest(): Request {
  return new Request(`https://worldmonitor.app${PATH}`, {
    method: 'GET',
    headers: {
      Origin: 'https://worldmonitor.app',
      [INTERNAL_MCP_SIG_HEADER]: 'not-a-real-signature',
      [INTERNAL_MCP_USER_ID_HEADER]: 'user_config_telemetry',
      [INTERNAL_MCP_NONCE_HEADER]: 'nonce-config-telemetry',
    },
  });
}

describe('gateway HMAC configuration telemetry (#7277)', () => {
  it('a missing MCP_INTERNAL_HMAC_SECRET emits hmac_secret_unconfigured, not auth_401', async () => {
    delete process.env.MCP_INTERNAL_HMAC_SECRET;
    delete process.env.MCP_PRO_GRANT_HMAC_SECRET;
    const events = installTelemetryCapture();
    const gateway = createDomainGateway([]);
    const { ctx, settle } = makeCtx();

    const res = await gateway(makeSignedShapeRequest(), ctx);
    await settle();

    // Response contract unchanged: 500 CONFIGURATION with the detail intact.
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, 'CONFIGURATION');
    assert.match(body.detail, /MCP_INTERNAL_HMAC_SECRET/);

    const event = events.find((e) => e.route === PATH);
    assert.ok(event, 'the gateway must emit a usage event for the 500');
    assert.equal(event.status, 500);
    assert.equal(
      event.reason,
      'hmac_secret_unconfigured',
      'a server-side config failure must not be classified as caller auth failure',
    );
  });

  it('a malformed signature with the secret CONFIGURED keeps the authentication reason', async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = 'configured-secret-for-telemetry-test';
    delete process.env.MCP_PRO_GRANT_HMAC_SECRET;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
    const events = installTelemetryCapture();
    const gateway = createDomainGateway([]);
    const { ctx, settle } = makeCtx();

    const res = await gateway(makeSignedShapeRequest(), ctx);
    await settle();

    assert.equal(res.status, 401, 'a bad signature is still an authentication failure');
    const event = events.find((e) => e.route === PATH);
    assert.ok(event, 'the gateway must emit a usage event for the 401');
    assert.equal(event.reason, 'auth_401', 'caller-auth failures keep the auth reason');
  });
});
