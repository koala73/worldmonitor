// Plan 2026-04-26-002 §U8 — methodology-doc parity test.
//
// Asserts that the load-bearing prose claims in
// docs/methodology/country-resilience-index.mdx match the actual
// constants the code ships with. Catches accidental doc drift when
// someone bumps a cache prefix, adds/removes a dimension, or changes
// a domain weight without updating the doc in lockstep — the
// alternative is finding out from a Pro user that the doc says v17
// when production runs v19.
//
// Coverage is intentionally surgical: we don't try to parse every
// table in the doc (markdownlint already handles structural drift,
// and the existing docs/methodology lint pass catches most of it).
// We assert the few facts that are most likely to silently rot:
//
// 1. Cache prefixes named in the changelog match `_shared.ts`.
// 2. The "6 domains × 19 dimensions" claim matches
//    `RESILIENCE_DOMAIN_ORDER` and `RESILIENCE_DIMENSION_ORDER`.
// 3. Each domain's weight in the Domains table matches
//    `getResilienceDomainWeight(...)`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_HISTORY_KEY_PREFIX,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import {
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DOMAIN_ORDER,
  RESILIENCE_RETIRED_DIMENSIONS,
  type ResilienceDomainId,
  getResilienceDomainWeight,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(here, '../docs/methodology/country-resilience-index.mdx');
const docText = readFileSync(DOC_PATH, 'utf8');

describe('methodology doc parity (Plan 2026-04-26-002 §U8)', () => {
  it('cache prefixes named in the changelog match the live constants', () => {
    // The v17 changelog narrates the bumps. We don't require every
    // historical version to appear in the doc, only that the CURRENT
    // value in `_shared.ts` is somewhere in the doc text.
    const scoreVersion = RESILIENCE_SCORE_CACHE_PREFIX;       // e.g. 'resilience:score:v17:'
    const rankingKey = RESILIENCE_RANKING_CACHE_KEY;          // e.g. 'resilience:ranking:v17'
    const historyPrefix = RESILIENCE_HISTORY_KEY_PREFIX;      // e.g. 'resilience:history:v12:'

    assert.ok(
      docText.includes(scoreVersion.replace(/:$/, '')) || docText.includes(scoreVersion),
      `methodology doc must reference current score cache prefix "${scoreVersion}". ` +
      'Bump the doc when bumping the cache.',
    );
    assert.ok(
      docText.includes(rankingKey),
      `methodology doc must reference current ranking cache key "${rankingKey}". ` +
      'Bump the doc when bumping the cache.',
    );
    assert.ok(
      docText.includes(historyPrefix.replace(/:$/, '')) || docText.includes(historyPrefix),
      `methodology doc must reference current history key prefix "${historyPrefix}". ` +
      'Bump the doc when bumping the cache.',
    );
  });

  it('domain count claimed in prose matches RESILIENCE_DOMAIN_ORDER', () => {
    const expectedCount = RESILIENCE_DOMAIN_ORDER.length;
    // The doc says "6 domains" in multiple places. We require at least
    // one mention of the current count to stop a future "we now have 7
    // domains" code change from leaving the doc claiming 6.
    const re = new RegExp(`${expectedCount}\\s+domains?`);
    assert.ok(
      re.test(docText),
      `methodology doc must mention "${expectedCount} domains" (current RESILIENCE_DOMAIN_ORDER length). ` +
      'If you added/removed a domain, update the prose.',
    );
  });

  it('active dimension count claimed in prose matches (ORDER − RETIRED) AND no stale counts persist', () => {
    // The doc says "20 active dimensions" — i.e. ACTIVE dimensions,
    // excluding structurally-retired ones (fuelStockDays,
    // reserveAdequacy) that remain in RESILIENCE_DIMENSION_ORDER for
    // schema continuity but pin at coverage=0 / imputationClass=null.
    // The right denominator for the doc's headline claim is
    // (total − retired).
    const activeCount = RESILIENCE_DIMENSION_ORDER.length - RESILIENCE_RETIRED_DIMENSIONS.size;
    // Allow "20 dimensions" or "20 active dimensions" — both mean the same thing.
    const re = new RegExp(`${activeCount}\\s+(?:active\\s+)?dimensions?`);
    assert.ok(
      re.test(docText),
      `methodology doc must mention "${activeCount} dimensions" or "${activeCount} active dimensions" (RESILIENCE_DIMENSION_ORDER ${RESILIENCE_DIMENSION_ORDER.length} minus RESILIENCE_RETIRED_DIMENSIONS ${RESILIENCE_RETIRED_DIMENSIONS.size}). ` +
      'If you added/removed/retired a dimension, update the prose.',
    );

    // Tighten: stale CURRENT-total claims in older changelog narrative
    // contradict the live count and confuse readers. The previous
    // version of this test allowed any mention of "20 dimensions" to
    // pass even if a contradictory "19 dimensions" still appeared in
    // older prose. Now reject any mention in the plausible-current-
    // total band [15, 25] that doesn't equal activeCount or totalCount.
    // Numbers outside that band (5, 6, 13) are legitimate sub-pillar /
    // historical-version mentions and stay untouched.
    const totalCount = RESILIENCE_DIMENSION_ORDER.length;
    const PLAUSIBLE_CURRENT_TOTAL_MIN = 15;
    const PLAUSIBLE_CURRENT_TOTAL_MAX = 25;
    const dimensionMentions = [...docText.matchAll(/(\d+)\s+(?:active\s+)?dimensions?/g)];
    const stale = dimensionMentions
      .map((m) => Number(m[1]))
      .filter((n) =>
        n !== activeCount &&
        n !== totalCount &&
        n >= PLAUSIBLE_CURRENT_TOTAL_MIN &&
        n <= PLAUSIBLE_CURRENT_TOTAL_MAX,
      );
    assert.deepEqual(stale, [],
      `methodology doc contains plausible-current-total dimension counts that contradict the live count: ${stale.join(', ')}. ` +
      `Current active count is ${activeCount} (or total ${totalCount} if including retired). ` +
      'Update stale claims, or move to historical-state phrasing if they describe a past version.',
    );
  });

  it('Domains table weights match getResilienceDomainWeight()', () => {
    // The Domains and Weights table has rows like:
    //   | Economic | `economic` | 0.17 | …
    // Parse each domain's row and assert the weight column matches code.
    for (const domainId of RESILIENCE_DOMAIN_ORDER) {
      const expectedWeight = getResilienceDomainWeight(domainId);
      // Find the row containing the domain id in backticks. The numeric
      // weight is the third pipe-separated cell after the id.
      const rowRe = new RegExp(`\\|[^\\n]*\\\`${escapeRegex(domainId)}\\\`[^\\n]*\\|\\s*([0-9.]+)\\s*\\|`);
      const match = docText.match(rowRe);
      assert.ok(
        match,
        `Domains table row for "${domainId}" not found. Expected a row with \`${domainId}\` and weight ${expectedWeight}.`,
      );
      const docWeight = Number(match![1]);
      assert.ok(
        Math.abs(docWeight - expectedWeight) < 0.001,
        `Domains table claims weight ${docWeight} for "${domainId}", code has ${expectedWeight}. ` +
        'Update the doc when changing RESILIENCE_DOMAIN_WEIGHTS.',
      );
    }
  });

  it('Domains table weights sum to 1.00 (sanity check on the parity test itself)', () => {
    // If the parity assertion above ever silently passes 0 / 0, this
    // catches it: the live weights MUST sum to 1.00 by construction.
    const sum = RESILIENCE_DOMAIN_ORDER
      .map((id: ResilienceDomainId) => getResilienceDomainWeight(id))
      .reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(sum - 1.0) < 0.001,
      `Domain weights must sum to 1.00, got ${sum.toFixed(4)}. The parity test above is built on this invariant.`,
    );
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
