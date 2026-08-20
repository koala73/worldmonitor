/**
 * A Pro subscriber's browser must actually send credentials to the gated
 * aviation routes.
 *
 * Gating the server is only half the job. `premiumFetch` attaches the Clerk
 * Bearer ONLY for paths in PREMIUM_RPC_PATHS, and only if the client was built
 * with `fetch: premiumFetch` in the first place. Miss either half and the
 * server denies paying Pro users on their own subscription — which is exactly
 * what happened to /api/chat-analyst (see the comment on its registry entry),
 * and the symptom stayed hidden for two PRs.
 *
 * So this asserts the end-to-end effect — a real call through the aviation
 * service carries Authorization — rather than asserting the wiring exists.
 * Reverting either the registry entry or the premiumFetch wrapper turns it red.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { _setTestProviders } from '../src/services/premium-fetch.ts';

const METERED = [
  '/api/aviation/v1/list-airport-flights',
  '/api/aviation/v1/get-carrier-ops',
  '/api/aviation/v1/get-flight-status',
];

// Seeder-backed: already paid for by cron, must stay anonymous and free.
const SEEDED = [
  '/api/aviation/v1/list-airport-delays',
  '/api/aviation/v1/get-airport-ops-summary',
];

const TOKEN = 'clerk-session-token';
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Stand in for a signed-in Pro session: premiumFetch step 3 resolves the
  // Clerk token through this seam. getTesterKeys must be empty, or step 2
  // would answer first with X-WorldMonitor-Key and never reach the Bearer.
  _setTestProviders({
    getClerkToken: async () => TOKEN,
    isClerkUserSignedIn: async () => true,
    getTesterKeys: () => [],
  } as never);
});

afterEach(() => {
  mock.restoreAll();
  _setTestProviders(null as never);
  globalThis.fetch = originalFetch;
});

describe('aviation premium routes are registered', () => {
  for (const path of METERED) {
    it(`${path} is in PREMIUM_RPC_PATHS`, () => {
      assert.ok(
        PREMIUM_RPC_PATHS.has(path),
        `${path} spends money per request but is not registered — premiumFetch `
        + 'would never attach the Bearer and Pro users would get 403',
      );
    });
  }

  for (const path of SEEDED) {
    it(`${path} stays out of PREMIUM_RPC_PATHS`, () => {
      assert.ok(
        !PREMIUM_RPC_PATHS.has(path),
        `${path} is served from the cron-seeded snapshot; gating it costs the `
        + 'free map its airport-delay layer and saves no AviationStack calls',
      );
    });
  }
});

describe('the aviation client attaches Pro credentials on metered routes', () => {
  it('sends Authorization for a gated route', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      seen.push({ url, auth: headers.get('Authorization') });
      return new Response(JSON.stringify({ flights: [], totalAvailable: 0, source: 'aviationstack', updatedAt: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const { fetchAirportFlights } = await import('../src/services/aviation/index.ts');
    await fetchAirportFlights('IST', 'departure', 30);

    const call = seen.find((c) => c.url.includes('list-airport-flights'));
    assert.ok(call, 'expected the aviation client to issue a list-airport-flights request');
    assert.equal(
      call.auth, `Bearer ${TOKEN}`,
      'the aviation client did not attach the Pro Bearer — either the path left '
      + 'PREMIUM_RPC_PATHS or the client stopped using premiumFetch',
    );
  });
});
