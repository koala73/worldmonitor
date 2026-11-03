import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { deriveSentryTraceId } from '../server/_shared/usage.ts';

test('trace header preserves absent, empty, valid and boundary values', () => {
  const trace = '0123456789abcdef0123456789abcdef-0123456789abcdef-1';
  for (const value of [null, '', trace, 'a'.repeat(512), 'a'.repeat(513)]) {
    const req = new Request('https://worldmonitor.app/api/test', {
      headers: value === null ? {} : { 'sentry-trace': value },
    });
    assert.equal(deriveSentryTraceId(req), value?.slice(0, 512) ?? null);
    assert.equal(req.headers.get('sentry-trace'), value);
  }
});

test('gateway caps caller-controlled trace data before Axiom delivery', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.USAGE_TELEMETRY;
  const originalToken = process.env.AXIOM_API_TOKEN;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.USAGE_TELEMETRY;
    else process.env.USAGE_TELEMETRY = originalFlag;
    if (originalToken === undefined) delete process.env.AXIOM_API_TOKEN;
    else process.env.AXIOM_API_TOKEN = originalToken;
  });
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'synthetic-axiom-token';
  const events: { sentry_trace_id: string; reason: string }[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'api.axiom.co');
    events.push(...JSON.parse(String(init?.body)));
    return new Response('{}');
  };
  const trace = 'a'.repeat(8192);
  const req = new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
    headers: { Origin: 'https://untrusted.example', 'sentry-trace': trace },
  });
  const pending: Promise<unknown>[] = [];
  const res = await createDomainGateway([])(req, {
    waitUntil: (promise) => { pending.push(promise); },
  });
  await Promise.all(pending);
  assert.equal(res.status, 403);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, 'origin_403');
  assert.equal(events[0]!.sentry_trace_id, trace.slice(0, 512));
  assert.equal(req.headers.get('sentry-trace'), trace);
});
