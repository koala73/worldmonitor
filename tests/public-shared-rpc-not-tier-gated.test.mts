import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TIER_GATED_PATHS } from '../server/_shared/entitlement-check.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';

// ---------------------------------------------------------------------------
// Why this test exists
// ---------------------------------------------------------------------------
//
// `PUBLIC_SHARED_RPC_PATHS` reads like a caching concern — a small allowlist of
// caller-invariant shapes that get a shared CDN entry instead of a per-caller
// one. It is not. server/gateway.ts computes
//
//   isTierGated = !internalMcpVerified && !isPublicNoAuthRpc && ... &&
//                 getRequiredTier(pathname) !== null
//
// so `isPublicNoAuthRpc` SUPPRESSES the tier gate. A path in both sets is
// served to anonymous callers with the entitlement map silently ignored.
//
// That is exactly how `/api/military/v1/get-defense-industrial-base` (#6438)
// stayed fully public: it was added to the public set for a CDN shield, and a
// later reader of ENDPOINT_ENTITLEMENTS would have had no way to tell the gate
// never ran. A one-line addition to the public set is enough to silently
// un-paywall any Pro route, which is why this invariant is pinned structurally
// rather than left to review.
//
// The check is written against the PREDICATE, not the private path set, so a
// future per-path shape function that widens what counts as "public" is caught
// too.

/**
 * Query shapes a public route might legitimately advertise. A tier-gated path
 * must return false for EVERY one of them — the point is that no query at all
 * unlocks an anonymous read, not that one particular spelling is refused.
 */
const CANDIDATE_SHAPES = [
  '',
  '?public=1',
  '?public=1&country_code=UA',
  '?country_code=UA&public=1',
  '?iso2=DE&public=1',
  '?flow_limit=50&public=1',
  '?variant=full&lang=en&public=1',
];

describe('public shared RPC shapes never bypass a tier gate', () => {
  it('sanity: the predicate still recognises a known public shape', () => {
    // Without this, a refactor that made isPublicSharedRpcRequest return false
    // unconditionally would turn every assertion below into a vacuous pass.
    assert.equal(
      isPublicSharedRpcRequest('https://worldmonitor.app/api/forecast/v1/get-forecasts?public=1'),
      true,
      'Expected the forecast feed to still have a public shape — if this route was '
      + 'intentionally made private, update this canary to another public path.',
    );
  });

  for (const path of [...TIER_GATED_PATHS].sort()) {
    it(`${path} has no anonymous public shape`, () => {
      for (const search of CANDIDATE_SHAPES) {
        const url = `https://worldmonitor.app${path}${search}`;
        assert.equal(
          isPublicSharedRpcRequest(url),
          false,
          [
            `${path} is tier-gated in ENDPOINT_ENTITLEMENTS but ALSO matches a`,
            `public shared-RPC shape (${search || '<no query>'}).`,
            ``,
            `server/gateway.ts skips the entitlement check entirely when`,
            `isPublicSharedRpcRequest() is true, so this route is served to`,
            `anonymous callers and the tier map is dead code for it.`,
            ``,
            `Pick one: remove the path from PUBLIC_SHARED_RPC_PATHS`,
            `(src/shared/public-rpc-cache.ts), or drop its tier gate and`,
            `document that the data is deliberately free.`,
          ].join('\n'),
        );
      }
    });
  }

  // A public shape also defeats premiumFetch's Bearer attach in the browser:
  // the client would send the anonymous `public=1` URL and never carry the
  // Clerk token. Pinning the same invariant from the client's set catches a
  // path that was added to PREMIUM_RPC_PATHS but not (yet) to the tier map.
  for (const path of [...PREMIUM_RPC_PATHS].sort()) {
    it(`${path} (premium) has no anonymous public shape`, () => {
      for (const search of CANDIDATE_SHAPES) {
        assert.equal(
          isPublicSharedRpcRequest(`https://worldmonitor.app${path}${search}`),
          false,
          `${path} requires per-user pro auth but matches a public shared-RPC `
          + `shape (${search || '<no query>'}), which the gateway serves anonymously.`,
        );
      }
    });
  }
});
