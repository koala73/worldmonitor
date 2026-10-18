// The Reddit social-velocity seed runs every 3 hours (SOCIAL_VELOCITY_INTERVAL_MS
// in scripts/ais-relay.cjs). The MCP envelope used to flag it stale after 30
// minutes, so get_social_velocity answered stale:true for most of every healthy
// cycle while /api/health called the same seed-meta key fresh. The two surfaces
// read one key and must agree on its budget.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';
import { evaluateFreshness } from '../api/mcp/freshness.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const SEED_META_KEY = 'seed-meta:intelligence:social-reddit';
const tool = CACHE_TOOLS.find((t) => t.name === 'get_social_velocity');
const check = tool._freshnessChecks.find((c) => c.key === SEED_META_KEY);

describe('get_social_velocity freshness', () => {
  it('uses the same staleness budget as /api/health for the Reddit seed', () => {
    assert.equal(__testing__.SEED_META.socialVelocity.key, SEED_META_KEY);
    assert.equal(check.maxStaleMin, __testing__.SEED_META.socialVelocity.maxStaleMin);
  });

  it('reports a seed from the previous 3-hour cycle as fresh and a missed-cycles seed as stale', () => {
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    const hoursAgo = (h) => ({ fetchedAt: now - h * 3_600_000 });
    assert.equal(evaluateFreshness([check], [hoursAgo(2.5)], now).stale, false);
    assert.equal(evaluateFreshness([check], [hoursAgo(10)], now).stale, true);
  });
});
