import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../shared/bootstrap-tier-keys.js';

/**
 * Market breadth is served from a seeded Redis key through the bootstrap
 * payload. The registry below is the contract the seeder writes to and the
 * client reads from — a key or tier that disagrees silently serves nothing.
 *
 * Panel rendering, RPC wiring, and proto registration are covered by executing
 * the code: the dashboard boots in e2e/variant-live-smoke.spec.ts, and the
 * generated client types make an unregistered RPC a typecheck failure.
 */
describe('market breadth bootstrap registration', () => {
  it('publishes the breadth history under its versioned cache key', () => {
    assert.equal(BOOTSTRAP_CACHE_KEYS.breadthHistory, 'market:breadth-history:v1');
  });

  it('loads breadth history in the slow tier, not the boot-critical path', () => {
    // 252 days of three series is far too large for the fast tier, which the
    // CDN serves on every origin miss.
    assert.equal(BOOTSTRAP_TIERS.breadthHistory, 'slow');
  });

  it('keeps every bootstrap key it registers assigned to a tier', () => {
    for (const name of Object.keys(BOOTSTRAP_CACHE_KEYS)) {
      assert.ok(BOOTSTRAP_TIERS[name], `${name} has a cache key but no bootstrap tier`);
    }
  });
});
