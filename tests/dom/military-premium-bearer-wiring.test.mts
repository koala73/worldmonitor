/**
 * A Pro subscriber's browser must actually send credentials to the gated
 * single-aircraft route — and must NOT send them to the batch sibling that
 * deliberately stays anonymous.
 *
 * Gating the server is only half the job. `premiumFetch` attaches the Clerk
 * Bearer ONLY for paths in PREMIUM_RPC_PATHS, and only if the client was built
 * with `fetch: premiumFetch` in the first place. Miss either half and the
 * server denies paying Pro users on their own subscription.
 *
 * Both halves ride ONE `MilitaryServiceClient` instance, which is the
 * interesting part: the same client carries a gated method and an intentionally
 * anonymous one, and `premiumFetch` path-gates per request. So this asserts the
 * end-to-end effect — a real call carries Authorization on the singular path
 * and carries none on the batch path — rather than asserting the wiring exists.
 * An earlier version of this proof was a regex over the text of wingbits.ts,
 * which goes red on a harmless reformat and stays silent on dead wiring; the
 * structural half is already covered by scripts/enforce-premium-fetch.mjs.
 *
 * Mirrors tests/aviation-premium-bearer-wiring.test.mts (#7003). Lives under
 * tests/dom/ because `@/services/wingbits` reaches `@/utils` -> `utils/proxy`,
 * whose `import.meta.env.DEV` only exists in a Vite pipeline — unreachable from
 * the `tsx --test` profile that hosts the aviation equivalent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREMIUM_RPC_PATHS } from '@/shared/premium-paths';
import { _setTestProviders } from '@/services/premium-fetch';

const SINGULAR_PATH = '/api/military/v1/get-aircraft-details';
const BATCH_PATH = '/api/military/v1/get-aircraft-details-batch';
const TOKEN = 'clerk-session-token';

beforeEach(() => {
  // Stand in for a signed-in Pro session: premiumFetch resolves the Clerk token
  // through this seam. getTesterKeys must be empty, or the tester-key step
  // answers first with X-WorldMonitor-Key and never reaches the Bearer.
  _setTestProviders({
    getClerkToken: async () => TOKEN,
    isClerkUserSignedIn: async () => true,
    getTesterKeys: () => [],
  } as never);
});

afterEach(async () => {
  _setTestProviders(null as never);
  const { clearWingbitsCache } = await import('@/services/wingbits');
  clearWingbitsCache();
});

function captureFetch(seen: Array<{ url: string; auth: string | null }>, body: unknown) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    seen.push({ url, auth: headers.get('Authorization') });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('military aircraft-details premium registration', () => {
  it('registers the singular route so premiumFetch attaches the Bearer', () => {
    expect(
      PREMIUM_RPC_PATHS.has(SINGULAR_PATH),
      `${SINGULAR_PATH} spends the Wingbits credential per cache miss but is not `
      + 'registered — premiumFetch would never attach the Bearer and Pro users would get 403',
    ).toBe(true);
  });

  it('keeps the batch sibling out, so the free map stays anonymous', () => {
    expect(
      PREMIUM_RPC_PATHS.has(BATCH_PATH),
      `${BATCH_PATH} is the free map's enrichment path; registering it would `
      + 'attach Pro credentials to an intentionally anonymous route',
    ).toBe(false);
  });
});

describe('the military client attaches Pro credentials only on the gated route', () => {
  it('sends Authorization for the gated singular route', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    captureFetch(seen, { details: { icao24: 'a835af', registration: 'N123WM' }, configured: true });

    const { getAircraftDetails } = await import('@/services/wingbits');
    await getAircraftDetails('a835af');

    const call = seen.find((c) => c.url.includes('get-aircraft-details'));
    expect(call, 'expected the military client to issue a get-aircraft-details request').toBeTruthy();
    expect(
      call!.auth,
      'the military client did not attach the Pro Bearer — either the path left '
      + 'PREMIUM_RPC_PATHS or the client stopped using premiumFetch',
    ).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no Authorization for the anonymous batch route on the same client', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    captureFetch(seen, { results: {}, fetched: 0, requested: 1, configured: true });

    const { getAircraftDetailsBatch } = await import('@/services/wingbits');
    await getAircraftDetailsBatch(['aa0001']);

    const call = seen.find((c) => c.url.includes('get-aircraft-details-batch'));
    expect(call, 'expected the military client to issue a get-aircraft-details-batch request').toBeTruthy();
    expect(
      call!.auth,
      'the batch route received Pro credentials — premiumFetch stopped path-gating, '
      + 'so an intentionally anonymous route now carries a Bearer',
    ).toBe(null);
  });
});
