import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  getPremiumRpcBillingErrorType,
  requirePremiumRpcAccess,
} from '../server/_shared/premium-check.ts';
import {
  __resetEntitlementNegativeCacheForTests,
  type BillingVerificationDenial,
} from '../server/_shared/entitlement-check.ts';
import { mapErrorToResponse } from '../server/error-mapper.ts';
import {
  INTERNAL_MCP_VERIFIED_HEADER,
  TRUSTED_USER_ID_HEADER,
  getInternalMcpVerifiedNonce,
} from '../server/_shared/mcp-internal-hmac.ts';
import { triggerSimulation } from '../server/worldmonitor/forecast/v1/trigger-simulation.ts';
import { summarizeArticle } from '../server/worldmonitor/news/v1/summarize-article.ts';
import { getScenarioStatus } from '../server/worldmonitor/scenario/v1/get-scenario-status.ts';
import { runScenario } from '../server/worldmonitor/scenario/v1/run-scenario.ts';
import { listWebhooks } from '../server/worldmonitor/shipping/v2/list-webhooks.ts';
import { registerWebhook } from '../server/worldmonitor/shipping/v2/register-webhook.ts';
import { routeIntelligence } from '../server/worldmonitor/shipping/v2/route-intelligence.ts';
import { ApiError as ForecastApiError } from '../src/generated/server/worldmonitor/forecast/v1/service_server.ts';
import { ApiError as ScenarioApiError } from '../src/generated/server/worldmonitor/scenario/v1/service_server.ts';
import { ApiError as ShippingApiError } from '../src/generated/server/worldmonitor/shipping/v2/service_server.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };
const ENTERPRISE_TEST_KEY = 'enterprise-rpc-billing-denial-test-key';

const RETRYABLE_DENIAL: BillingVerificationDenial = {
  retryable: true,
  code: 'entitlement_verification_unavailable',
  retryAfterSeconds: 5,
  message: 'Unable to verify API access',
  status: 503,
};

const TERMINAL_LAPSE_DENIAL: BillingVerificationDenial = {
  retryable: false,
  code: 'subscription_lapsed',
  retryAfterSeconds: 0,
  message: 'Subscription lapsed',
  status: 403,
};

const FREE_ROW = {
  planKey: 'free',
  features: {
    tier: 0,
    apiAccess: false,
    apiRateLimit: 0,
    maxDashboards: 3,
    prioritySupport: false,
    exportFormats: ['csv'],
    mcpAccess: false,
  },
  validUntil: 0,
};

function installEntitlementFetch(
  convex: () => Promise<Response>,
  options: { entitlementReadsOnly?: boolean } = {},
): string[] {
  const unexpectedRedisRequests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : String((input as Request)?.url ?? input);
    if (url.includes('redis.test/get/')) {
      if (!decodeURIComponent(url).includes('/get/entitlements:')) {
        unexpectedRedisRequests.push(url);
        throw new Error(`business Redis read reached in test: ${url}`);
      }
      return new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('redis.test')) {
      if (options.entitlementReadsOnly) {
        unexpectedRedisRequests.push(url);
        throw new Error(`business Redis write reached in test: ${url}`);
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.includes('/api/internal-entitlements')) return convex();
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return unexpectedRedisRequests;
}

function markerRequest(
  userId: string,
  path = '/api/scenario/v1/run-scenario',
  options: { apiKey?: string; method?: string } = {},
): Request {
  return new Request(`https://api.worldmonitor.app${path}`, {
    method: options.method ?? 'POST',
    headers: {
      [INTERNAL_MCP_VERIFIED_HEADER]: getInternalMcpVerifiedNonce(),
      [TRUSTED_USER_ID_HEADER]: userId,
      ...(options.apiKey ? { 'X-WorldMonitor-Key': options.apiKey } : {}),
    },
  });
}

function handlerContext(request: Request) {
  return {
    request,
    pathParams: {},
    headers: Object.fromEntries(request.headers.entries()),
  };
}

async function captureError(run: () => Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error as Error & Record<string, unknown>;
  }
  assert.fail('expected promise to reject');
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

beforeEach(() => {
  restoreEnv();
  process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'fake-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_TEST_KEY;
  __resetEntitlementNegativeCacheForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreEnv();
  __resetEntitlementNegativeCacheForTests();
});

describe('premium RPC billing-denial representation (#5652)', () => {
  it('uses ServiceError plus the billing code for a retryable in-band RPC denial', () => {
    assert.equal(getPremiumRpcBillingErrorType(RETRYABLE_DENIAL), 'ServiceError');
  });

  it('keeps a provider-confirmed lapse terminal and classified', () => {
    assert.equal(getPremiumRpcBillingErrorType(TERMINAL_LAPSE_DENIAL), 'AuthError');
  });

  for (const [service, ApiErrorConstructor] of [
    ['scenario', ScenarioApiError],
    ['shipping', ShippingApiError],
    ['forecast', ForecastApiError],
  ] as const) {
    it(`builds the ${service} service own retryable ApiError`, async () => {
      installEntitlementFetch(async () => new Response('upstream error', { status: 503 }));
      const error = await captureError(() => requirePremiumRpcAccess(
        markerRequest(`user_${service}_transient`),
        ApiErrorConstructor,
        'PRO subscription required',
      ));

      assert.ok(error instanceof ApiErrorConstructor);
      assert.equal(error.statusCode, 503);
      assert.equal(error.message, 'Unable to verify API access');
      assert.equal(error.body, 'entitlement_verification_unavailable');
      assert.equal(error.retryAfter, 5);
      assert.equal(error.exposeMessage, true);
      assert.equal(error.billingVerificationCode, 'entitlement_verification_unavailable');
    });
  }

  it('keeps a confirmed free caller on the existing fallback 403', async () => {
    installEntitlementFetch(async () => new Response(JSON.stringify(FREE_ROW), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const error = await captureError(() => requirePremiumRpcAccess(
      markerRequest('user_confirmed_free'),
      ScenarioApiError,
      'PRO subscription required',
    ));

    assert.ok(error instanceof ScenarioApiError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.message, 'PRO subscription required');
    assert.equal(error.billingVerificationCode, undefined);
  });

  it('maps a retryable ApiError to the public billing code and retry headers', async () => {
    installEntitlementFetch(async () => new Response('upstream error', { status: 503 }));
    const error = await captureError(() => requirePremiumRpcAccess(
      markerRequest('user_mapped_transient'),
      ScenarioApiError,
      'PRO subscription required',
    ));

    const response = mapErrorToResponse(
      error,
      new Request('https://api.worldmonitor.app/api/scenario/v1/run-scenario'),
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '5');
    assert.equal(
      response.headers.get('X-Billing-Verification'),
      'entitlement_verification_unavailable',
    );
    assert.deepEqual(await response.json(), {
      message: 'Unable to verify API access',
      retryAfter: 5,
      code: 'entitlement_verification_unavailable',
    });
  });

  it('maps an actual provider-confirmed lapse as terminal without retry metadata', async () => {
    installEntitlementFetch(async () => new Response(JSON.stringify({
      ...FREE_ROW,
      billingStatus: 'subscription_lapsed',
      retryAfterSeconds: 99,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const request = markerRequest('user_mapped_lapsed');
    const error = await captureError(() => requirePremiumRpcAccess(
      request,
      ScenarioApiError,
      'PRO subscription required',
    ));

    assert.ok(error instanceof ScenarioApiError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.message, 'Subscription lapsed');
    assert.equal(error.body, 'subscription_lapsed');
    assert.equal(error.billingVerificationCode, 'subscription_lapsed');
    assert.equal(error.retryAfter, undefined);
    assert.equal(error.exposeMessage, undefined);

    const response = mapErrorToResponse(error, request);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('X-Billing-Verification'), 'subscription_lapsed');
    assert.equal(response.headers.get('Retry-After'), null);
    assert.deepEqual(await response.json(), {
      message: 'Subscription lapsed',
      code: 'subscription_lapsed',
    });
  });

  it('does not publish an unrecognized mapper billing code', async () => {
    const error = new ScenarioApiError(403, 'Forbidden', 'not_a_billing_code') as
      ScenarioApiError & { billingVerificationCode: string };
    error.billingVerificationCode = 'not_a_billing_code';

    const response = mapErrorToResponse(
      error,
      new Request('https://api.worldmonitor.app/api/scenario/v1/run-scenario'),
    );
    assert.equal(response.headers.get('X-Billing-Verification'), null);
    assert.deepEqual(await response.json(), { message: 'Forbidden' });
  });
});

describe('migrated premium RPC handler gates (#5652)', () => {
  const cases = [
    {
      name: 'triggerSimulation',
      path: '/api/forecast/v1/trigger-simulation',
      ApiErrorConstructor: ForecastApiError,
      invoke: (request: Request) => triggerSimulation(handlerContext(request), { clientVersion: '' }),
    },
    {
      name: 'runScenario',
      path: '/api/scenario/v1/run-scenario',
      ApiErrorConstructor: ScenarioApiError,
      invoke: (request: Request) => runScenario(handlerContext(request), { scenarioId: '', iso2: '' }),
    },
    {
      name: 'getScenarioStatus',
      path: '/api/scenario/v1/get-scenario-status',
      ApiErrorConstructor: ScenarioApiError,
      invoke: (request: Request) => getScenarioStatus(handlerContext(request), { jobId: '' }),
    },
    {
      name: 'routeIntelligence',
      path: '/api/shipping/v2/route-intelligence',
      ApiErrorConstructor: ShippingApiError,
      invoke: (request: Request) => routeIntelligence(handlerContext(request), {
        fromIso2: '',
        toIso2: '',
        cargoType: '',
        hs2: '',
      }),
    },
    {
      name: 'registerWebhook',
      path: '/api/shipping/v2/register-webhook',
      ApiErrorConstructor: ShippingApiError,
      invoke: (request: Request) => registerWebhook(handlerContext(request), {
        callbackUrl: '',
        chokepointIds: [],
      }),
      requiresApiKey: true,
    },
    {
      name: 'listWebhooks',
      path: '/api/shipping/v2/list-webhooks',
      ApiErrorConstructor: ShippingApiError,
      invoke: (request: Request) => listWebhooks(handlerContext(request), {}),
      requiresApiKey: true,
    },
  ] as const;

  for (const entry of cases) {
    it(`${entry.name} throws its service-local retryable ApiError before handler work`, async () => {
      const unexpectedRedisRequests = installEntitlementFetch(
        async () => new Response('convex unavailable', { status: 503 }),
        { entitlementReadsOnly: true },
      );
      const request = markerRequest(
        `user_${entry.name}_transient`,
        entry.path,
        {
          apiKey: 'requiresApiKey' in entry ? ENTERPRISE_TEST_KEY : undefined,
          method: entry.name === 'getScenarioStatus' || entry.name === 'listWebhooks'
            ? 'GET'
            : 'POST',
        },
      );
      const error = await captureError(() => entry.invoke(request));

      assert.ok(error instanceof entry.ApiErrorConstructor);
      assert.equal(error.statusCode, 503);
      assert.equal(error.message, 'Unable to verify API access');
      assert.equal(error.body, 'entitlement_verification_unavailable');
      assert.equal(error.billingVerificationCode, 'entitlement_verification_unavailable');
      assert.equal(error.retryAfter, 5);
      assert.deepEqual(unexpectedRedisRequests, []);
    });
  }
});

describe('summarizeArticle transient entitlement regression (#5652)', () => {
  it('does not turn a Convex 5xx into a Pro upsell', async () => {
    installEntitlementFetch(async () => new Response('convex unavailable', { status: 503 }));
    const request = markerRequest(
      'user_transient_entitlement',
      '/api/news/v1/summarize-article',
    );
    const result = await summarizeArticle(
      { request, pathParams: {}, headers: Object.fromEntries(request.headers.entries()) },
      {
        provider: 'groq',
        headlines: ['Headline one'],
        mode: 'brief',
        geoContext: '',
        variant: 'full',
        lang: 'en',
        systemAppend: '',
        bodies: [],
      },
    );

    assert.equal(result.status, 'SUMMARIZE_STATUS_ERROR');
    assert.equal(result.errorType, 'ServiceError');
    assert.equal(result.statusDetail, 'entitlement_verification_unavailable');
    assert.equal(result.error, 'Unable to verify API access');
    assert.notEqual(result.error, 'Pro subscription required');
  });

  it('keeps a provider-confirmed lapse in the terminal AuthError envelope', async () => {
    installEntitlementFetch(async () => new Response(JSON.stringify({
      ...FREE_ROW,
      billingStatus: 'subscription_lapsed',
      retryAfterSeconds: 99,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const request = markerRequest(
      'user_lapsed_entitlement',
      '/api/news/v1/summarize-article',
    );
    const result = await summarizeArticle(
      handlerContext(request),
      {
        provider: 'groq',
        headlines: ['Headline one'],
        mode: 'brief',
        geoContext: '',
        variant: 'full',
        lang: 'en',
        systemAppend: '',
        bodies: [],
      },
    );

    assert.equal(result.status, 'SUMMARIZE_STATUS_ERROR');
    assert.equal(result.errorType, 'AuthError');
    assert.equal(result.statusDetail, 'subscription_lapsed');
    assert.equal(result.error, 'Subscription lapsed');
  });
});
