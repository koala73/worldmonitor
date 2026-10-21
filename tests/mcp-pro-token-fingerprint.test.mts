import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { HMAC_SECRET, PRO_TOKEN_ID, PRO_USER_ID, makeProDeps } from './helpers/mcp-pro-deps.mjs';

// ─── WORLDMONITOR-ZR / T8: the Pro-token gate needs an explicit fingerprint ──
//
// Both `api/mcp` capture sites in the Pro-token gate run inside the minified
// edge bundle, whose frames are all anonymous `(vc/edge/function` with no
// source map and `in_app=false`. Sentry's default grouping keys on that stack,
// so every capture sharing it collapses into the WORLDMONITOR-T8 catch-all —
// the exact pathology `api/mcp/error-fingerprint.ts` was written to close.
//
// Observed 2026-09-11: `Pro MCP token validation temporarily unavailable` was
// live in TWO groups at once. WORLDMONITOR-ZR held six events and was resolved
// 2026-09-04; the identical message kept firing into T8 (three events that day
// alone), so the condition read as drained while it was still occurring. That
// defeats the stated intent of PR #7601 (`aacb0b7e1`), whose commit message
// says a sustained Convex outage "still escalates by volume" — volume split
// across two groups, one of them a permanently noisy catch-all, escalates
// nothing.
//
// dispatch.ts already fingerprints its two capture sites; auth.ts never did.
// These tests pin BOTH arms of the gate:
//   - the fail-soft `transient` verdict (warning), and
//   - the thrown-validator `catch` (error, an unexpected defect).
// They must carry DISTINCT fingerprints. The code comment on the transient
// branch is explicit that the two arms are different failure classes ("The
// `catch` above stays at `error`: a THROWN validator is an unexpected defect,
// not this fail-soft path"), so a shared fingerprint would re-merge exactly the
// distinction that comment protects.
//
// `captureSilentError` no-ops unless `_sentry-common.js` parsed a DSN in its
// import-time `parseDsn()` IIFE, so the DSN is set BEFORE the dynamic import
// below. Each `*.test.mts` runs in its own `tsx --test` subprocess, so this DSN
// never leaks into suites that import auth.ts statically.

const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_CONTEXT;

process.env.VITE_SENTRY_DSN = 'https://testpublickey@sentry.test/12345';
process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
process.env.MCP_TELEMETRY = 'false';
process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
process.env.CONVEX_SERVER_SHARED_SECRET = 'test-convex-shared-secret';

const ENVELOPE_URL_PREFIX = 'https://sentry.test/api/12345/envelope';

const { validateProMcpAuthorization } = await import('../api/mcp/auth.ts');

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
});

const PRO_CONTEXT = { kind: 'pro', userId: PRO_USER_ID, mcpTokenId: PRO_TOKEN_ID } as never;
const RESOURCE_METADATA_URL = 'https://worldmonitor.app/.well-known/oauth-protected-resource';

/**
 * Drive the Pro-token gate against a stubbed `validateProMcpToken` and return
 * every Sentry event it delivered. Awaiting the capture promise matters: the
 * helper only routes through `ctx.waitUntil` when a ctx is supplied, so the
 * collected promises are awaited here to avoid asserting on an empty array.
 */
async function captureEvents(
  validateProMcpToken: () => Promise<unknown>,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  const pending: Array<Promise<unknown>> = [];

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
    if (url.startsWith(ENVELOPE_URL_PREFIX)) {
      // Envelope format: header line, item header line, item payload line.
      const lines = String(init?.body ?? '').trim().split('\n');
      events.push(JSON.parse(lines[lines.length - 1]));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof globalThis.fetch;

  const { deps } = makeProDeps({ validateProMcpToken });
  await validateProMcpAuthorization(
    PRO_CONTEXT,
    deps as never,
    RESOURCE_METADATA_URL,
    {},
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); } },
  );
  await Promise.all(pending);
  return events;
}

function fingerprintOf(event: Record<string, unknown>): unknown {
  return event.fingerprint;
}

describe('Pro MCP token gate — Sentry grouping fingerprint', () => {
  it('fingerprints the fail-soft transient verdict so it cannot merge into the T8 catch-all', async () => {
    const events = await captureEvents(async () => ({ ok: 'transient' }));

    assert.equal(events.length, 1, 'the transient verdict captures exactly one event');
    const [event] = events;
    assert.equal(
      (event.exception as { values: Array<{ value: string }> }).values[0].value,
      'Pro MCP token validation temporarily unavailable',
      'positive control — the DSN activated and this is the transient-arm capture',
    );
    assert.equal(event.level, 'warning', 'PR #7601 downgraded this arm; it must stay warning');
    assert.deepEqual(
      fingerprintOf(event),
      ['mcp-pro-token-validate', 'transient', 'Error'],
      'without an explicit fingerprint Sentry groups on the anonymous edge stack and re-merges into T8',
    );
  });

  it('fingerprints the thrown-validator defect arm separately from the fail-soft arm', async () => {
    const events = await captureEvents(async () => {
      throw new TypeError('validator exploded');
    });

    assert.equal(events.length, 1, 'the thrown validator captures exactly one event');
    const [event] = events;
    assert.notEqual(event.level, 'warning', 'a thrown validator is a defect, not the fail-soft path');
    assert.deepEqual(
      fingerprintOf(event),
      ['mcp-pro-token-validate', 'threw', 'TypeError'],
      'the defect arm keys on the error name so distinct runtime faults stay separable',
    );
  });

  it('keeps the two arms in different Sentry groups', async () => {
    const [transient] = await captureEvents(async () => ({ ok: 'transient' }));
    const [threw] = await captureEvents(async () => {
      throw new TypeError('validator exploded');
    });

    // Assert both are PRESENT before comparing them. `notDeepEqual` alone is
    // satisfied by `undefined !== [...]`, so a missing fingerprint on either
    // arm would pass this test vacuously — caught by mutation-testing this
    // file against a dropped fingerprint.
    assert.ok(Array.isArray(fingerprintOf(transient)), 'the transient arm must carry a fingerprint');
    assert.ok(Array.isArray(fingerprintOf(threw)), 'the defect arm must carry a fingerprint');
    assert.notDeepEqual(
      fingerprintOf(transient),
      fingerprintOf(threw),
      'a shared fingerprint would re-merge the defect arm into the fail-soft arm — the exact '
      + 'distinction the transient branch comment protects',
    );
  });
});
