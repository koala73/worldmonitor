// Tests for the Regional Intelligence narrative generator (Phase 1 PR2).
// Pure-function + injectable-LLM unit tests; no network. Run via:
//   npm run test:data

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateRegionalNarrative,
  buildNarrativePrompt,
  parseNarrativeJson,
  emptyNarrative,
  selectPromptEvidence,
} from '../scripts/regional-snapshot/narrative.mjs';
import { REGIONS } from '../shared/geography.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const menaRegion = REGIONS.find((r) => r.id === 'mena');
const globalRegion = REGIONS.find((r) => r.id === 'global');

/** Minimal RegionalSnapshot-shaped stub with the fields the prompt reads. */
function stubSnapshot(overrides = {}) {
  return {
    region_id: 'mena',
    generated_at: 1_700_000_000_000,
    meta: {
      snapshot_id: 'test-id',
      model_version: '0.1.0',
      scoring_version: '1.0.0',
      geography_version: '1.0.0',
      snapshot_confidence: 0.9,
      missing_inputs: [],
      stale_inputs: [],
      valid_until: 0,
      trigger_reason: 'scheduled_6h',
      narrative_provider: '',
      narrative_model: '',
    },
    regime: { label: 'coercive_stalemate', previous_label: 'calm', transitioned_at: 0, transition_driver: '' },
    balance: {
      coercive_pressure: 0.72,
      domestic_fragility: 0.55,
      capital_stress: 0.40,
      energy_vulnerability: 0.30,
      alliance_cohesion: 0.60,
      maritime_access: 0.70,
      energy_leverage: 0.80,
      net_balance: 0.03,
      pressures: [],
      buffers: [],
    },
    actors: [
      { actor_id: 'IR', name: 'Iran', role: 'aggressor', leverage_domains: ['military'], leverage_score: 0.85, delta: 0.05, evidence_ids: [] },
      { actor_id: 'IL', name: 'Israel', role: 'stabilizer', leverage_domains: ['military'], leverage_score: 0.70, delta: 0.00, evidence_ids: [] },
    ],
    leverage_edges: [],
    scenario_sets: [
      { horizon: '24h', lanes: [
        { name: 'base', probability: 0.5, trigger_ids: [], consequences: [], transmissions: [] },
        { name: 'escalation', probability: 0.3, trigger_ids: [], consequences: [], transmissions: [] },
        { name: 'containment', probability: 0.15, trigger_ids: [], consequences: [], transmissions: [] },
        { name: 'fragmentation', probability: 0.05, trigger_ids: [], consequences: [], transmissions: [] },
      ] },
      { horizon: '7d', lanes: [
        { name: 'base', probability: 0.4, trigger_ids: [], consequences: [], transmissions: [] },
        { name: 'escalation', probability: 0.4, trigger_ids: [], consequences: [], transmissions: [] },
        { name: 'containment', probability: 0.15, trigger_ids: [], consequences: [], transmissions: [] },
        { name: 'fragmentation', probability: 0.05, trigger_ids: [], consequences: [], transmissions: [] },
      ] },
      { horizon: '30d', lanes: [
        { name: 'base', probability: 0.35, trigger_ids: [], consequences: [], transmissions: [] },
        { name: 'escalation', probability: 0.45, trigger_ids: [], consequences: [], transmissions: [] },
        { name: 'containment', probability: 0.15, trigger_ids: [], consequences: [], transmissions: [] },
        { name: 'fragmentation', probability: 0.05, trigger_ids: [], consequences: [], transmissions: [] },
      ] },
    ],
    transmission_paths: [
      { start: 'hormuz', mechanism: 'naval_posture', end: 'oil', severity: 'high', corridor_id: 'hormuz', confidence: 0.85, latency_hours: 12, impacted_asset_class: 'commodity', impacted_regions: ['mena'], magnitude_low: 0, magnitude_high: 0, magnitude_unit: 'pct', template_id: 't1', template_version: '1.0.0' },
    ],
    triggers: {
      active: [{ id: 'mena_coercive_high', description: '', threshold: {}, activated: true, activated_at: 0, scenario_lane: 'escalation', evidence_ids: [] }],
      watching: [],
      dormant: [],
    },
    mobility: { airspace: [], flight_corridors: [], airports: [], reroute_intensity: 0, notam_closures: [] },
    evidence: [],
    narrative: emptyNarrative(),
    ...overrides,
  };
}

const evidenceFixture = [
  { id: 'ev1', type: 'market_signal', source: 'cross-source', summary: 'Iran reports heightened naval posture near Hormuz', confidence: 0.85, observed_at: 1_700_000_000_000, theater: 'persian-gulf', corridor: 'hormuz' },
  { id: 'ev2', type: 'chokepoint_status', source: 'supply-chain', summary: 'Bab el-Mandeb threat level elevated', confidence: 0.9, observed_at: 1_700_000_000_000, theater: '', corridor: 'babelm' },
  { id: 'ev3', type: 'cii_spike', source: 'risk-scores', summary: 'IR CII jumped 12 points', confidence: 0.9, observed_at: 1_700_000_000_000, theater: '', corridor: '' },
];

// ────────────────────────────────────────────────────────────────────────────
// buildNarrativePrompt
// ────────────────────────────────────────────────────────────────────────────

describe('buildNarrativePrompt', () => {
  it('returns system + user prompt strings', () => {
    const { systemPrompt, userPrompt } = buildNarrativePrompt(menaRegion, stubSnapshot(), evidenceFixture);
    assert.ok(typeof systemPrompt === 'string' && systemPrompt.length > 100);
    assert.ok(typeof userPrompt === 'string' && userPrompt.length > 100);
  });

  it('includes balance axes in the user prompt', () => {
    const { userPrompt } = buildNarrativePrompt(menaRegion, stubSnapshot(), evidenceFixture);
    assert.match(userPrompt, /coercive=0\.72/);
    assert.match(userPrompt, /net=0\.03/);
  });

  it('includes top actors and regime in the user prompt', () => {
    const { userPrompt } = buildNarrativePrompt(menaRegion, stubSnapshot(), evidenceFixture);
    assert.match(userPrompt, /Iran.*aggressor/);
    assert.match(userPrompt, /coercive_stalemate/);
  });

  it('inlines evidence items with their ids', () => {
    const { userPrompt } = buildNarrativePrompt(menaRegion, stubSnapshot(), evidenceFixture);
    assert.match(userPrompt, /ev1/);
    assert.match(userPrompt, /ev2/);
    assert.match(userPrompt, /ev3/);
  });

  it('includes dominant scenario lane per horizon', () => {
    const { userPrompt } = buildNarrativePrompt(menaRegion, stubSnapshot(), evidenceFixture);
    assert.match(userPrompt, /24h:/);
    assert.match(userPrompt, /7d:/);
    assert.match(userPrompt, /30d:/);
  });

  it('handles a snapshot with no evidence gracefully', () => {
    const { userPrompt } = buildNarrativePrompt(menaRegion, stubSnapshot(), []);
    assert.match(userPrompt, /no evidence available/i);
  });

  it('tolerates missing optional snapshot fields without throwing', () => {
    const bare = stubSnapshot({ actors: [], scenario_sets: [], transmission_paths: [], triggers: { active: [], watching: [], dormant: [] } });
    assert.doesNotThrow(() => buildNarrativePrompt(menaRegion, bare, []));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseNarrativeJson
// ────────────────────────────────────────────────────────────────────────────

describe('parseNarrativeJson', () => {
  const validIds = ['ev1', 'ev2', 'ev3'];

  it('parses a clean JSON object into RegionalNarrative', () => {
    const text = JSON.stringify({
      situation: { text: 'Iran is flexing naval posture.', evidence_ids: ['ev1'] },
      balance_assessment: { text: 'Pressure 0.72 vs buffers 0.70.', evidence_ids: ['ev3'] },
      outlook_24h: { text: 'Base case holds.', evidence_ids: [] },
      outlook_7d: { text: 'Escalation risk climbs.', evidence_ids: ['ev2'] },
      outlook_30d: { text: 'Uncertainty widens.', evidence_ids: [] },
      watch_items: [
        { text: 'Watch Hormuz transit volume.', evidence_ids: ['ev1'] },
      ],
    });
    const { narrative, valid } = parseNarrativeJson(text, validIds);
    assert.equal(valid, true);
    assert.equal(narrative.situation.text, 'Iran is flexing naval posture.');
    assert.deepEqual(narrative.situation.evidence_ids, ['ev1']);
    assert.equal(narrative.watch_items.length, 1);
  });

  it('strips hallucinated evidence IDs not in the provided set', () => {
    const text = JSON.stringify({
      situation: { text: 'Some text.', evidence_ids: ['ev1', 'hallucinated', 'ev2'] },
      balance_assessment: { text: 'B.', evidence_ids: ['nope'] },
      outlook_24h: { text: 'O24.', evidence_ids: [] },
      outlook_7d: { text: 'O7.', evidence_ids: [] },
      outlook_30d: { text: 'O30.', evidence_ids: [] },
      watch_items: [],
    });
    const { narrative, valid } = parseNarrativeJson(text, validIds);
    assert.equal(valid, true);
    assert.deepEqual(narrative.situation.evidence_ids, ['ev1', 'ev2']);
    assert.deepEqual(narrative.balance_assessment.evidence_ids, []);
  });

  it('extracts JSON from prose-wrapped output', () => {
    const text = 'Sure, here is the JSON:\n```json\n' + JSON.stringify({
      situation: { text: 'x', evidence_ids: [] },
      balance_assessment: { text: '', evidence_ids: [] },
      outlook_24h: { text: '', evidence_ids: [] },
      outlook_7d: { text: '', evidence_ids: [] },
      outlook_30d: { text: '', evidence_ids: [] },
      watch_items: [],
    }) + '\n```\n';
    const { narrative, valid } = parseNarrativeJson(text, validIds);
    assert.equal(valid, true);
    assert.equal(narrative.situation.text, 'x');
  });

  it('returns valid=false for an all-empty JSON object', () => {
    const text = JSON.stringify({
      situation: { text: '', evidence_ids: [] },
      balance_assessment: { text: '', evidence_ids: [] },
      outlook_24h: { text: '', evidence_ids: [] },
      outlook_7d: { text: '', evidence_ids: [] },
      outlook_30d: { text: '', evidence_ids: [] },
      watch_items: [],
    });
    const { valid } = parseNarrativeJson(text, validIds);
    assert.equal(valid, false);
  });

  it('returns valid=false on unparseable garbage', () => {
    const { narrative, valid } = parseNarrativeJson('not json at all, just prose', validIds);
    assert.equal(valid, false);
    assert.deepEqual(narrative, emptyNarrative());
  });

  it('returns valid=false for null/empty input', () => {
    assert.equal(parseNarrativeJson('', validIds).valid, false);
    assert.equal(parseNarrativeJson(null, validIds).valid, false);
    assert.equal(parseNarrativeJson(undefined, validIds).valid, false);
  });

  it('caps watch_items at the enforced maximum', () => {
    const text = JSON.stringify({
      situation: { text: 'x', evidence_ids: [] },
      balance_assessment: { text: '', evidence_ids: [] },
      outlook_24h: { text: '', evidence_ids: [] },
      outlook_7d: { text: '', evidence_ids: [] },
      outlook_30d: { text: '', evidence_ids: [] },
      watch_items: [
        { text: 'w1', evidence_ids: [] },
        { text: 'w2', evidence_ids: [] },
        { text: 'w3', evidence_ids: [] },
        { text: 'w4', evidence_ids: [] },
        { text: 'w5', evidence_ids: [] },
      ],
    });
    const { narrative } = parseNarrativeJson(text, validIds);
    assert.ok(narrative.watch_items.length <= 3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// generateRegionalNarrative (with injected callLlm)
// ────────────────────────────────────────────────────────────────────────────

describe('generateRegionalNarrative', () => {
  function mockCall(text, providerName = 'groq', modelName = 'llama-3.3-70b-versatile') {
    return async () => ({ text, provider: providerName, model: modelName });
  }

  const validPayload = {
    situation: { text: 'Iran flexes naval posture near Hormuz.', evidence_ids: ['ev1'] },
    balance_assessment: { text: 'Net balance slightly positive.', evidence_ids: ['ev3'] },
    outlook_24h: { text: 'Base case dominates.', evidence_ids: [] },
    outlook_7d: { text: 'Escalation risk rises.', evidence_ids: ['ev2'] },
    outlook_30d: { text: 'Uncertainty widens.', evidence_ids: [] },
    watch_items: [{ text: 'Watch Hormuz transit counts.', evidence_ids: ['ev1'] }],
  };

  it('returns the parsed narrative + provider + model on success', async () => {
    const result = await generateRegionalNarrative(
      menaRegion,
      stubSnapshot(),
      evidenceFixture,
      { callLlm: mockCall(JSON.stringify(validPayload)) },
    );
    assert.equal(result.provider, 'groq');
    assert.equal(result.model, 'llama-3.3-70b-versatile');
    assert.equal(result.narrative.situation.text, 'Iran flexes naval posture near Hormuz.');
    assert.deepEqual(result.narrative.situation.evidence_ids, ['ev1']);
  });

  it('skips the global region and returns empty narrative', async () => {
    let called = false;
    const callLlm = async () => {
      called = true;
      return { text: '', provider: '', model: '' };
    };
    const result = await generateRegionalNarrative(globalRegion, stubSnapshot({ region_id: 'global' }), evidenceFixture, { callLlm });
    assert.equal(called, false, 'global region must not call LLM');
    assert.equal(result.provider, '');
    assert.equal(result.model, '');
    assert.deepEqual(result.narrative, emptyNarrative());
  });

  it('ships empty narrative when callLlm returns null (all providers failed)', async () => {
    const result = await generateRegionalNarrative(
      menaRegion,
      stubSnapshot(),
      evidenceFixture,
      { callLlm: async () => null },
    );
    assert.deepEqual(result.narrative, emptyNarrative());
    assert.equal(result.provider, '');
    assert.equal(result.model, '');
  });

  it('ships empty narrative when the LLM returns garbage text', async () => {
    const result = await generateRegionalNarrative(
      menaRegion,
      stubSnapshot(),
      evidenceFixture,
      { callLlm: mockCall('not json, just prose from a confused model') },
    );
    assert.deepEqual(result.narrative, emptyNarrative());
    assert.equal(result.provider, '');
  });

  it('ships empty narrative and does not throw when callLlm throws', async () => {
    const result = await generateRegionalNarrative(
      menaRegion,
      stubSnapshot(),
      evidenceFixture,
      {
        callLlm: async () => {
          throw new Error('network blown up');
        },
      },
    );
    assert.deepEqual(result.narrative, emptyNarrative());
    assert.equal(result.provider, '');
    assert.equal(result.model, '');
  });

  it('filters hallucinated evidence IDs end-to-end', async () => {
    const payloadWithHallucination = {
      ...validPayload,
      situation: { text: 'x', evidence_ids: ['ev1', 'fake-id'] },
    };
    const result = await generateRegionalNarrative(
      menaRegion,
      stubSnapshot(),
      evidenceFixture,
      { callLlm: mockCall(JSON.stringify(payloadWithHallucination)) },
    );
    assert.deepEqual(result.narrative.situation.evidence_ids, ['ev1']);
  });

  it('records the provider name the LLM came back from', async () => {
    const result = await generateRegionalNarrative(
      menaRegion,
      stubSnapshot(),
      evidenceFixture,
      { callLlm: mockCall(JSON.stringify(validPayload), 'openrouter', 'google/gemini-2.5-flash') },
    );
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'google/gemini-2.5-flash');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// emptyNarrative shape
// ────────────────────────────────────────────────────────────────────────────

describe('emptyNarrative', () => {
  it('matches the RegionalNarrative shape with empty fields', () => {
    const n = emptyNarrative();
    assert.equal(n.situation.text, '');
    assert.deepEqual(n.situation.evidence_ids, []);
    assert.equal(n.balance_assessment.text, '');
    assert.equal(n.outlook_24h.text, '');
    assert.equal(n.outlook_7d.text, '');
    assert.equal(n.outlook_30d.text, '');
    assert.deepEqual(n.watch_items, []);
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = emptyNarrative();
    const b = emptyNarrative();
    a.situation.evidence_ids.push('leaked');
    assert.deepEqual(b.situation.evidence_ids, []);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Review-fix regression tests (PR #2960 P2/P3 findings)
// ────────────────────────────────────────────────────────────────────────────

describe('selectPromptEvidence', () => {
  it('caps evidence at the prompt-visible maximum', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `ev${i}`,
      type: 'market_signal',
      source: 'test',
      summary: `item ${i}`,
      confidence: 0.5,
      observed_at: 0,
      theater: '',
      corridor: '',
    }));
    const sliced = selectPromptEvidence(many);
    assert.ok(sliced.length <= 15, `expected ≤15, got ${sliced.length}`);
    // Must preserve order — the first N items are what the prompt sees.
    assert.equal(sliced[0].id, 'ev0');
    assert.equal(sliced[sliced.length - 1].id, `ev${sliced.length - 1}`);
  });

  it('returns an empty array for non-array input', () => {
    assert.deepEqual(selectPromptEvidence(null), []);
    assert.deepEqual(selectPromptEvidence(undefined), []);
  });

  it('returns the full array when under the cap', () => {
    assert.equal(selectPromptEvidence(evidenceFixture).length, 3);
  });
});

describe('provider fallback on malformed response (P2 fix)', () => {
  // Simulate the provider-chain behavior of the default callLlm: the
  // mock walks a provider list and honors the `validate` callback so the
  // chain falls through on parse failure rather than short-circuiting.
  function buildFallbackMock(providers) {
    return async (_prompt, opts = {}) => {
      const validate = opts.validate;
      for (const p of providers) {
        if (validate && !validate(p.text)) continue;
        return { text: p.text, provider: p.provider, model: p.model };
      }
      return null;
    };
  }

  const validPayload = JSON.stringify({
    situation: { text: 'Iran flexes naval posture.', evidence_ids: ['ev1'] },
    balance_assessment: { text: 'Net balance slightly positive.', evidence_ids: [] },
    outlook_24h: { text: 'Base case dominates.', evidence_ids: [] },
    outlook_7d: { text: 'Escalation risk rises.', evidence_ids: [] },
    outlook_30d: { text: 'Uncertainty widens.', evidence_ids: [] },
    watch_items: [],
  });

  it('falls through when Groq returns prose and OpenRouter returns valid JSON', async () => {
    const callLlm = buildFallbackMock([
      { text: 'Sure, here is a summary of the situation...', provider: 'groq', model: 'llama-3.3' },
      { text: validPayload, provider: 'openrouter', model: 'google/gemini-2.5-flash' },
    ]);
    const result = await generateRegionalNarrative(menaRegion, stubSnapshot(), evidenceFixture, { callLlm });
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'google/gemini-2.5-flash');
    assert.equal(result.narrative.situation.text, 'Iran flexes naval posture.');
  });

  it('falls through when Groq returns truncated JSON and OpenRouter succeeds', async () => {
    const callLlm = buildFallbackMock([
      { text: '{"situation": {"text": "Iran flexes nav', provider: 'groq', model: 'llama-3.3' },
      { text: validPayload, provider: 'openrouter', model: 'google/gemini-2.5-flash' },
    ]);
    const result = await generateRegionalNarrative(menaRegion, stubSnapshot(), evidenceFixture, { callLlm });
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.narrative.situation.text, 'Iran flexes naval posture.');
  });

  it('falls through on all-empty-fields JSON from the first provider', async () => {
    const allEmpty = JSON.stringify({
      situation: { text: '', evidence_ids: [] },
      balance_assessment: { text: '', evidence_ids: [] },
      outlook_24h: { text: '', evidence_ids: [] },
      outlook_7d: { text: '', evidence_ids: [] },
      outlook_30d: { text: '', evidence_ids: [] },
      watch_items: [],
    });
    const callLlm = buildFallbackMock([
      { text: allEmpty, provider: 'groq', model: 'llama-3.3' },
      { text: validPayload, provider: 'openrouter', model: 'google/gemini-2.5-flash' },
    ]);
    const result = await generateRegionalNarrative(menaRegion, stubSnapshot(), evidenceFixture, { callLlm });
    assert.equal(result.provider, 'openrouter');
  });

  it('returns empty narrative when every provider returns malformed output', async () => {
    const callLlm = buildFallbackMock([
      { text: 'prose one', provider: 'groq', model: 'llama-3.3' },
      { text: 'prose two', provider: 'openrouter', model: 'google/gemini-2.5-flash' },
    ]);
    const result = await generateRegionalNarrative(menaRegion, stubSnapshot(), evidenceFixture, { callLlm });
    assert.deepEqual(result.narrative, emptyNarrative());
    assert.equal(result.provider, '');
  });
});

describe('evidence validator scoped to prompt-visible slice (P2 fix)', () => {
  it('rejects hallucinated citations to evidence beyond the visible window', async () => {
    // 20 evidence items; the prompt/validator should only see the first 15.
    // The LLM cites ev16 (beyond the window) — that citation must be stripped.
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `ev${i}`,
      type: 'market_signal',
      source: 'test',
      summary: `item ${i}`,
      confidence: 0.5,
      observed_at: 0,
      theater: '',
      corridor: '',
    }));
    const payload = JSON.stringify({
      // ev16 is in the full list (index 16) but NOT in the first-15 slice.
      situation: { text: 'Test citation filter.', evidence_ids: ['ev0', 'ev16', 'ev14'] },
      balance_assessment: { text: 'B.', evidence_ids: [] },
      outlook_24h: { text: 'O.', evidence_ids: [] },
      outlook_7d: { text: 'O.', evidence_ids: [] },
      outlook_30d: { text: 'O.', evidence_ids: [] },
      watch_items: [],
    });
    const callLlm = async () => ({ text: payload, provider: 'groq', model: 'llama-3.3' });
    const result = await generateRegionalNarrative(menaRegion, stubSnapshot(), many, { callLlm });
    // ev0 and ev14 are in the first-15 slice; ev16 is not.
    assert.deepEqual(result.narrative.situation.evidence_ids, ['ev0', 'ev14']);
  });

  it('allows citations to any of the first 15 items', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `ev${i}`,
      type: 'market_signal',
      source: 'test',
      summary: `item ${i}`,
      confidence: 0.5,
      observed_at: 0,
      theater: '',
      corridor: '',
    }));
    const payload = JSON.stringify({
      situation: { text: 'Cite the edges.', evidence_ids: ['ev0', 'ev14'] },
      balance_assessment: { text: '', evidence_ids: [] },
      outlook_24h: { text: '', evidence_ids: [] },
      outlook_7d: { text: '', evidence_ids: [] },
      outlook_30d: { text: '', evidence_ids: [] },
      watch_items: [],
    });
    const callLlm = async () => ({ text: payload, provider: 'groq', model: 'llama-3.3' });
    const result = await generateRegionalNarrative(menaRegion, stubSnapshot(), many, { callLlm });
    assert.deepEqual(result.narrative.situation.evidence_ids, ['ev0', 'ev14']);
  });
});

describe('narrative_model records actual provider output (P3 fix)', () => {
  it('passes the model value the default caller returned through to the meta', async () => {
    // Simulate the default caller picking up json.model (which may resolve
    // to a different concrete model than the one requested).
    const actualModel = 'llama-3.3-70b-versatile-0325';
    const payload = JSON.stringify({
      situation: { text: 'Test.', evidence_ids: [] },
      balance_assessment: { text: '', evidence_ids: [] },
      outlook_24h: { text: '', evidence_ids: [] },
      outlook_7d: { text: '', evidence_ids: [] },
      outlook_30d: { text: '', evidence_ids: [] },
      watch_items: [],
    });
    const callLlm = async () => ({ text: payload, provider: 'groq', model: actualModel });
    const result = await generateRegionalNarrative(menaRegion, stubSnapshot(), evidenceFixture, { callLlm });
    assert.equal(result.model, actualModel);
  });
});
