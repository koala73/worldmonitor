// #4917 — non-due synthesis reuse decision (pure module).
//
// Reuse must be conservative: only a young-enough prior envelope whose
// lead still grounds against the CURRENT story pool may stand in for a
// paid synthesis, and only on non-due ticks (the orchestrator gates on
// `winner.due`; this module only judges the envelope).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveNonDueSynthesisReuse,
  DEFAULT_NONDUE_SYNTHESIS_REUSE_MIN,
} from '../scripts/lib/brief-synthesis-reuse.mjs';

const NOW = 1_751_700_000_000;
const MAX_AGE = 6 * 60 * 60 * 1000;

// Stories with proper-noun anchors the leads below reference.
const CURRENT_STORIES = [
  { headline: 'Iran threatens to close Strait of Hormuz if US blockade continues' },
  { headline: 'Pakistan and India exchange artillery fire across Kashmir line' },
  { headline: 'European Union advances sanctions package against Belarus' },
];

const GROUNDED_LEAD =
  'Iran’s threat to close the Strait of Hormuz dominates the desk today, with escalation risk spreading from Kashmir to the European Union’s Belarus sanctions track.';

function envelope(overrides = {}, digestOverrides = {}) {
  return {
    version: 3,
    issuedAt: NOW - 60 * 60 * 1000, // 1h old
    data: {
      digest: {
        greeting: 'Good afternoon.',
        lead: GROUNDED_LEAD,
        threads: [{ tag: 'Diplomacy', teaser: 'Threads teaser.' }],
        signals: [{ label: 'Escalation', value: 'rising' }],
        ...digestOverrides,
      },
    },
    ...overrides,
  };
}

describe('resolveNonDueSynthesisReuse (#4917)', () => {
  it('reuses a young, grounded prior envelope', () => {
    const out = resolveNonDueSynthesisReuse(envelope(), {
      nowMs: NOW, maxAgeMs: MAX_AGE, currentStories: CURRENT_STORIES,
    });
    assert.equal(out.reuse, true);
    assert.equal(out.synthesis.lead, GROUNDED_LEAD);
    assert.deepEqual(out.synthesis.threads, [{ tag: 'Diplomacy', teaser: 'Threads teaser.' }]);
    assert.equal(out.publicLead, null, 'no stored public prose → null, caller renders without it');
    assert.equal(out.ageMs, 60 * 60 * 1000);
  });

  it('carries the public prose trio when the prior envelope stored it', () => {
    const out = resolveNonDueSynthesisReuse(
      envelope({}, {
        publicLead: 'Iran’s Hormuz threat leads a tense day across three theatres.',
        publicThreads: [{ tag: 'Security', teaser: 'Public teaser.' }],
        publicSignals: [{ label: 'Risk', value: 'elevated' }],
      }),
      { nowMs: NOW, maxAgeMs: MAX_AGE, currentStories: CURRENT_STORIES },
    );
    assert.equal(out.reuse, true);
    assert.match(out.publicLead.lead, /Hormuz/);
    assert.equal(out.publicLead.threads.length, 1);
    assert.equal(out.publicLead.signals.length, 1);
  });

  it('declines when the envelope is older than the budget', () => {
    const old = envelope({ issuedAt: NOW - MAX_AGE - 1 });
    const out = resolveNonDueSynthesisReuse(old, {
      nowMs: NOW, maxAgeMs: MAX_AGE, currentStories: CURRENT_STORIES,
    });
    assert.deepEqual(out, { reuse: false, reason: 'stale' });
  });

  it('declines a future-dated issuedAt (clock skew is not "fresh")', () => {
    const future = envelope({ issuedAt: NOW + 60_000 });
    const out = resolveNonDueSynthesisReuse(future, {
      nowMs: NOW, maxAgeMs: MAX_AGE, currentStories: CURRENT_STORIES,
    });
    assert.deepEqual(out, { reuse: false, reason: 'stale' });
  });

  it('declines when there is no prior envelope', () => {
    const out = resolveNonDueSynthesisReuse(null, {
      nowMs: NOW, maxAgeMs: MAX_AGE, currentStories: CURRENT_STORIES,
    });
    assert.deepEqual(out, { reuse: false, reason: 'no_prior_envelope' });
  });

  it('declines an envelope without a numeric issuedAt', () => {
    const out = resolveNonDueSynthesisReuse(envelope({ issuedAt: 'yesterday' }), {
      nowMs: NOW, maxAgeMs: MAX_AGE, currentStories: CURRENT_STORIES,
    });
    assert.deepEqual(out, { reuse: false, reason: 'no_issued_at' });
  });

  it('declines a missing or trivial lead (prior compose degraded — regenerate)', () => {
    const out = resolveNonDueSynthesisReuse(envelope({}, { lead: 'Short.' }), {
      nowMs: NOW, maxAgeMs: MAX_AGE, currentStories: CURRENT_STORIES,
    });
    assert.deepEqual(out, { reuse: false, reason: 'no_lead' });
  });

  it('declines when the pool rotated and the prior lead no longer grounds', () => {
    const rotated = [
      { headline: 'Argentina central bank surprises with emergency rate hike' },
      { headline: 'Taiwan reports record incursion by PLA aircraft' },
      { headline: 'Nigeria fuel subsidy protests spread to Lagos' },
    ];
    const out = resolveNonDueSynthesisReuse(envelope(), {
      nowMs: NOW, maxAgeMs: MAX_AGE, currentStories: rotated,
    });
    assert.deepEqual(out, { reuse: false, reason: 'ungrounded' });
  });

  it('exports a sane default budget (used by the orchestrator env parse)', () => {
    assert.equal(DEFAULT_NONDUE_SYNTHESIS_REUSE_MIN, 360);
  });
});
