import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_HISTORY_KEY_PREFIX,
} from '../server/worldmonitor/resilience/v1/_shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// Phase 1 T1.9 cache-key / health-registry sync guard.
//
// If a future PR bumps any of the resilience cache key constants in
// server/worldmonitor/resilience/v1/_shared.ts (e.g. resilience:score:v7
// becomes v8), the api/health.js SEED_META / KEY_TO_DOMAIN registry MUST
// be updated in the same PR or health probes will silently watch the
// wrong key and stop paging on real staleness.
//
// This test reads api/health.js as text and asserts the ranking cache
// key string (the only resilience key currently tracked in health) is
// literally present. When new resilience keys are added to health, add
// their assertions here too.
//
// Rationale: api/health.js is a plain .js file with hand-maintained
// string literals for the KEY_TO_DOMAIN mapping and the SEED_META
// registry. Those string literals are the single source of truth for
// what the health probe watches, and they are copy-pasted (not
// imported) from the server-side TypeScript constants. A literal text
// match is the cheapest possible drift guard.

describe('resilience cache-key health-registry sync (T1.9)', () => {
  const healthText = readFileSync(join(repoRoot, 'api/health.js'), 'utf-8');

  it('RESILIENCE_RANKING_CACHE_KEY literal appears in api/health.js', () => {
    assert.ok(
      healthText.includes(`'${RESILIENCE_RANKING_CACHE_KEY}'`) ||
        healthText.includes(`"${RESILIENCE_RANKING_CACHE_KEY}"`),
      `api/health.js must reference ${RESILIENCE_RANKING_CACHE_KEY} in KEY_TO_DOMAIN or SEED_META. Did you bump the key in _shared.ts without updating health?`,
    );
  });

  it('RESILIENCE_SCORE_CACHE_PREFIX matches expected resilience:score:v<n>: shape', () => {
    // The score key is per-country (prefix + ISO2), so we do not expect
    // the full key literal in health.js. Guard: the prefix string
    // matches the declared resilience:score:v<n>: shape so a typo or an
    // accidental rename is caught at test time.
    const versionMatch = /^resilience:score:v(\d+):$/.exec(RESILIENCE_SCORE_CACHE_PREFIX);
    assert.ok(
      versionMatch,
      `RESILIENCE_SCORE_CACHE_PREFIX must match resilience:score:v<n>: shape, got ${RESILIENCE_SCORE_CACHE_PREFIX}`,
    );
  });

  it('RESILIENCE_HISTORY_KEY_PREFIX matches expected resilience:history:v<n>: shape', () => {
    const versionMatch = /^resilience:history:v(\d+):$/.exec(RESILIENCE_HISTORY_KEY_PREFIX);
    assert.ok(
      versionMatch,
      `RESILIENCE_HISTORY_KEY_PREFIX must match resilience:history:v<n>: shape, got ${RESILIENCE_HISTORY_KEY_PREFIX}`,
    );
  });
});
