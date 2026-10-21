// U4 from docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md
//
// LLM classify-cache upgrade cap. Caps the cache-driven `level` upgrade at
// +2 tiers above the keyword classification so a poisoned cache entry can't
// promote info-keyword static-page titles past medium (info+2=medium).
// Legitimate keyword=medium → LLM=critical upgrades (e.g., "Markets crash"
// in MEDIUM_KEYWORDS) remain reachable because medium+2=critical. The
// bounded loss is keyword=low → LLM=critical, which caps at high
// (low+2=high) and is logged on every cap-fire.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const { capLlmUpgrade } = __testing__;

describe('capLlmUpgrade — within cap (no change)', () => {
  it('keyword=high + LLM=high → applies high (no cap fired)', () => {
    assert.equal(capLlmUpgrade('high', 'high'), 'high');
  });

  it('keyword=medium + LLM=critical → applies critical (medium+2 = critical, allowed)', () => {
    // Real-world case: keyword=medium covers "market crash", "sanctions",
    // "earthquake" etc. (MEDIUM_KEYWORDS in _classifier.ts). LLM correctly
    // upgrading these to critical after fuller context must survive.
    assert.equal(capLlmUpgrade('medium', 'critical'), 'critical');
  });

  it('keyword=low + LLM=high → applies high (low+2 = high, within cap)', () => {
    // Most legitimate keyword=low → LLM upgrade cases. low covers "election",
    // "treaty", "summit", "agreement" — LLM picking up urgency context that
    // promotes to high (e.g., "Treaty signed amid escalating tensions").
    assert.equal(capLlmUpgrade('low', 'high'), 'high');
  });
});

describe('capLlmUpgrade — cap fires on > +2 jumps', () => {
  it('keyword=low + LLM=critical → caps at high (low+2 = high, NOT critical)', () => {
    // Keyword=low → LLM=critical implies the keyword set is missing
    // taxonomy terms; the cap forces that conversation rather than
    // letting the cache silently paper over the gap. Loss is bounded
    // because keyword=low is rare in practice (most upgrade-worthy
    // headlines hit LOW_KEYWORDS only when the LLM has additional context
    // the keyword set genuinely doesn't capture).
    assert.equal(capLlmUpgrade('low', 'critical'), 'high');
  });
});

describe('capLlmUpgrade — Pentagon static-page contamination case (cap fires)', () => {
  it('keyword=info + LLM=critical → caps at medium (info+2 = medium)', () => {
    // The exact failure shape that put "About Section 508" on the brief.
    // Keyword classifier returns info (no-match fallback at confidence 0.3).
    // Cache hit said critical or high. Cap forces medium.
    assert.equal(capLlmUpgrade('info', 'critical'), 'medium');
  });

  it('keyword=info + LLM=high → caps at medium (info+2 = medium)', () => {
    assert.equal(capLlmUpgrade('info', 'high'), 'medium');
  });

  it('keyword=info + LLM=medium → applies medium (within cap, no fire)', () => {
    assert.equal(capLlmUpgrade('info', 'medium'), 'medium');
  });

  it('keyword=info + LLM=low → applies low (LLM downgrade preserved)', () => {
    assert.equal(capLlmUpgrade('info', 'low'), 'low');
  });

  it('keyword=info + LLM=info → applies info (no change)', () => {
    assert.equal(capLlmUpgrade('info', 'info'), 'info');
  });
});

describe('capLlmUpgrade — keyword=critical edge case', () => {
  it('keyword=critical + LLM=high → applies high (downgrade allowed; cap not relevant)', () => {
    // The 0.9-confidence guard at line 480 of list-feed-digest.ts already
    // skips the cache for keyword=critical (confidence=0.9), so this case
    // doesn't fire in practice. Test exists to lock behavior if the guard
    // is ever loosened.
    assert.equal(capLlmUpgrade('critical', 'high'), 'high');
  });

  it('keyword=critical + LLM=critical → applies critical', () => {
    assert.equal(capLlmUpgrade('critical', 'critical'), 'critical');
  });
});

describe('capLlmUpgrade — defensive on malformed LLM levels', () => {
  it('falls back to keyword level when LLM level is unknown string', () => {
    // The cache's hit.level should always be one of the canonical 5, but
    // defensive: an unrecognized value (older schema, fuzzed input)
    // must not throw — falls back to the keyword level.
    assert.equal(capLlmUpgrade('low', 'unknown'), 'low');
  });

  it('falls back to keyword level on empty string', () => {
    assert.equal(capLlmUpgrade('medium', ''), 'medium');
  });

  it('falls back to keyword level on case-mismatched LLM value', () => {
    // RANK_TO_LEVEL is lowercase canonical; the cache writer in classify-event
    // also writes lowercase, so this is defense against a regression.
    assert.equal(capLlmUpgrade('low', 'CRITICAL'), 'low');
  });
});
