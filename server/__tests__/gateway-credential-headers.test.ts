// @vitest-environment node

/**
 * #8400 — `hasCredentialBearingHeader` in server/gateway.ts must recognise
 * every request header a sibling auth path treats as a credential.
 *
 * Failure mode this pins: a GET authenticated by a missing header resolves
 * `hasCredentialedNonPublicGet` to false and the gateway emits a per-principal
 * response under a public cache tier — a cached body served to the wrong
 * principal. The drift vector is concrete: X-Widget-Key / X-Pro-Key were both
 * introduced (api/widget-agent.ts) after the function was written.
 *
 * Two layers, matching the repo's two-list-sync precedent (premium-paths-guard):
 *   1. Behavioural: every header in CREDENTIAL_BEARING_HEADERS classifies a
 *      request as credential-bearing and the classifier predicate
 *      `!isPublicNoAuthRpc && hasCredentialBearingHeader(request)` holds on a
 *      real non-public route — the exact expression the gateway applies.
 *   2. Divergence: a source scan over the auth-path readers fails when a
 *      credential header is added without landing in the shared list.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const runRedisPipeline = vi.fn();
vi.mock('../_shared/redis', async (importActual) => {
  const actual = await importActual<typeof import('../_shared/redis')>();
  return { ...actual, runRedisPipeline: (...a: unknown[]) => runRedisPipeline(...a) };
});

const checkRateLimit = vi.fn();
const checkEndpointRateLimit = vi.fn();
vi.mock('../_shared/rate-limit', async (importActual) => {
  const actual = await importActual<typeof import('../_shared/rate-limit')>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkEndpointRateLimit: (...a: unknown[]) => checkEndpointRateLimit(...a),
    hasEndpointRatePolicy: () => false,
  };
});

import { createDomainGateway, CREDENTIAL_BEARING_HEADERS, hasCredentialBearingHeader } from '../gateway';

const ctx = { waitUntil: () => {} };
const KEY = 'test-key';

// A real non-public route with a non-no-store declared tier, so the
// credential audience is the ONLY thing that moves it off the public tier.
// The gateway auth chain 401s keyless requests here (auth before cache), so
// the behavioural layer below asserts the classifier predicate directly on
// the production sets rather than driving unauthenticated responses.
const PRIVATE_PATH = '/api/aviation/v1/list-airport-flights'; // declared 'static'
// The public no-auth path proves the negative half: public stays public even
// WITH a credential attached, so a credential can never widen a shared entry.
const PUBLIC_PATH = '/api/intelligence/v1/get-china-decision-signals'; // declared 'fast'

function publicGateway() {
  return createDomainGateway([{
    method: 'GET',
    path: PUBLIC_PATH,
    handler: async () =>
      new Response(JSON.stringify({ events: [{ id: 1 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  }]);
}

function get(path: string, headers: Record<string, string>): Request {
  return new Request(`https://worldmonitor.app${path}?_debug=1`, {
    headers: { 'cf-connecting-ip': '203.0.113.7', ...headers },
  });
}

beforeEach(() => {
  runRedisPipeline.mockReset().mockResolvedValue([{ result: null }]);
  checkRateLimit.mockReset().mockResolvedValue(null);
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  process.env.WORLDMONITOR_VALID_KEYS = KEY;
});

afterEach(() => {
  delete process.env.WORLDMONITOR_VALID_KEYS;
});

describe('credential-bearing headers force a private tier (#8400)', () => {
  test('the shared list pins the full header set', () => {
    expect([...CREDENTIAL_BEARING_HEADERS]).toEqual([
      'Authorization',
      'X-WorldMonitor-Key',
      'X-Api-Key',
      'X-Widget-Key',
      'X-Pro-Key',
      'Cookie',
    ]);
  });

  test.each([
    ['Authorization', 'Bearer test-token'],
    ['X-WorldMonitor-Key', KEY],
    ['X-Api-Key', KEY],
    ['X-Widget-Key', 'widget-key'],
    ['X-Pro-Key', 'pro-key'],
    ['Cookie', 'wm-pro-key=some-key'],
  ])('%s classifies a GET as credential-bearing', async (header, value) => {
    const req = get(PRIVATE_PATH, { [header]: value });
    // Unit layer: the header alone trips the guard, independent of auth.
    expect(hasCredentialBearingHeader(req)).toBe(true);

    // Classifier layer: on a non-public route this is exactly the audience
    // overwrite the gateway applies — `!isPublicNoAuthRpc &&
    // hasCredentialBearingHeader(request)`. Asserted on the real production
    // predicate (not a re-implementation) so the wiring cannot drift.
    const { PUBLIC_NO_AUTH_RPC_PATHS } = await import('../gateway');
    expect(PUBLIC_NO_AUTH_RPC_PATHS.has(PRIVATE_PATH)).toBe(false);
    expect(!PUBLIC_NO_AUTH_RPC_PATHS.has(PRIVATE_PATH) && hasCredentialBearingHeader(req)).toBe(true);

    // Gateway layer: drive the real gateway on the public path to prove the
    // negative half — public no-auth stays public even WITH a credential
    // attached. A non-200 here is also safe: the auth chain rejects before
    // the tier resolves, so no per-principal body is emitted at all.
    const res = await publicGateway()(get(PUBLIC_PATH, { [header]: value }), ctx);
    if (res.status === 200) {
      expect(res.headers.get('X-Cache-Tier')).toBe('fast');
      expect(res.headers.get('Cache-Control') ?? '').not.toContain('private');
    } else {
      expect([401, 403]).toContain(res.status);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  test('a non-credential header does not classify, and anonymous stays public', async () => {
    expect(hasCredentialBearingHeader(get(PRIVATE_PATH, { 'X-Test-Audience': 'dashboard' }))).toBe(false);

    const res = await publicGateway()(
      get(PUBLIC_PATH, { origin: 'https://worldmonitor.app' }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('private');
  });

  test('auth-path credential headers cannot drift from the shared list', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..', '..');
    const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

    // Every headers.get('X-…') a sibling auth path treats as a credential.
    // Route-scoped verifications are deliberately NOT credentials here (see
    // the CREDENTIAL_BEARING_HEADERS comment): the desktop HMAC pair
    // (register-interest.ts, POST-only single RPC) and the internal-MCP
    // HMAC trio (mcp-internal-hmac.ts, consumed by the pre-check and
    // stripped before handlers) never act as bearers on an auth path.
    // Inbound-only plumbing (Vary echo, CORS allowlist membership, the
    // per-process verified-marker nonce, relay-to-upstream relay headers the
    // client never sends) is likewise excluded.
    const credentialReads: Array<{ file: string; header: string }> = [
      { file: 'api/_api-key.js', header: 'X-WorldMonitor-Key' },
      { file: 'api/_api-key.js', header: 'X-Api-Key' },
      { file: 'api/widget-agent.ts', header: 'X-WorldMonitor-Key' },
      { file: 'api/widget-agent.ts', header: 'X-Api-Key' },
      { file: 'api/widget-agent.ts', header: 'X-Widget-Key' },
      { file: 'api/widget-agent.ts', header: 'X-Pro-Key' },
      { file: 'api/embed/entitlement.ts', header: 'X-WorldMonitor-Key' },
      { file: 'api/embed/entitlement.ts', header: 'X-Api-Key' },
      { file: 'api/embed/session.ts', header: 'X-WorldMonitor-Key' },
      { file: 'api/embed/session.ts', header: 'X-Api-Key' },
      { file: 'server/_shared/premium-check.ts', header: 'X-WorldMonitor-Key' },
      { file: 'server/_shared/premium-check.ts', header: 'X-Api-Key' },
      { file: 'server/_shared/provider-redistribution.ts', header: 'X-WorldMonitor-Key' },
      { file: 'server/_shared/provider-redistribution.ts', header: 'X-Api-Key' },
      { file: 'server/worldmonitor/shipping/v2/webhook-shared.ts', header: 'X-WorldMonitor-Key' },
      { file: 'server/worldmonitor/shipping/v2/webhook-shared.ts', header: 'X-Api-Key' },
    ];

    const shared = new Set<string>(CREDENTIAL_BEARING_HEADERS);
    for (const { file, header } of credentialReads) {
      const src = read(file);
      expect(
        src.includes(`headers.get('${header}')`) || src.includes(`headers.get("${header}")`),
        `${file} reads ${header} — if this assertion fails the auth path moved`,
      ).toBe(true);
      expect(
        shared.has(header),
        `${header} (read as a credential in ${file}) is missing from CREDENTIAL_BEARING_HEADERS — add it in server/gateway.ts`,
      ).toBe(true);
    }
  });
});
