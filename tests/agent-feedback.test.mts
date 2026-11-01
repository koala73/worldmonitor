/**
 * Agent feedback channel core (#8721): parsing, sanitization, redaction,
 * hashes, admission buckets, and the shared submit path both doors use.
 * Spec: docs/architecture/agent-feedback-threat-model.md.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  FEEDBACK_ADVISORY_URL,
  FEEDBACK_BUCKETS,
  admitFeedbackReport,
  classifySurface,
  feedbackFingerprint,
  feedbackIpKey,
  feedbackRetryKey,
  parseFeedbackReport,
  redactFeedbackText,
  submitAgentFeedback,
  type FeedbackLimitCheck,
  type FeedbackReport,
} from '../server/_shared/agent-feedback.ts';
import { rateLimitKeyForIp } from '../server/_shared/client-ip.ts';

const originalEnv = { ...process.env };
const originalWarn = console.warn;

beforeEach(() => {
  process.env.USAGE_UA_PEPPER = 'synthetic-pepper';
  process.env.CONVEX_SITE_URL = 'https://synthetic.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'synthetic-secret';
});
afterEach(() => {
  console.warn = originalWarn;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const valid = { kind: 'bug', surface: 'get_market_data', summary: 'Quotes are empty for AAPL' };

function report(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return { kind: 'bug', surface: { type: 'mcp_tool', name: 'get_market_data' }, summary: 'Quotes are empty', ...overrides };
}

describe('parseFeedbackReport', () => {
  it('accepts a minimal report and ignores identity fields in the body', () => {
    const result = parseFeedbackReport({ ...valid, principalId: 'user_attacker', authKind: 'keyed', ipHash: 'x' });
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.report).sort(), ['actual', 'clientName', 'expected', 'kind', 'requestId', 'summary', 'surface']);
    assert.deepEqual(result.report.surface, { type: 'mcp_tool', name: 'get_market_data' });
  });

  for (const [field, input] of [
    ['kind', { ...valid, kind: 'praise' }],
    ['kind', { ...valid, kind: undefined }],
    ['summary', { ...valid, summary: '   ' }],
    ['summary', { ...valid, summary: 'x'.repeat(301) }],
    ['expected', { ...valid, expected: 'x'.repeat(2001) }],
    ['actual', { ...valid, actual: 42 }],
    ['requestId', { ...valid, requestId: 'has spaces' }],
    ['requestId', { ...valid, requestId: 'a'.repeat(129) }],
    ['clientName', { ...valid, clientName: 'c'.repeat(81) }],
    ['surface', { ...valid, surface: 's'.repeat(201) }],
    // A lone surrogate is not valid UTF-8; Convex would refuse it as a 503.
    ['summary', { ...valid, summary: 'broken \uD800 text' }],
    ['actual', { ...valid, actual: 'tail \uDC00' }],
    ['surface', { ...valid, surface: '\uD83D' }],
  ] as const) {
    it(`rejects ${field} by name`, () => {
      assert.deepEqual(parseFeedbackReport(input as Record<string, unknown>), { ok: false, field });
    });
  }

  it('measures bounds in code points, so 300 CJK characters pass', () => {
    assert.equal(parseFeedbackReport({ ...valid, summary: '界'.repeat(300) }).ok, true);
    assert.equal(parseFeedbackReport({ ...valid, summary: '界'.repeat(301) }).ok, false);
  });

  it('strips controls, bidi overrides, and zero-width characters before measuring', () => {
    const result = parseFeedbackReport({ ...valid, summary: 'a‮b​c\r\nd e\u0007f' });
    assert.ok(result.ok);
    assert.equal(result.report.summary, 'a b c d e f');
  });

  it('treats empty proto3 strings as absent', () => {
    const result = parseFeedbackReport({ ...valid, expected: '', actual: '', requestId: '', clientName: '' });
    assert.ok(result.ok);
    assert.equal(result.report.expected, undefined);
    assert.equal(result.report.requestId, undefined);
  });
});

describe('classifySurface', () => {
  it('keeps RPC paths, tool names, and unknown labels', () => {
    assert.deepEqual(classifySurface('/api/market/v1/list-market-quotes'), { type: 'rpc', name: '/api/market/v1/list-market-quotes' });
    assert.deepEqual(classifySurface('get_market_data'), { type: 'mcp_tool', name: 'get_market_data' });
    assert.deepEqual(classifySurface('the weather tool'), { type: 'other', name: 'the weather tool' });
    assert.deepEqual(classifySurface(undefined), { type: 'other', name: 'unspecified' });
    assert.equal(classifySurface('x'.repeat(150)).name.length, 80);
  });

  it('files an unknown tool name under other when the door knows its registry', () => {
    const isKnownTool = (name: string) => name === 'get_market_data';
    assert.deepEqual(classifySurface('get_weather_data', { isKnownTool }), { type: 'other', name: 'get_weather_data' });
    assert.deepEqual(classifySurface('get_market_data', { isKnownTool }), { type: 'mcp_tool', name: 'get_market_data' });
  });
});

describe('redactFeedbackText', () => {
  const cases: Array<[string, string, string]> = [
    ['URL token param', 'see https://api.example.com/x?token=abc123&q=1', 'abc123'],
    ['URL api_key param', 'GET https://api.example.com/x?api_key=SECRETKEY', 'SECRETKEY'],
    ['URL signature param', 'https://bucket.s3.amazonaws.com/f?X-Amz-Signature=deadbeef', 'deadbeef'],
    ['URL userinfo', 'https://admin:hunter2@example.com/path', 'hunter2'],
    ['Bearer token', 'sent Bearer abc.def.ghi-123 to the API', 'abc.def.ghi-123'],
    ['Authorization header in JSON', '{"Authorization": "Basic dXNlcjpwYXNz"}', 'dXNlcjpwYXNz'],
    ['x-api-key header', 'x-api-key: plainvalue123', 'plainvalue123'],
    ['wm_ key', `my key wm_${'a1'.repeat(20)} failed`, `wm_${'a1'.repeat(20)}`],
    ['wms_ session', 'session wms_abcdefgh12345678', 'wms_abcdefgh12345678'],
    ['Sentry user token', 'sntryu_abcdef0123456789', 'sntryu_abcdef0123456789'],
    ['Stripe key', 'sk_live_51Habcdefghijk', 'sk_live_51Habcdefghijk'],
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', 'eyJzdWIiOiIxIn0'],
    ['Convex deploy key', 'prod:happy-otter-123|eyJ2MiI6ImFiYyJ9', 'eyJ2MiI6ImFiYyJ9'],
    ['email address', 'contact ada@example.com please', 'ada@example.com'],
    ['relative request path', 'GET /api/news/v1/summarize?api_key=SECRETVALUE1&symbol=AAPL', 'SECRETVALUE1'],
    ['bare query field', 'api_key=SECRETVALUE2&symbol=AAPL', 'SECRETVALUE2'],
    ['query on a bare name', 'x?key=SECRETVALUE3', 'SECRETVALUE3'],
    ['bare password field', 'login password=hunter2 failed', 'hunter2'],
    ['lowercase value in a full Authorization header', 'Authorization: Bearer mysecrettoken', 'mysecrettoken'],
    ['long lowercase Bearer value', 'sent Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
    ['credential field in a JSON body', '{"api_key": "SECRET123456"}', 'SECRET123456'],
    ['credential field in a config line', 'api_key: SECRET123456', 'SECRET123456'],
    ['backticked credential field', 'ran `api_key=SECRET123456` and got 401', 'SECRET123456'],
    ['quoted value in a name=value field', 'curl -d api_key="SECRET123456" /api/x', 'SECRET123456'],
    ['single-quoted JSON-ish field', "{'client_secret': 'Abc.def-123'}", 'Abc.def-123'],
  ];
  for (const [name, input, secret] of cases) {
    it(`redacts a ${name}`, () => {
      const out = redactFeedbackText(input);
      assert.equal(out.redacted, true, name);
      assert.ok(!out.text.includes(secret), `${name} leaked: ${out.text}`);
    });
  }

  it('keeps prose about auth: only a token-shaped value after Bearer or Authorization is redacted', () => {
    for (const text of [
      'the bearer token is rejected with 401',
      'Bearer of bad news: the quote is stale',
      'Authorization: missing',
      'Authorization: required for this route',
      'Authorization: Bearer of bad news',
      'bearer authentication fails',
    ]) {
      assert.deepEqual(redactFeedbackText(text), { text, redacted: false }, text);
    }
  });

  it('keeps prose after a credential name and a colon: only a token-shaped value goes', () => {
    for (const text of [
      'token: expired after an hour',
      'key: the dashboard broke',
      'password: required',
      'code: 500 from the gateway',
      'secret: unknown',
    ]) {
      assert.deepEqual(redactFeedbackText(text), { text, redacted: false }, text);
    }
  });

  it('keeps the field shape around a redacted value', () => {
    assert.equal(redactFeedbackText('{"api_key": "SECRET123456"}').text, '{"api_key": "[redacted]"}');
    assert.equal(redactFeedbackText('api_key: SECRET123456').text, 'api_key: [redacted]');
    assert.equal(redactFeedbackText('`api_key=SECRET123456`').text, '`api_key=[redacted]`');
  });

  it('keeps non-credential query fields and numeric codes', () => {
    const out = redactFeedbackText('GET /api/news/v1/summarize?api_key=SECRETVALUE1&symbol=AAPL');
    assert.ok(out.text.includes('symbol=AAPL'), out.text);
    for (const text of ['exit code=1 on page=2', 'ref=main and limit=50', 'sort=key']) {
      assert.deepEqual(redactFeedbackText(text), { text, redacted: false }, text);
    }
  });

  it('leaves ordinary text, identifiers, and harmless URLs alone', () => {
    const text = 'get_market_data returned [] in wm_api_usage for https://www.worldmonitor.app/docs?page=2 at 10:00';
    assert.deepEqual(redactFeedbackText(text), { text, redacted: false });
  });
});

describe('hashes and identity', () => {
  it('fingerprint ignores case and whitespace in the summary', async () => {
    assert.equal(
      await feedbackFingerprint(report({ summary: 'Quotes  ARE empty' })),
      await feedbackFingerprint(report({ summary: 'quotes are empty' })),
    );
  });

  it('fingerprint encoding keeps field boundaries', async () => {
    const a = await feedbackFingerprint(report({ surface: { type: 'other', name: 'ab' }, summary: 'c' }));
    const b = await feedbackFingerprint(report({ surface: { type: 'other', name: 'a' }, summary: 'bc' }));
    assert.notEqual(a, b);
  });

  it('retryKey covers every stored field and the reporter', async () => {
    const base = await feedbackRetryKey(report(), 'ip:aa');
    assert.equal(await feedbackRetryKey(report(), 'ip:aa'), base);
    assert.notEqual(await feedbackRetryKey(report({ expected: 'x' }), 'ip:aa'), base);
    assert.notEqual(await feedbackRetryKey(report({ requestId: 'iad1::1' }), 'ip:aa'), base);
    assert.notEqual(await feedbackRetryKey(report(), 'ip:bb'), base);
  });

  it('keys IPv6 callers by /64 and unwraps IPv4-mapped addresses', () => {
    assert.equal(feedbackIpKey('203.0.113.7'), '203.0.113.7');
    assert.equal(feedbackIpKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(feedbackIpKey('2001:db8:1:2::1'), feedbackIpKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    assert.notEqual(feedbackIpKey('2001:db8:1:2::1'), feedbackIpKey('2001:db8:1:3::1'));
  });

  it('uses the same key as the outer per-IP limiter', () => {
    assert.equal(feedbackIpKey('2001:0db8:0001:0002::1'), feedbackIpKey('2001:db8:1:2::1'));
    assert.equal(feedbackIpKey('::ffff:c000:201'), '192.0.2.1');
    assert.notEqual(feedbackIpKey('::ffff:c000:201'), feedbackIpKey('::ffff:c000:202'));
    for (const ip of ['203.0.113.7', '::ffff:c000:201', '2001:db8:1:2::1', '64:ff9b::192.0.2.1']) {
      assert.equal(feedbackIpKey(ip), rateLimitKeyForIp(ip), ip);
    }
  });
});

type Call = { scope: string; identifier: string };
function limiter(deny: string | null = null, degraded = false): { check: FeedbackLimitCheck; calls: Call[] } {
  const calls: Call[] = [];
  const check: FeedbackLimitCheck = async (scope, limit, _window, identifier) => {
    calls.push({ scope, identifier });
    if (degraded) return { allowed: true, limit, reset: 0, degraded: true };
    return { allowed: scope !== deny, limit, reset: 0, degraded: false };
  };
  return { check, calls };
}

describe('admitFeedbackReport', () => {
  const anon = { authKind: 'anonymous' as const };
  const keyed = { authKind: 'keyed' as const, principalId: 'user_1' };
  const B = FEEDBACK_BUCKETS;

  it('charges an anonymous report to its IP and the global anonymous bucket', async () => {
    const { check, calls } = limiter();
    assert.deepEqual(await admitFeedbackReport({ kind: 'bug', caller: anon, ipKey: '1.2.3.4' }, check), { admitted: true });
    assert.deepEqual(calls, [
      { scope: B.anonymousPerIp.scope, identifier: '1.2.3.4' },
      { scope: B.globalAnonymous.scope, identifier: 'all' },
    ]);
  });

  it('charges a security report to the security bucket, never the anonymous one', async () => {
    const { check, calls } = limiter(B.globalAnonymous.scope);
    assert.deepEqual(await admitFeedbackReport({ kind: 'security', caller: anon, ipKey: '1.2.3.4' }, check), { admitted: true });
    assert.deepEqual(calls.map((c) => c.scope), [B.anonymousPerIp.scope, B.globalSecurity.scope]);
  });

  it('charges a keyed caller to its principal and the global keyed bucket', async () => {
    const { check, calls } = limiter();
    await admitFeedbackReport({ kind: 'data_quality', caller: keyed, ipKey: '1.2.3.4' }, check);
    assert.deepEqual(calls, [
      { scope: B.keyedPerPrincipal.scope, identifier: 'user_1' },
      { scope: B.globalKeyed.scope, identifier: 'all' },
    ]);
  });

  it('stops at the first denial with 429', async () => {
    const { check, calls } = limiter(B.anonymousPerIp.scope);
    assert.deepEqual(await admitFeedbackReport({ kind: 'bug', caller: anon, ipKey: '1.2.3.4' }, check), { admitted: false, status: 429 });
    assert.equal(calls.length, 1);
  });

  it('rejects with 503 when the limiter is degraded', async () => {
    const { check } = limiter(null, true);
    assert.deepEqual(await admitFeedbackReport({ kind: 'bug', caller: anon, ipKey: '1.2.3.4' }, check), { admitted: false, status: 503 });
  });

  it('rejects with 503 through the real limiter when Redis is unconfigured', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const result = await admitFeedbackReport({ kind: 'bug', caller: anon, ipKey: '1.2.3.4' });
    assert.deepEqual(result, { admitted: false, status: 503 });
  });

  it('logs a structured warning when a global bucket is exhausted', async () => {
    const lines: string[] = [];
    console.warn = (line: string) => { lines.push(line); };
    const { check } = limiter(B.globalAnonymous.scope);
    await admitFeedbackReport({ kind: 'bug', caller: anon, ipKey: '1.2.3.4' }, check);
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ event: 'agent_feedback_global_bucket_exhausted', scope: B.globalAnonymous.scope }]);
  });
});

type ConvexCall = { path: string; body: Record<string, unknown>; secret: string | null };
function convex(responses: Record<string, Response | (() => Response)>) {
  const calls: ConvexCall[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(String(init.body)), secret: new Headers(init.headers).get('x-convex-shared-secret') });
    const response = responses[path];
    if (!response) throw new Error(`unexpected ${path}`);
    return typeof response === 'function' ? response() : response.clone();
  };
  return { fetchImpl, calls };
}

const meta = { clientIp: '203.0.113.7', userAgent: 'agent/1.0' };
const notFound = () => Response.json({ found: null });

describe('submitAgentFeedback', () => {
  it('stores a redacted, hashed report without the raw IP', async () => {
    const { fetchImpl, calls } = convex({
      '/api/internal-find-feedback-retry': notFound,
      '/api/internal-submit-feedback': () => Response.json({ reportId: 'r1', status: 'received', retried: false }),
    });
    const { check } = limiter();
    const outcome = await submitAgentFeedback(
      { ...valid, expected: `key wm_${'0'.repeat(40)} should work`, requestId: 'iad1::abc' },
      { authKind: 'anonymous' },
      meta,
      { fetchImpl, checkLimit: check },
    );
    assert.deepEqual(outcome, { ok: true, reportId: 'r1', status: 'received' });
    const stored = calls[1]!;
    assert.equal(stored.secret, 'synthetic-secret');
    assert.equal(stored.body.redacted, true);
    assert.equal(stored.body.expected, 'key [redacted] should work');
    assert.match(String(stored.body.fingerprint), /^[0-9a-f]{64}$/);
    assert.match(String(stored.body.ipHash), /^[0-9a-f]{64}$/);
    assert.equal(stored.body.reporterKey, `ip:${stored.body.ipHash}`);
    assert.equal(stored.body.authKind, 'anonymous');
    assert.equal(stored.body.principalId, undefined);
    assert.ok(!JSON.stringify(stored.body).includes('203.0.113.7'));
    assert.equal(calls[0]!.body.retryKey, stored.body.retryKey);
  });

  it('redacts a credential pasted into surface even when it looks like a tool name', async () => {
    const { fetchImpl, calls } = convex({
      '/api/internal-find-feedback-retry': notFound,
      '/api/internal-submit-feedback': () => Response.json({ reportId: 'r1', status: 'received', retried: false }),
    });
    const { check } = limiter();
    const key = `wm_${'ab'.repeat(20)}`;
    const outcome = await submitAgentFeedback({ ...valid, surface: key }, { authKind: 'anonymous' }, meta, { fetchImpl, checkLimit: check });
    assert.equal(outcome.ok, true);
    const stored = calls[1]!.body;
    assert.ok(!JSON.stringify(stored).includes(key), JSON.stringify(stored));
    assert.equal(stored.surfaceType, 'other');
    assert.equal(stored.redacted, true);
  });

  it('a deleted account gets a final 403, not a retryable 503', async () => {
    const { fetchImpl } = convex({
      '/api/internal-find-feedback-retry': notFound,
      '/api/internal-submit-feedback': () => Response.json({ error: 'ACCOUNT_DELETION_IN_PROGRESS' }, { status: 403 }),
    });
    const { check } = limiter();
    const outcome = await submitAgentFeedback(valid, { authKind: 'keyed', principalId: 'user_gone' }, meta, { fetchImpl, checkLimit: check });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.equal(outcome.status, 403);
  });

  it('returns an earlier report for a retry without charging any bucket', async () => {
    const { fetchImpl, calls } = convex({
      '/api/internal-find-feedback-retry': () => Response.json({ found: { reportId: 'r0', status: 'received' } }),
    });
    const { check, calls: limitCalls } = limiter();
    const outcome = await submitAgentFeedback(valid, { authKind: 'anonymous' }, meta, { fetchImpl, checkLimit: check });
    assert.deepEqual(outcome, { ok: true, reportId: 'r0', status: 'received' });
    assert.equal(limitCalls.length, 0);
    assert.equal(calls.length, 1);
  });

  it('a keyed caller is stored under its principal', async () => {
    const { fetchImpl, calls } = convex({
      '/api/internal-find-feedback-retry': notFound,
      '/api/internal-submit-feedback': () => Response.json({ reportId: 'r1', status: 'received' }),
    });
    await submitAgentFeedback(valid, { authKind: 'keyed', principalId: 'user_1' }, meta, { fetchImpl, checkLimit: limiter().check });
    const body = calls[1]!.body;
    assert.equal(body.reporterKey, 'principal:user_1');
    assert.equal(body.principalId, 'user_1');
    assert.equal(body.ipHash, undefined);
  });

  it('refuses to store without the pepper and makes no call', async () => {
    delete process.env.USAGE_UA_PEPPER;
    const { fetchImpl, calls } = convex({});
    const outcome = await submitAgentFeedback(valid, { authKind: 'anonymous' }, meta, { fetchImpl, checkLimit: limiter().check });
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.status, 503);
    assert.equal(calls.length, 0);
  });

  it('names the invalid field and never echoes its value', async () => {
    const outcome = await submitAgentFeedback({ ...valid, requestId: 'SECRET VALUE' }, { authKind: 'anonymous' }, meta, {
      fetchImpl: convex({}).fetchImpl,
    });
    assert.ok(!outcome.ok);
    assert.equal(outcome.status, 400);
    assert.equal(outcome.field, 'requestId');
    assert.ok(!outcome.message.includes('SECRET'));
  });

  it('every security response, accepted or rejected, carries the advisory URL', async () => {
    const accepted = await submitAgentFeedback({ ...valid, kind: 'security' }, { authKind: 'anonymous' }, meta, {
      fetchImpl: convex({
        '/api/internal-find-feedback-retry': notFound,
        '/api/internal-submit-feedback': () => Response.json({ reportId: 'r1', status: 'private' }),
      }).fetchImpl,
      checkLimit: limiter().check,
    });
    assert.ok(accepted.ok);
    assert.equal(accepted.status, 'private');
    assert.equal(accepted.advisoryUrl, FEEDBACK_ADVISORY_URL);
    assert.match(accepted.notice!, /exploit details/);

    const limited = await submitAgentFeedback({ ...valid, kind: 'security' }, { authKind: 'anonymous' }, meta, {
      fetchImpl: convex({ '/api/internal-find-feedback-retry': notFound }).fetchImpl,
      checkLimit: limiter(FEEDBACK_BUCKETS.anonymousPerIp.scope).check,
    });
    assert.ok(!limited.ok);
    assert.equal(limited.status, 429);
    assert.ok(limited.message.includes(FEEDBACK_ADVISORY_URL));

    const invalid = await submitAgentFeedback({ kind: 'security', summary: '' }, { authKind: 'anonymous' }, meta, {
      fetchImpl: convex({}).fetchImpl,
    });
    assert.ok(!invalid.ok);
    assert.equal(invalid.advisoryUrl, FEEDBACK_ADVISORY_URL);
  });

  it('maps Convex outcomes: 429 stays 429, anything else is 503', async () => {
    for (const [status, expected] of [[429, 429], [400, 503], [500, 503]] as const) {
      const outcome = await submitAgentFeedback(valid, { authKind: 'anonymous' }, meta, {
        fetchImpl: convex({
          '/api/internal-find-feedback-retry': notFound,
          '/api/internal-submit-feedback': () => Response.json({ error: 'x' }, { status }),
        }).fetchImpl,
        checkLimit: limiter().check,
      });
      assert.ok(!outcome.ok);
      assert.equal(outcome.status, expected);
    }
  });

  it('fails closed when the Convex secret is unset', async () => {
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
    const { fetchImpl, calls } = convex({});
    const outcome = await submitAgentFeedback(valid, { authKind: 'anonymous' }, meta, { fetchImpl, checkLimit: limiter().check });
    assert.ok(!outcome.ok);
    assert.equal(outcome.status, 503);
    assert.equal(calls.length, 0);
  });
});
