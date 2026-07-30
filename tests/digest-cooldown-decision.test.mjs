// Sprint 1 / U5 — pure cooldown decision tests. The decision function
// drives Sprint 2's enforce-mode behavior; these tests lock in the
// table cells, the evolution-bypass triggers, and the
// fail-closed-on-missing-classification telemetry shape that U6 replay
// will read.
//
// Test layout:
//   1. classifyStub — every rule path with its discriminating input
//   2. evaluateCooldown — happy/edge/error matrix per the plan U5 list
//   3. Mode='off' contract (decision === null per
//      feedback_gate_on_ground_truth_not_configured_state)
//   4. Cooldown table sanity (the cells the implementation depends on)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStub,
  evaluateCooldown,
  REASON,
  __COOLDOWN_TABLE,
} from '../scripts/lib/digest-cooldown-decision.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = 1_777_000_000_000; // 2026-04-23-ish, deterministic

describe('classifyStub — Rule 1: Analysis domains', () => {
  it('exact match: usni.org → analysis', () => {
    const r = classifyStub({ sourceDomain: 'usni.org', headline: 'Doctrine essay', severity: 'high' });
    assert.equal(r.type, 'analysis');
    assert.equal(r.classificationMissing, false);
  });

  it('exact match: csis.org, brookings.edu, nature.com, sciencemag.org → analysis', () => {
    for (const d of ['csis.org', 'brookings.edu', 'nature.com', 'sciencemag.org']) {
      const r = classifyStub({ sourceDomain: d, severity: 'high' });
      assert.equal(r.type, 'analysis', `${d} should classify as analysis`);
    }
  });

  it('suffix match: any *.edu → analysis', () => {
    for (const d of ['mit.edu', 'stanford.edu', 'foo.bar.edu']) {
      assert.equal(classifyStub({ sourceDomain: d, severity: 'high' }).type, 'analysis');
    }
  });

  it('case-insensitive on domain', () => {
    assert.equal(classifyStub({ sourceDomain: 'USNI.ORG', severity: 'high' }).type, 'analysis');
  });

  it('analysis domain wins even when headline matches single-corp regex', () => {
    // A .edu publishing a "beat forecast" headline is still analysis,
    // not corporate earnings. Order-of-precedence test.
    const r = classifyStub({
      sourceDomain: 'mit.edu',
      headline: 'Q3 results: SuperCorp beats forecast on AI demand',
      severity: 'high',
    });
    assert.equal(r.type, 'analysis');
  });
});

describe('classifyStub — Rule 1 host-shape coverage (Codex PR #3617 P2)', () => {
  it('www-prefixed analysis domain: www.usni.org → analysis', () => {
    assert.equal(classifyStub({ sourceDomain: 'www.usni.org', severity: 'high' }).type, 'analysis');
  });

  it('www-prefixed: www.nature.com → analysis', () => {
    assert.equal(classifyStub({ sourceDomain: 'www.nature.com', severity: 'high' }).type, 'analysis');
  });

  it('subdomain: editorial.usni.org → analysis', () => {
    assert.equal(classifyStub({ sourceDomain: 'editorial.usni.org', severity: 'high' }).type, 'analysis');
  });

  it('subdomain: media.brookings.edu → analysis (also covered by .edu suffix)', () => {
    assert.equal(classifyStub({ sourceDomain: 'media.brookings.edu', severity: 'high' }).type, 'analysis');
  });

  it('false-positive guard: notmyusni.org does NOT match (suffix is `.${domain}`, not bare suffix)', () => {
    // The fix uses .endsWith(`.${d}`) for subdomain matching, so a
    // host that ends with the bare domain name without a dot
    // separator (notmyusni.org) is correctly rejected.
    const r = classifyStub({ sourceDomain: 'notmyusni.org', severity: 'high' });
    assert.notEqual(r.type, 'analysis');
  });

  it('case-folded www-prefixed: WWW.USNI.ORG → analysis', () => {
    assert.equal(classifyStub({ sourceDomain: 'WWW.USNI.ORG', severity: 'high' }).type, 'analysis');
  });
});

describe('classifyStub — Rule 2: Government regulatory', () => {
  it('*.gov + LICENSE NO. → sanctions-regulatory', () => {
    const r = classifyStub({
      sourceDomain: 'treasury.gov',
      headline: 'OFAC GENERAL LICENSE NO. 58 Authorizing Certain Services',
      severity: 'high',
    });
    assert.equal(r.type, 'sanctions-regulatory');
    assert.equal(r.classificationMissing, false);
  });

  it('*.gov + Final Rule → sanctions-regulatory', () => {
    const r = classifyStub({
      sourceDomain: 'sec.gov',
      headline: 'Final Rule on Climate Disclosure',
      severity: 'high',
    });
    assert.equal(r.type, 'sanctions-regulatory');
  });

  it('*.gov + Notice of → sanctions-regulatory', () => {
    const r = classifyStub({
      sourceDomain: 'commerce.gov',
      headline: 'Notice of Inquiry on AI Diffusion',
      severity: 'high',
    });
    assert.equal(r.type, 'sanctions-regulatory');
  });

  it('*.gov.uk + LICENSE NO. → sanctions-regulatory', () => {
    const r = classifyStub({
      sourceDomain: 'foreign.gov.uk',
      headline: 'GENERAL LICENSE NO. 12 — UK sanctions',
      severity: 'high',
    });
    assert.equal(r.type, 'sanctions-regulatory');
  });

  it('*.gov + non-regulatory headline → falls through (NOT sanctions-regulatory)', () => {
    const r = classifyStub({
      sourceDomain: 'whitehouse.gov',
      headline: 'President addresses the nation',
      severity: 'high',
    });
    assert.notEqual(r.type, 'sanctions-regulatory');
  });
});

describe('classifyStub — Rule 3: Single-corporate earnings', () => {
  it('"X tops forecast" → high-single-corporate (regardless of domain)', () => {
    const r = classifyStub({
      sourceDomain: 'reuters.com',
      headline: 'Hugo Boss tops profit forecasts',
      severity: 'high',
    });
    assert.equal(r.type, 'high-single-corporate');
  });

  it('"X beat estimate" → high-single-corporate (regex anchors on bare verb form)', () => {
    // The regex is /\b(beat|miss|tops|exceeds)\s+(forecast|estimate|profit)/i —
    // matches the verb directly adjacent to the noun, no intervening words.
    // Conservative on purpose: a future Sprint-3 classifier broadens this.
    assert.equal(classifyStub({
      sourceDomain: 'bloomberg.com',
      headline: 'NVIDIA beat estimate handily on AI demand',
      severity: 'high',
    }).type, 'high-single-corporate');
  });

  it('"X exceeds forecast" → high-single-corporate', () => {
    assert.equal(classifyStub({
      sourceDomain: 'ft.com',
      headline: 'Apple exceeds forecast on services growth',
      severity: 'high',
    }).type, 'high-single-corporate');
  });

  it('"X miss profit" → high-single-corporate', () => {
    assert.equal(classifyStub({
      sourceDomain: 'wsj.com',
      headline: 'Tesla miss profit guidance',
      severity: 'high',
    }).type, 'high-single-corporate');
  });

  it('case-insensitive on headline', () => {
    assert.equal(classifyStub({
      sourceDomain: 'reuters.com',
      headline: 'HUGO BOSS BEAT FORECAST',
      severity: 'high',
    }).type, 'high-single-corporate');
  });

  it('"beats" (3rd person) does NOT match — known regex limitation flagged for Sprint 3', () => {
    // The current regex matches the bare verb form ('beat' not 'beats').
    // Real-world Reuters/Bloomberg headlines use 'beats'/'misses'/etc more
    // often, so this is a known false-negative for Sprint 1's stub.
    // Sprint 3's full classifier ships a broader regex; for now we lock
    // the current contract so a future change to extend coverage flips
    // this test naturally.
    const r = classifyStub({
      sourceDomain: 'reuters.com',
      headline: 'Hugo Boss beats forecast',
      severity: 'high',
    });
    // Falls through to severity-derived 'high-event' (severity='high').
    assert.equal(r.type, 'high-event');
    assert.equal(r.classificationMissing, false);
  });

  it('false-positive guard: "company beat its own internal goal" → does NOT classify single-corp', () => {
    // The regex is anchored to the verb-noun pair (beat|miss|tops|exceeds + forecast|estimate|profit).
    // An internal-goal headline doesn't match.
    const r = classifyStub({
      sourceDomain: 'reuters.com',
      headline: 'Hugo Boss beat its own internal sales goal',
      severity: 'high',
    });
    assert.notEqual(r.type, 'high-single-corporate');
  });
});

describe('classifyStub — Rule 4: Severity-derived fallback', () => {
  it('severity=critical → critical-developing', () => {
    const r = classifyStub({ sourceDomain: 'reuters.com', headline: 'Iran strikes Hormuz', severity: 'critical' });
    assert.equal(r.type, 'critical-developing');
    assert.equal(r.classificationMissing, false);
  });

  it('severity=high → high-event', () => {
    assert.equal(classifyStub({
      sourceDomain: 'reuters.com',
      headline: 'Cabinet shuffle in Berlin',
      severity: 'high',
    }).type, 'high-event');
  });

  it('severity=medium → med', () => {
    assert.equal(classifyStub({
      sourceDomain: 'reuters.com',
      headline: 'Trade talks resume',
      severity: 'medium',
    }).type, 'med');
  });
});

describe('classifyStub — Rule 5: Missing classification fallback', () => {
  it('no domain, no headline, no severity → high-event default + classificationMissing=true', () => {
    const r = classifyStub({});
    assert.equal(r.type, 'high-event');
    assert.equal(r.classificationMissing, true);
  });

  it('unknown severity ("low") with no other rule match → high-event + classificationMissing=true', () => {
    const r = classifyStub({ sourceDomain: 'example.com', headline: 'Unknown topic', severity: 'low' });
    assert.equal(r.type, 'high-event');
    assert.equal(r.classificationMissing, true);
  });
});

describe('evaluateCooldown — mode contract', () => {
  it("mode='off' → null (no decision artifact, observers see 'cooldown not consulted')", () => {
    const r = evaluateCooldown({
      userId: 'u', slot: '2026-05-06-2001', clusterId: 'c1', channel: 'email', ruleId: 'full:en:high',
      type: 'high-event',
      severity: 'high', currentSourceCount: 5, currentTier: 'high',
      lastDeliveredAt: null, lastDeliveredSourceCount: null, lastDeliveredTier: null,
      options: { mode: 'off', nowMs: NOW },
    });
    assert.equal(r, null);
  });

  it("mode='shadow' (default) → produces a decision artifact", () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 5, currentTier: 'high',
      lastDeliveredAt: null,
      options: { nowMs: NOW },
    });
    assert.notEqual(r, null);
    assert.equal(r.decision, 'allow');
  });
});

describe('evaluateCooldown — no prior delivery (first send)', () => {
  it('lastDeliveredAt=null → allow, reason=no_prior_delivery', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 5, currentTier: 'high',
      lastDeliveredAt: null,
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.NO_PRIOR_DELIVERY);
    assert.equal(r.evolutionDelta.hoursSinceLastDelivery, null);
  });

  it('lastDeliveredAt=undefined → also treated as no prior delivery', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 5, currentTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.NO_PRIOR_DELIVERY);
  });
});

describe('evaluateCooldown — within-floor suppression (no evolution)', () => {
  it('high-event re-air at 6h post-delivery → suppress (18h floor, no evolution)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: NOW - 6 * HOUR_MS,
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.COOLDOWN_FLOOR);
    assert.equal(r.cooldownHours, 18);
  });

  it('med re-air at 12h post-delivery → suppress (36h floor)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'med', severity: 'medium', currentSourceCount: 2, currentTier: 'medium',
      lastDeliveredAt: NOW - 12 * HOUR_MS,
      lastDeliveredSourceCount: 2, lastDeliveredTier: 'medium',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.COOLDOWN_FLOOR);
    assert.equal(r.cooldownHours, 36);
  });

  it('beyond floor → allow (cooldown_floor as the elapsed reason)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: NOW - 19 * HOUR_MS, // > 18h floor
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.COOLDOWN_FLOOR);
  });
});

describe('evaluateCooldown — evolution bypasses (within floor)', () => {
  it('+5 sources within floor on a soft-floor type → allow / evolution_source_count', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 8, currentTier: 'high',
      lastDeliveredAt: NOW - 6 * HOUR_MS, // within 18h floor
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.EVOLUTION_SOURCE_COUNT);
    assert.equal(r.evolutionDelta.sourceCountDelta, 5);
  });

  it('+4 sources within floor → still suppressed (delta < threshold of 5)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 7, currentTier: 'high',
      lastDeliveredAt: NOW - 6 * HOUR_MS,
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.COOLDOWN_FLOOR);
  });

  it('severity tier change (CRITICAL→HIGH) within floor → allow / severity_tier_change', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'critical-developing', severity: 'high', currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: NOW - 2 * HOUR_MS, // within 4h floor
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'critical',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.SEVERITY_TIER_CHANGE);
    assert.equal(r.evolutionDelta.tierChanged, true);
  });

  it('tier change has higher precedence than source count (both true)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 8, currentTier: 'critical',
      lastDeliveredAt: NOW - 2 * HOUR_MS,
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.SEVERITY_TIER_CHANGE);
  });
});

describe('evaluateCooldown — hard floors (no evolution bypass)', () => {
  it('Analysis re-air at 6d → suppress (7d hard, never bypass)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'analysis', severity: 'high', currentSourceCount: 50, currentTier: 'critical', // huge evolution attempt
      lastDeliveredAt: NOW - 6 * 24 * HOUR_MS,
      lastDeliveredSourceCount: 1, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.ANALYSIS_7D_HARD);
    assert.equal(r.cooldownHours, 168); // 7 * 24
  });

  it('Analysis re-air at 7.1d → allow (beyond hard floor)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'analysis', severity: 'high', currentSourceCount: 1, currentTier: 'high',
      lastDeliveredAt: NOW - 7.1 * 24 * HOUR_MS,
      lastDeliveredSourceCount: 1, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.COOLDOWN_FLOOR);
  });

  it('high-single-corporate re-air at 47h with +10 sources → suppress (48h hard, no source-count bypass)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-single-corporate', severity: 'high', currentSourceCount: 12, currentTier: 'high',
      lastDeliveredAt: NOW - 47 * HOUR_MS,
      lastDeliveredSourceCount: 2, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.SINGLE_CORP_48H_HARD);
  });

  // Codex PR #3617 P2 regression — high-single-corporate downgrade
  // (HIGH→MEDIUM) inside 48h must NOT bypass the hard floor. Pre-fix
  // the bypass triggered on any tier change; post-fix it requires
  // strict escalation (currentTierRank > lastTierRank).
  it('high-single-corporate at 47h WITH tier DOWNGRADE (high→medium) → suppress (Codex PR #3617 P2)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-single-corporate', severity: 'medium', currentSourceCount: 4, currentTier: 'medium',
      lastDeliveredAt: NOW - 47 * HOUR_MS,
      lastDeliveredSourceCount: 2, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.SINGLE_CORP_48H_HARD);
  });

  it('high-event tier downgrade (critical→high) inside floor → STILL allow (symmetric tier change for non-corp classes)', () => {
    // Non-single-corp classes retain the symmetric tier-change rule:
    // a critical→high de-escalation IS editorial signal ("the situation
    // cooled" is news worth re-airing).
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: NOW - 6 * HOUR_MS,
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'critical',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.SEVERITY_TIER_CHANGE);
  });

  it('high-single-corporate at 47h WITH tier escalation (high→critical) → allow / severity_tier_change', () => {
    // The encoded "real follow-up event" trigger: a corporate-earnings
    // cluster that escalates to a higher tier (e.g. regulatory action
    // following the earnings beat).
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-single-corporate', severity: 'critical', currentSourceCount: 4, currentTier: 'critical',
      lastDeliveredAt: NOW - 47 * HOUR_MS,
      lastDeliveredSourceCount: 2, lastDeliveredTier: 'high',
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.SEVERITY_TIER_CHANGE);
  });
});

// Greptile PR #3617 P2 — EVOLUTION_NEW_FACT bypass.
//
// Pre-fix: REASON.EVOLUTION_NEW_FACT was exported and allowNewFact
// flags were set on COOLDOWN_TABLE cells, but no code path returned
// the reason. Wire contract surface that nothing produced.
//
// Post-fix: when allowNewFact is true AND lastDeliveredHeadline is
// present AND the current headline differs (case-insensitive,
// whitespace-trimmed equality), the bypass fires.
describe('evaluateCooldown — EVOLUTION_NEW_FACT bypass (Greptile PR #3617 P2)', () => {
  it('high-event re-air at 6h (within 18h floor) WITH new headline → allow / evolution_new_fact', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: NOW - 6 * HOUR_MS,
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'high',
      lastDeliveredHeadline: 'Iran threatens to close Strait of Hormuz',
      classifierInputs: {
        sourceDomain: 'reuters.com',
        headline: 'Iran fires missiles into Strait of Hormuz', // genuinely different fact
      },
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.EVOLUTION_NEW_FACT);
  });

  it('same headline (case-insensitive, whitespace-trimmed) → suppress (no bypass)', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: NOW - 6 * HOUR_MS,
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'high',
      lastDeliveredHeadline: '  Iran threatens to close Strait of Hormuz  ',
      classifierInputs: {
        sourceDomain: 'reuters.com',
        headline: 'IRAN threatens to close Strait of Hormuz',
      },
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.COOLDOWN_FLOOR);
  });

  it('lastDeliveredHeadline=null (older v4 row without the field) → no bypass, suppress as cooldown_floor', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: NOW - 6 * HOUR_MS,
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'high',
      lastDeliveredHeadline: null,
      classifierInputs: { sourceDomain: 'reuters.com', headline: 'Some new headline' },
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.COOLDOWN_FLOOR);
  });

  it('analysis (allowNewFact=false) at 6d with NEW headline → still suppress (7d hard floor wins)', () => {
    // The hard-floor classes have allowNewFact=false. New-fact bypass
    // must NOT fire even when headlines differ.
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'analysis', severity: 'high', currentSourceCount: 1, currentTier: 'high',
      lastDeliveredAt: NOW - 6 * DAY_MS,
      lastDeliveredSourceCount: 1, lastDeliveredTier: 'high',
      lastDeliveredHeadline: 'Original doctrine essay',
      classifierInputs: {
        sourceDomain: 'usni.org',
        headline: 'Completely different doctrine essay headline',
      },
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.ANALYSIS_7D_HARD);
  });

  it('high-single-corporate (allowNewFact=false) inside 48h with NEW headline → still suppress', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-single-corporate', severity: 'high', currentSourceCount: 4, currentTier: 'high',
      lastDeliveredAt: NOW - 24 * HOUR_MS,
      lastDeliveredSourceCount: 2, lastDeliveredTier: 'high',
      lastDeliveredHeadline: 'Hugo Boss tops profit forecasts',
      classifierInputs: {
        sourceDomain: 'reuters.com',
        headline: 'Hugo Boss reports record Q3 results',
      },
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'suppress');
    assert.equal(r.reason, REASON.SINGLE_CORP_48H_HARD);
  });

  it('tier-change still wins precedence over new-fact bypass', () => {
    // Order of bypass precedence: tier change → new fact → source count.
    // A tier change AND a new headline both fire — tier change should
    // win the reason since it's the strongest editorial signal.
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'high-event', severity: 'high', currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: NOW - 6 * HOUR_MS,
      lastDeliveredSourceCount: 3, lastDeliveredTier: 'critical', // tier downgraded
      lastDeliveredHeadline: 'Old headline',
      classifierInputs: { sourceDomain: 'reuters.com', headline: 'New headline' },
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.SEVERITY_TIER_CHANGE);
  });
});

describe('evaluateCooldown — classification-missing telemetry', () => {
  it('missing classification → falls back to high-event (18h) with classificationMissing flag', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      // no `type` and no `classifierInputs.severity` → stub returns
      // classificationMissing=true
      severity: undefined, currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: null,
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, REASON.CLASSIFICATION_MISSING_DEFAULT_HIGH);
    assert.equal(r.classifiedType, 'high-event');
    assert.equal(r.classificationMissing, true);
    assert.equal(r.cooldownHours, 18);
  });

  it('classifier-supplied type bypasses the stub', () => {
    const r = evaluateCooldown({
      userId: 'u', slot: 's', clusterId: 'c', channel: 'email', ruleId: 'r',
      type: 'analysis', // explicit type wins over classifierInputs
      classifierInputs: { sourceDomain: 'reuters.com', headline: 'X tops forecast' },
      severity: 'high', currentSourceCount: 3, currentTier: 'high',
      lastDeliveredAt: null,
      options: { mode: 'shadow', nowMs: NOW },
    });
    assert.equal(r.classifiedType, 'analysis');
    assert.equal(r.classificationMissing, false);
  });
});

describe('cooldown table sanity — implementation invariants', () => {
  it('every type has a valid cell with hours, hard, and the three allow* flags', () => {
    for (const [type, cell] of Object.entries(__COOLDOWN_TABLE)) {
      assert.equal(typeof cell.hours, 'number', `${type}: hours must be a number`);
      assert.ok(cell.hours > 0, `${type}: hours must be positive`);
      assert.equal(typeof cell.hard, 'boolean', `${type}: hard must be a boolean`);
      assert.equal(typeof cell.allowSourceCountEvolution, 'boolean', `${type}: allowSourceCountEvolution must be a boolean`);
      assert.equal(typeof cell.allowNewFact, 'boolean', `${type}: allowNewFact must be a boolean`);
      assert.equal(typeof cell.allowTierChange, 'boolean', `${type}: allowTierChange must be a boolean`);
    }
  });

  it('hard-floor types disable source-count evolution (the hard contract)', () => {
    assert.equal(__COOLDOWN_TABLE['analysis'].hard, true);
    assert.equal(__COOLDOWN_TABLE['analysis'].allowSourceCountEvolution, false);
    assert.equal(__COOLDOWN_TABLE['high-single-corporate'].hard, true);
    assert.equal(__COOLDOWN_TABLE['high-single-corporate'].allowSourceCountEvolution, false);
  });

  it('floor values match the plan table (snapshot guard)', () => {
    assert.equal(__COOLDOWN_TABLE['critical-developing'].hours, 4);
    assert.equal(__COOLDOWN_TABLE['critical-sustained'].hours, 24);
    assert.equal(__COOLDOWN_TABLE['high-event'].hours, 18);
    assert.equal(__COOLDOWN_TABLE['high-single-corporate'].hours, 48);
    assert.equal(__COOLDOWN_TABLE['analysis'].hours, 7 * 24);
    assert.equal(__COOLDOWN_TABLE['med'].hours, 36);
  });
});
