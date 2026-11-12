// POST /api/travel-risk-assessment (#10451, phase 2): the in-app export of the
// travel risk assessment. The route is the gate, not the button: every verdict
// is decided from the caller's entitlement before any source is read, and the
// plan fixtures come from the real catalog so a plan that gains or loses the
// `travelRiskAssessment` flag changes these results.

import { describe, it, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { getEntitlementFeatures } from '../convex/config/productCatalog';
import { McpSourceUnavailableError } from '../api/mcp/source-unavailable';
import { createTravelRiskTool } from '../api/mcp/registry/travel-risk-tool';
import type { TravelRiskResult } from '../api/mcp/registry/_travel-risk-document';
import {
  createTravelRiskExportHandler,
  TRAVEL_RISK_EXPORT_MAX_BODY_BYTES,
  type TravelRiskExportDeps,
} from '../server/_shared/travel-risk-export';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const URL_ = 'https://www.worldmonitor.app/api/travel-risk-assessment';
const TRIP = { countries: [{ country_code: 'TH', cities: ['Bangkok'], arrive: '2026-12-01', depart: '2026-12-05' }], task_label: 'Site visit' };
const MARKDOWN = '# Travel risk assessment draft\n\nTask: Site visit\n\n## 1. Summary\n\n**Overall rating.** Unrated.\n';

function entitlement(planKey: string) {
  return { planKey, features: { ...getEntitlementFeatures(planKey) }, validUntil: NOW + 86_400_000 };
}

interface Harness {
  deps: TravelRiskExportDeps;
  calls: { build: number; entitlement: Array<{ userId: string; options: unknown }>; capture: number };
}

function harness(overrides: Partial<TravelRiskExportDeps> & { plan?: string | null } = {}): Harness {
  const calls: Harness['calls'] = { build: 0, entitlement: [], capture: 0 };
  const { plan = 'pro_business_monthly', ...rest } = overrides;
  const deps: TravelRiskExportDeps = {
    corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://www.worldmonitor.app' }),
    validateBearer: async (token) => (token === 'good'
      ? { valid: true, userId: 'user_1' }
      : token === 'unverifiable' ? { valid: false, reason: 'unverifiable' } : { valid: false, reason: 'invalid' }),
    getEntitlements: async (userId, options) => {
      calls.entitlement.push({ userId, options });
      return plan === null ? null : entitlement(plan);
    },
    rateLimit: async () => null,
    backendConfigured: () => true,
    build: async () => {
      calls.build += 1;
      return { markdown: MARKDOWN, document: {} as TravelRiskResult['document'] };
    },
    now: () => NOW,
    captureError: () => { calls.capture += 1; },
    ...rest,
  };
  return { deps, calls };
}

function post(body: unknown, headers: Record<string, string> = { Authorization: 'Bearer good' }): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://www.worldmonitor.app', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('travel risk export route: who gets in', () => {
  it('admits Pro Business, API Business and Enterprise', async () => {
    for (const plan of ['pro_business_monthly', 'pro_business_annual', 'api_business', 'api_business_annual', 'enterprise']) {
      const { deps, calls } = harness({ plan });
      const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
      assert.equal(res.status, 200, plan);
      assert.equal(calls.build, 1, plan);
    }
  });

  it('refuses Free, Pro and API Starter with an upgrade message, and reads no source', async () => {
    for (const plan of ['pro_monthly', 'pro_annual', 'api_starter', 'api_starter_annual']) {
      const { deps, calls } = harness({ plan });
      const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
      assert.equal(res.status, 403, plan);
      const body = await res.json() as { error: string; message: string };
      assert.equal(body.error, 'UPGRADE_REQUIRED', plan);
      assert.match(body.message, /Pro Business, API Business and Enterprise/, plan);
      assert.equal(calls.build, 0, `${plan}: no source read for a refused plan`);
    }
  });

  it('refuses an account with no entitlement row', async () => {
    const { deps, calls } = harness({ plan: null });
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.equal(res.status, 403);
    assert.equal(calls.build, 0);
  });

  it('fails closed on a missing flag and on a lapsed grant', async () => {
    const missing = harness({ getEntitlements: async () => ({ planKey: 'x', features: { tier: 1 }, validUntil: NOW + 1000 }) as never });
    assert.equal((await createTravelRiskExportHandler(missing.deps)(post({ ...TRIP, format: 'markdown' }))).status, 403);
    const lapsed = harness({ getEntitlements: async () => ({ ...entitlement('pro_business_monthly'), validUntil: NOW - 1 }) as never });
    assert.equal((await createTravelRiskExportHandler(lapsed.deps)(post({ ...TRIP, format: 'markdown' }))).status, 403);
    assert.equal(missing.calls.build + lapsed.calls.build, 0);
  });

  it('asks for the travel shape, so a stale cached row is refetched instead of refused', async () => {
    const { deps, calls } = harness();
    await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.deepEqual(calls.entitlement, [{ userId: 'user_1', options: { requireTravelRiskShape: true } }]);
  });

  it('answers 503, not 403, when the entitlement lookup throws', async () => {
    const { deps, calls } = harness({ getEntitlements: async () => { throw new Error('convex down'); } });
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.equal(res.status, 503);
    assert.equal(calls.build, 0);
    assert.equal(calls.capture, 1);
  });
});

describe('travel risk export route: a lookup that could not verify is not "no plan"', () => {
  // `getEntitlements` does not throw on an outage: it returns a marker row.
  const marker = (extra: Record<string, unknown>) => async () => ({ ...entitlement('pro_business_monthly'), ...extra }) as never;

  it('answers a retryable 503, not an upgrade 403, for each unverified state', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['verification unavailable', { verificationUnavailable: true, retryAfterSeconds: 30 }, 'entitlement_verification_unavailable'],
      ['renewal pending', { billingStatus: 'renewal_verification_pending' }, 'renewal_verification_pending'],
      ['renewal failed', { billingStatus: 'renewal_verification_failed' }, 'renewal_verification_failed'],
    ];
    for (const [label, extra, code] of cases) {
      const { deps, calls } = harness({ getEntitlements: marker(extra) });
      const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
      assert.equal(res.status, 503, label);
      assert.equal(res.headers.get('X-Billing-Verification'), code, label);
      assert.ok(Number(res.headers.get('Retry-After')) > 0, label);
      assert.notEqual(((await res.json()) as { error?: string }).error, 'UPGRADE_REQUIRED', label);
      assert.equal(calls.build, 0, label);
    }
  });

  it('keeps a provider-confirmed lapse a terminal 403 with no retry hint', async () => {
    const { deps, calls } = harness({ getEntitlements: marker({ billingStatus: 'subscription_lapsed' }) });
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-Billing-Verification'), 'subscription_lapsed');
    assert.equal(res.headers.get('Retry-After'), null);
    assert.equal(calls.build, 0);
  });

  it('treats a missing row as a deploy defect, not a free account, when no backend is configured', async () => {
    const { deps, calls } = harness({ plan: null, backendConfigured: () => false });
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-Billing-Verification'), 'entitlement_verification_unavailable');
    assert.equal(calls.build, 0);
  });

  it('still refuses a missing row with 403 when the backend is configured', async () => {
    const { deps } = harness({ plan: null });
    assert.equal((await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }))).status, 403);
  });
});

describe('travel risk export route: credentials', () => {
  it('answers 401 with no credential and with a bad token', async () => {
    for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: 'Basic abc' }]) {
      const { deps, calls } = harness();
      const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }, headers));
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal(calls.build, 0);
      assert.equal(calls.entitlement.length, 0);
    }
  });

  it('answers 503 when the token cannot be verified', async () => {
    const { deps } = harness();
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }, { Authorization: 'Bearer unverifiable' }));
    assert.equal(res.status, 503);
  });

  it('does not accept an API key: the in-app export is a browser session', async () => {
    const { deps, calls } = harness();
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }, { 'X-WorldMonitor-Key': 'wm_abc', 'X-Api-Key': 'wm_abc' }));
    assert.equal(res.status, 401);
    assert.equal(calls.build, 0);
  });
});

describe('travel risk export route: request shape', () => {
  it('answers OPTIONS with CORS and refuses other methods', async () => {
    const { deps } = harness();
    const handler = createTravelRiskExportHandler(deps);
    const preflight = await handler(new Request(URL_, { method: 'OPTIONS', headers: { Origin: 'https://www.worldmonitor.app' } }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://www.worldmonitor.app');
    const get = await handler(new Request(URL_, { method: 'GET', headers: { Authorization: 'Bearer good' } }));
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('Allow'), 'POST, OPTIONS');
  });

  it('answers 400 for malformed JSON, an unknown format and a missing format', async () => {
    const { deps, calls } = harness();
    const handler = createTravelRiskExportHandler(deps);
    assert.equal((await handler(post('{not json'))).status, 400);
    assert.equal((await handler(post({ ...TRIP, format: 'pdf' }))).status, 400);
    assert.equal((await handler(post({ ...TRIP }))).status, 400);
    assert.equal(calls.build, 0);
  });

  it('names a rejected field and its rule, never the value, and refuses personal details', async () => {
    const { deps, calls } = harness();
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, traveller_name: 'Jane Q Traveller', format: 'markdown' }));
    assert.equal(res.status, 400);
    const text = await res.text();
    const body = JSON.parse(text) as { error: string; violations: Array<{ field: string; description: string }> };
    assert.equal(body.error, 'INVALID_ARGUMENTS');
    assert.equal(body.violations[0]!.field, 'traveller_name');
    assert.match(body.violations[0]!.description, /never traveller names/);
    assert.doesNotMatch(text, /Jane/);
    assert.equal(calls.build, 0);
  });

  it('rejects an oversized body before parsing it', async () => {
    const { deps, calls } = harness();
    const big = JSON.stringify({ ...TRIP, format: 'markdown', task_label: 'x'.repeat(TRAVEL_RISK_EXPORT_MAX_BODY_BYTES) });
    const res = await createTravelRiskExportHandler(deps)(post(big));
    assert.equal(res.status, 413);
    assert.equal(calls.build, 0);
  });

  it('stops reading a body that declares no length once it passes the cap', async () => {
    // Chunked transfer carries no Content-Length, so the declared-size check
    // cannot see it. The cap has to hold while the body is read, not after.
    const { deps, calls } = harness();
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        controller.enqueue(chunk);
        if (pulled > 10 * 1024 * 1024) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const request = new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.worldmonitor.app', Authorization: 'Bearer good' },
      body,
      duplex: 'half',
    } as RequestInit);
    assert.equal(request.headers.get('Content-Length'), null);
    const res = await createTravelRiskExportHandler(deps)(request);
    assert.equal(res.status, 413);
    assert.equal(calls.build, 0);
    assert.equal(cancelled, true, 'the rest of the upload is cancelled, not drained');
    // Streams read ahead a little; what matters is that it is nowhere near the 10 MiB offered.
    assert.ok(pulled < TRAVEL_RISK_EXPORT_MAX_BODY_BYTES + 128 * 1024, `pulled ${pulled} bytes`);
  });

  it('still reads a normal body that arrives in several chunks', async () => {
    const { deps, calls } = harness();
    const text = JSON.stringify({ ...TRIP, format: 'markdown' });
    const parts = [text.slice(0, 20), text.slice(20, 60), text.slice(60)].map((s) => new TextEncoder().encode(s));
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } });
    const res = await createTravelRiskExportHandler(deps)(new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.worldmonitor.app', Authorization: 'Bearer good' },
      body,
      duplex: 'half',
    } as RequestInit));
    assert.equal(res.status, 200);
    assert.equal(calls.build, 1);
  });

  it('passes a rate-limit refusal through untouched', async () => {
    const { deps, calls } = harness({ rateLimit: async () => new Response('slow down', { status: 429 }) });
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.equal(res.status, 429);
    assert.equal(calls.build, 0);
  });
});

describe('travel risk export route: the files', () => {
  it('serves Markdown as an attachment that is never cached or sniffed', async () => {
    const { deps } = harness();
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
    assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="travel-risk-assessment-2026-11-10.md"');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://www.worldmonitor.app');
    assert.equal(await res.text(), MARKDOWN);
  });

  it('serves HTML converted from the same Markdown, under a script-free policy', async () => {
    const { deps } = harness();
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'html' }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="travel-risk-assessment-2026-11-10.html"');
    assert.match(res.headers.get('Content-Security-Policy') ?? '', /default-src 'none'/);
    assert.match(res.headers.get('Content-Security-Policy') ?? '', /sandbox/);
    const html = await res.text();
    assert.match(html, /<h1>Travel risk assessment draft<\/h1>/);
    assert.match(html, /<h2>1\. Summary<\/h2>/);
  });

  it('puts no task label or country in the filename', async () => {
    const { deps } = harness();
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.doesNotMatch(res.headers.get('Content-Disposition') ?? '', /Site|visit|TH|Thailand/);
  });

  it('answers 503 when no input feed is available', async () => {
    const { deps, calls } = harness({ build: async () => { throw new McpSourceUnavailableError('none', ['a'], []); } });
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'SOURCES_UNAVAILABLE');
    assert.equal(calls.capture, 0, 'an outage of the inputs is reported by the health checks, not as a route error');
  });

  it('captures an unexpected failure and answers 500 without its message', async () => {
    const { deps, calls } = harness({ build: async () => { throw new Error('secret internal detail'); } });
    const res = await createTravelRiskExportHandler(deps)(post({ ...TRIP, format: 'markdown' }));
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /secret internal detail/);
    assert.equal(calls.capture, 1);
  });
});

describe('travel risk export route: with the real tool behind it', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [['UPSTASH_REDIS_REST_URL', originalEnv.url], ['UPSTASH_REDIS_REST_TOKEN', originalEnv.token]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  // Every key holds a small object, which the assembler reads as a source that
  // answered with nothing it can use: the draft still comes back, section by
  // section "unavailable", which is what the route must carry through.
  function stubRedis() {
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      const value = JSON.stringify({ ok: 1 });
      if (String(url).endsWith('/pipeline')) {
        const commands = JSON.parse(String(init?.body ?? '[]')) as unknown[];
        return Response.json(commands.map(() => ({ result: value })));
      }
      return Response.json({ result: value });
    }) as typeof fetch;
  }

  function realHandler() {
    const tool = createTravelRiskTool();
    const { deps } = harness({
      build: async (params) => await (tool as { _execute: (p: Record<string, unknown>, b: string, c: unknown, e: unknown) => Promise<unknown> })
        ._execute(params, '', { kind: 'free' }, undefined) as TravelRiskResult,
    });
    return createTravelRiskExportHandler(deps);
  }

  const SECTIONS = ['1. Summary', '2. Government travel advice', '3. Security', '4. Natural hazards', '5. Health',
    '6. Getting in and out', '7. Communications and infrastructure', '8. What this draft does not cover', '9. Sources and capture time'];

  it('returns the nine-section Markdown draft for the trip that was posted', async () => {
    stubRedis();
    const res = await realHandler()(post({ ...TRIP, countries: [{ country_code: 'TH', cities: ['Bangkok'] }, { country_code: 'VN' }], format: 'markdown' }));
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const heading of SECTIONS) assert.ok(text.includes(`## ${heading}`), heading);
    assert.match(text, /Task: Site visit/);
    assert.match(text, /1\. Thailand \(TH\)\. Cities: Bangkok\./);
    assert.match(text, /2\. Vietnam \(VN\)\./);
  });

  it('returns the same draft as HTML, with every section and the analyst headings', async () => {
    stubRedis();
    const res = await realHandler()(post({ ...TRIP, format: 'html' }));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.deepEqual([...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]), SECTIONS);
    assert.equal((html.match(/Analyst to complete\./g) ?? []).length, 5);
    assert.match(html, /<table>/);
  });

  it('refuses a trip the tool would refuse, without reading a source', async () => {
    let fetched = 0;
    globalThis.fetch = (async () => { fetched += 1; return Response.json({ result: null }); }) as typeof fetch;
    const res = await realHandler()(post({ countries: [{ country_code: 'XX' }], format: 'markdown' }));
    assert.equal(res.status, 400);
    assert.equal(fetched, 0);
  });
});

describe('travel risk export route: the edge wiring', () => {
  const source = readFileSync(new URL('../api/travel-risk-assessment.ts', import.meta.url), 'utf8');

  it('applies its own per-account budget on top of the shared one', () => {
    assert.match(source, /checkRateLimit\(request, cors, \{ principalUserId: userId \}\)/);
    assert.match(source, /checkScopedRateLimit\(RATE_SCOPE, RATE_LIMIT, RATE_WINDOW, userId\)/);
    const limit = Number(/const RATE_LIMIT = (\d+);/.exec(source)?.[1]);
    assert.ok(limit > 0 && limit <= 30, `the per-account cap is a handful a minute, not the shared 600 (got ${limit})`);
  });

  it('resolves the session without the plan lookup it does not use, and sends the entitlement backend check through', () => {
    assert.match(source, /validateBearerToken\(token, \{ resolvePlan: false \}\)/);
    assert.match(source, /backendConfigured: isEntitlementBackendConfigured/);
  });
});
