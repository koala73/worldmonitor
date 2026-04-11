// Tests for the RegionalIntelligenceBoard pure HTML builders.
// The builders are exported so we can test without DOM / panel instantiation.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOARD_REGIONS,
  buildBoardHtml,
  buildNarrativeHtml,
  buildRegimeBlock,
  buildBalanceBlock,
  buildActorsBlock,
  buildScenariosBlock,
  buildTransmissionBlock,
  buildWatchlistBlock,
  buildMetaFooter,
  isLatestSequence,
} from '../src/components/regional-intelligence-board-utils';
import type {
  RegionalSnapshot,
  BalanceVector,
  ActorState,
  ScenarioSet,
  TransmissionPath,
  Trigger,
  RegionalNarrative,
  NarrativeSection,
} from '../src/generated/client/worldmonitor/intelligence/v1/service_client';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function balanceFixture(overrides: Partial<BalanceVector> = {}): BalanceVector {
  return {
    coercivePressure: 0.72,
    domesticFragility: 0.55,
    capitalStress: 0.40,
    energyVulnerability: 0.30,
    allianceCohesion: 0.60,
    maritimeAccess: 0.70,
    energyLeverage: 0.80,
    netBalance: 0.07,
    pressures: [],
    buffers: [],
    ...overrides,
  };
}

function snapshotFixture(overrides: Partial<RegionalSnapshot> = {}): RegionalSnapshot {
  return {
    regionId: 'mena',
    generatedAt: 1_700_000_000_000,
    meta: {
      snapshotId: 'snap-1',
      modelVersion: '0.1.0',
      scoringVersion: '1.0.0',
      geographyVersion: '1.0.0',
      snapshotConfidence: 0.92,
      missingInputs: [],
      staleInputs: [],
      validUntil: 0,
      triggerReason: 'scheduled_6h',
      narrativeProvider: 'groq',
      narrativeModel: 'llama-3.3-70b-versatile',
    },
    regime: {
      label: 'coercive_stalemate',
      previousLabel: 'calm',
      transitionedAt: 1_700_000_000_000,
      transitionDriver: 'cross_source_surge',
    },
    balance: balanceFixture(),
    actors: [
      { actorId: 'IR', name: 'Iran', role: 'aggressor', leverageDomains: ['military', 'energy'], leverageScore: 0.85, delta: 0.05, evidenceIds: [] },
      { actorId: 'IL', name: 'Israel', role: 'stabilizer', leverageDomains: ['military'], leverageScore: 0.70, delta: 0.00, evidenceIds: [] },
      { actorId: 'SA', name: 'Saudi Arabia', role: 'broker', leverageDomains: ['energy'], leverageScore: 0.65, delta: -0.02, evidenceIds: [] },
    ],
    leverageEdges: [],
    scenarioSets: [
      { horizon: '24h', lanes: [
        { name: 'base', probability: 0.5, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'escalation', probability: 0.3, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'containment', probability: 0.15, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'fragmentation', probability: 0.05, triggerIds: [], consequences: [], transmissions: [] },
      ] },
      { horizon: '7d', lanes: [
        { name: 'base', probability: 0.4, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'escalation', probability: 0.4, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'containment', probability: 0.15, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'fragmentation', probability: 0.05, triggerIds: [], consequences: [], transmissions: [] },
      ] },
      { horizon: '30d', lanes: [
        { name: 'base', probability: 0.35, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'escalation', probability: 0.45, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'containment', probability: 0.15, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'fragmentation', probability: 0.05, triggerIds: [], consequences: [], transmissions: [] },
      ] },
    ],
    transmissionPaths: [
      { start: 'hormuz', mechanism: 'naval_posture', end: 'crude_oil', severity: 'high', corridorId: 'hormuz', confidence: 0.85, latencyHours: 12, impactedAssetClass: 'commodity', impactedRegions: ['mena'], magnitudeLow: 0, magnitudeHigh: 0, magnitudeUnit: 'pct', templateId: 't1', templateVersion: '1.0.0' },
      { start: 'babelm', mechanism: 'shipping_disruption', end: 'container', severity: 'medium', corridorId: 'babelm', confidence: 0.6, latencyHours: 24, impactedAssetClass: 'commodity', impactedRegions: ['mena'], magnitudeLow: 0, magnitudeHigh: 0, magnitudeUnit: 'pct', templateId: 't2', templateVersion: '1.0.0' },
    ],
    triggers: {
      active: [
        { id: 'mena_coercive_high', description: 'Coercive pressure crossed 0.7', threshold: undefined, activated: true, activatedAt: 0, scenarioLane: 'escalation', evidenceIds: [] },
      ],
      watching: [],
      dormant: [],
    },
    mobility: undefined,
    evidence: [],
    narrative: {
      situation: { text: 'Iran flexes naval posture near the Strait of Hormuz.', evidenceIds: ['ev1'] },
      balanceAssessment: { text: 'Pressures edge ahead of buffers.', evidenceIds: ['ev2'] },
      outlook24h: { text: 'Base case dominates.', evidenceIds: [] },
      outlook7d: { text: 'Escalation risk rises over the coming week.', evidenceIds: [] },
      outlook30d: { text: 'Uncertainty widens.', evidenceIds: [] },
      watchItems: [
        { text: 'Hormuz transit counts below seasonal.', evidenceIds: ['ev1'] },
      ],
    },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// BOARD_REGIONS
// ────────────────────────────────────────────────────────────────────────────

describe('BOARD_REGIONS', () => {
  it('exposes 7 non-global regions', () => {
    assert.equal(BOARD_REGIONS.length, 7);
    assert.ok(!BOARD_REGIONS.some((r) => r.id === 'global'));
  });

  it('includes every expected region ID', () => {
    const ids = BOARD_REGIONS.map((r) => r.id).sort();
    assert.deepEqual(ids, [
      'east-asia',
      'europe',
      'latam',
      'mena',
      'north-america',
      'south-asia',
      'sub-saharan-africa',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildRegimeBlock
// ────────────────────────────────────────────────────────────────────────────

describe('buildRegimeBlock', () => {
  it('renders the current regime label', () => {
    const html = buildRegimeBlock(snapshotFixture());
    assert.match(html, /coercive stalemate/i);
  });

  it('shows the "Was:" line when regime changed', () => {
    const html = buildRegimeBlock(snapshotFixture());
    assert.match(html, /Was:\s*calm/);
    assert.match(html, /cross_source_surge/);
  });

  it('hides the "Was:" line when regime is unchanged', () => {
    const html = buildRegimeBlock(snapshotFixture({
      regime: { label: 'calm', previousLabel: 'calm', transitionedAt: 0, transitionDriver: '' },
    }));
    assert.doesNotMatch(html, /Was:/);
  });

  it('handles missing regime by falling back to "unknown"', () => {
    const html = buildRegimeBlock(snapshotFixture({ regime: undefined }));
    assert.match(html, /unknown/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildBalanceBlock
// ────────────────────────────────────────────────────────────────────────────

describe('buildBalanceBlock', () => {
  it('renders all 4 pressure axes and 3 buffer axes', () => {
    const html = buildBalanceBlock(balanceFixture());
    assert.match(html, /Coercive/);
    assert.match(html, /Fragility/);
    assert.match(html, /Capital/);
    assert.match(html, /Energy Vuln/);
    assert.match(html, /Alliance/);
    assert.match(html, /Maritime/);
    assert.match(html, /Energy Lev/);
  });

  it('renders the net_balance bar', () => {
    const html = buildBalanceBlock(balanceFixture({ netBalance: -0.25 }));
    assert.match(html, /Net Balance/);
    assert.match(html, /-0\.25/);
  });

  it('shows "Unavailable" when balance is missing', () => {
    const html = buildBalanceBlock(undefined);
    assert.match(html, /Unavailable/);
  });

  it('clamps axis values to [0, 1] for bar width', () => {
    // A value > 1 should not break the HTML.
    const html = buildBalanceBlock(balanceFixture({ coercivePressure: 1.5 }));
    assert.match(html, /width:100\.0%/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildActorsBlock
// ────────────────────────────────────────────────────────────────────────────

describe('buildActorsBlock', () => {
  it('renders all actors up to the top-5 cap', () => {
    const actors: ActorState[] = Array.from({ length: 10 }, (_, i) => ({
      actorId: `a${i}`,
      name: `Actor ${i}`,
      role: 'actor',
      leverageDomains: [],
      leverageScore: 1 - i * 0.1,
      delta: 0,
      evidenceIds: [],
    }));
    const html = buildActorsBlock(actors);
    assert.match(html, /Actor 0/);
    assert.match(html, /Actor 4/);
    assert.doesNotMatch(html, /Actor 5/);
  });

  it('sorts actors by leverage_score descending', () => {
    const html = buildActorsBlock([
      { actorId: 'Z', name: 'Low', role: 'actor', leverageDomains: [], leverageScore: 0.1, delta: 0, evidenceIds: [] },
      { actorId: 'A', name: 'High', role: 'actor', leverageDomains: [], leverageScore: 0.9, delta: 0, evidenceIds: [] },
    ]);
    const highIdx = html.indexOf('High');
    const lowIdx = html.indexOf('Low');
    assert.ok(highIdx < lowIdx, 'high-leverage actor should appear first');
  });

  it('colors positive delta (rising) differently from negative', () => {
    const html = buildActorsBlock([
      { actorId: 'A', name: 'Rising', role: 'actor', leverageDomains: [], leverageScore: 0.5, delta: 0.1, evidenceIds: [] },
      { actorId: 'B', name: 'Falling', role: 'actor', leverageDomains: [], leverageScore: 0.4, delta: -0.1, evidenceIds: [] },
    ]);
    // Positive delta uses danger color; negative uses accent.
    assert.match(html, /\+0\.10/);
    assert.match(html, /-0\.10/);
  });

  it('shows empty-state when no actors', () => {
    const html = buildActorsBlock([]);
    assert.match(html, /No actor data/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildScenariosBlock
// ────────────────────────────────────────────────────────────────────────────

describe('buildScenariosBlock', () => {
  it('renders one column per horizon in canonical order 24h → 7d → 30d', () => {
    const html = buildScenariosBlock(snapshotFixture().scenarioSets);
    const i24 = html.indexOf('24h');
    const i7d = html.indexOf('7d');
    const i30d = html.indexOf('30d');
    assert.ok(i24 < i7d && i7d < i30d, `horizons out of order: 24h=${i24}, 7d=${i7d}, 30d=${i30d}`);
  });

  it('renders lane probabilities as percentages', () => {
    const html = buildScenariosBlock(snapshotFixture().scenarioSets);
    assert.match(html, /50%/); // 24h base
    assert.match(html, /45%/); // 30d escalation
  });

  it('sorts lanes within each horizon by probability descending', () => {
    const html = buildScenariosBlock([
      { horizon: '24h', lanes: [
        { name: 'fragmentation', probability: 0.05, triggerIds: [], consequences: [], transmissions: [] },
        { name: 'base', probability: 0.8, triggerIds: [], consequences: [], transmissions: [] },
      ] },
    ]);
    assert.ok(html.indexOf('base') < html.indexOf('fragmentation'));
  });

  it('shows empty-state when no scenarios', () => {
    const html = buildScenariosBlock([]);
    assert.match(html, /No scenario data/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildTransmissionBlock
// ────────────────────────────────────────────────────────────────────────────

describe('buildTransmissionBlock', () => {
  it('renders each transmission path with mechanism + corridor + severity', () => {
    const html = buildTransmissionBlock(snapshotFixture().transmissionPaths);
    assert.match(html, /naval_posture/);
    assert.match(html, /hormuz/);
    assert.match(html, /high/i);
  });

  it('sorts transmissions by confidence descending', () => {
    const paths: TransmissionPath[] = [
      { start: 'a', mechanism: 'low_conf', end: 'x', severity: 'low', corridorId: '', confidence: 0.2, latencyHours: 0, impactedAssetClass: '', impactedRegions: [], magnitudeLow: 0, magnitudeHigh: 0, magnitudeUnit: '', templateId: '', templateVersion: '' },
      { start: 'b', mechanism: 'high_conf', end: 'y', severity: 'high', corridorId: '', confidence: 0.9, latencyHours: 0, impactedAssetClass: '', impactedRegions: [], magnitudeLow: 0, magnitudeHigh: 0, magnitudeUnit: '', templateId: '', templateVersion: '' },
    ];
    const html = buildTransmissionBlock(paths);
    assert.ok(html.indexOf('high_conf') < html.indexOf('low_conf'));
  });

  it('caps transmissions at top 5', () => {
    const paths: TransmissionPath[] = Array.from({ length: 10 }, (_, i) => ({
      start: 's', mechanism: `m${i}`, end: 'e', severity: 'low', corridorId: '', confidence: 1 - i * 0.1, latencyHours: 0, impactedAssetClass: '', impactedRegions: [], magnitudeLow: 0, magnitudeHigh: 0, magnitudeUnit: '', templateId: '', templateVersion: '',
    }));
    const html = buildTransmissionBlock(paths);
    assert.match(html, /m0/);
    assert.match(html, /m4/);
    assert.doesNotMatch(html, /m5\b/);
  });

  it('shows empty-state when no transmissions', () => {
    const html = buildTransmissionBlock([]);
    assert.match(html, /No active transmissions/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildWatchlistBlock
// ────────────────────────────────────────────────────────────────────────────

describe('buildWatchlistBlock', () => {
  it('renders active triggers + narrative watch items', () => {
    const triggers: Trigger[] = [
      { id: 'trig1', description: 'desc', threshold: undefined, activated: true, activatedAt: 0, scenarioLane: 'escalation', evidenceIds: [] },
    ];
    const watchItems: NarrativeSection[] = [
      { text: 'Watch Hormuz volumes', evidenceIds: [] },
    ];
    const html = buildWatchlistBlock(triggers, watchItems);
    assert.match(html, /trig1/);
    assert.match(html, /Watch Hormuz volumes/);
    assert.match(html, /Active Triggers/);
    assert.match(html, /Watch Items/);
  });

  it('shows only triggers when watch items are empty', () => {
    const html = buildWatchlistBlock([
      { id: 'trig1', description: '', threshold: undefined, activated: true, activatedAt: 0, scenarioLane: 'escalation', evidenceIds: [] },
    ], []);
    assert.match(html, /Active Triggers/);
    assert.doesNotMatch(html, /Watch Items/);
  });

  it('shows only watch items when triggers are empty', () => {
    const html = buildWatchlistBlock([], [{ text: 'Watch this', evidenceIds: [] }]);
    assert.doesNotMatch(html, /Active Triggers/);
    assert.match(html, /Watch this/);
  });

  it('filters watch items with empty text', () => {
    const html = buildWatchlistBlock([], [
      { text: '', evidenceIds: [] },
      { text: 'Real item', evidenceIds: [] },
    ]);
    assert.match(html, /Real item/);
    // No empty bullet rows.
    assert.doesNotMatch(html, /▸\s*<\/div>/);
  });

  it('shows empty-state when both sources are empty', () => {
    const html = buildWatchlistBlock([], []);
    assert.match(html, /No active triggers or watch items/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildNarrativeHtml
// ────────────────────────────────────────────────────────────────────────────

describe('buildNarrativeHtml', () => {
  it('renders all populated sections', () => {
    const html = buildNarrativeHtml(snapshotFixture().narrative);
    assert.match(html, /Iran flexes naval posture/);
    assert.match(html, /Pressures edge ahead/);
    assert.match(html, /Base case dominates/);
  });

  it('hides empty sections', () => {
    const narrative: RegionalNarrative = {
      situation: { text: 'Only this one.', evidenceIds: [] },
      balanceAssessment: { text: '', evidenceIds: [] },
      outlook24h: { text: '', evidenceIds: [] },
      outlook7d: { text: '', evidenceIds: [] },
      outlook30d: { text: '', evidenceIds: [] },
      watchItems: [],
    };
    const html = buildNarrativeHtml(narrative);
    assert.match(html, /Only this one/);
    assert.doesNotMatch(html, /Outlook/);
    assert.doesNotMatch(html, /Balance Assessment/);
  });

  it('returns empty string when the whole narrative is empty', () => {
    const narrative: RegionalNarrative = {
      situation: { text: '', evidenceIds: [] },
      balanceAssessment: { text: '', evidenceIds: [] },
      outlook24h: { text: '', evidenceIds: [] },
      outlook7d: { text: '', evidenceIds: [] },
      outlook30d: { text: '', evidenceIds: [] },
      watchItems: [],
    };
    assert.equal(buildNarrativeHtml(narrative), '');
  });

  it('returns empty string when narrative is undefined', () => {
    assert.equal(buildNarrativeHtml(undefined), '');
  });

  it('displays evidence ID pills when present', () => {
    const html = buildNarrativeHtml(snapshotFixture().narrative);
    assert.match(html, /\[ev1\]/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildMetaFooter
// ────────────────────────────────────────────────────────────────────────────

describe('buildMetaFooter', () => {
  it('renders confidence, versions, and narrative source', () => {
    const html = buildMetaFooter(snapshotFixture());
    assert.match(html, /confidence 92%/);
    assert.match(html, /scoring v1\.0\.0/);
    assert.match(html, /geo v1\.0\.0/);
    assert.match(html, /groq\/llama-3\.3-70b-versatile/);
  });

  it('shows "no narrative" when provider is empty', () => {
    const html = buildMetaFooter(snapshotFixture({
      meta: { ...snapshotFixture().meta!, narrativeProvider: '', narrativeModel: '' },
    }));
    assert.match(html, /no narrative/);
  });

  it('returns empty string when meta is missing', () => {
    assert.equal(buildMetaFooter(snapshotFixture({ meta: undefined })), '');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildBoardHtml (integration)
// ────────────────────────────────────────────────────────────────────────────

describe('buildBoardHtml', () => {
  it('includes all 6 block titles + narrative + meta footer', () => {
    const html = buildBoardHtml(snapshotFixture());
    assert.match(html, /Narrative/);
    assert.match(html, /Regime/);
    assert.match(html, /Balance Vector/);
    assert.match(html, /Actors/);
    assert.match(html, /Scenarios/);
    assert.match(html, /Transmission Paths/);
    assert.match(html, /Watchlist/);
    assert.match(html, /generated/);
    assert.match(html, /confidence/);
  });

  it('escapes user-provided strings to prevent HTML injection', () => {
    const malicious = snapshotFixture({
      actors: [{
        actorId: 'A1',
        name: '<img src=x onerror=alert(1)>',
        role: '<script>bad()</script>',
        leverageDomains: [],
        leverageScore: 0.5,
        delta: 0,
        evidenceIds: [],
      }],
    });
    const html = buildBoardHtml(malicious);
    // Raw HTML must not appear...
    assert.doesNotMatch(html, /<img src=x onerror/);
    assert.doesNotMatch(html, /<script>bad/);
    // ...and the escaped versions must appear.
    assert.match(html, /&lt;img src=x onerror/);
    assert.match(html, /&lt;script&gt;bad/);
  });

  it('renders a mostly-empty snapshot without throwing', () => {
    const bare = snapshotFixture({
      actors: [],
      scenarioSets: [],
      transmissionPaths: [],
      triggers: { active: [], watching: [], dormant: [] },
      narrative: undefined,
    });
    assert.doesNotThrow(() => buildBoardHtml(bare));
    const html = buildBoardHtml(bare);
    assert.match(html, /No actor data/);
    assert.match(html, /No scenario data/);
    assert.match(html, /No active transmissions/);
    assert.match(html, /No active triggers or watch items/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Request-sequence arbitrator (P2 fix for PR #2963 review)
// ────────────────────────────────────────────────────────────────────────────

describe('isLatestSequence', () => {
  it('returns true when the claimed sequence still matches latest', () => {
    assert.equal(isLatestSequence(1, 1), true);
    assert.equal(isLatestSequence(42, 42), true);
  });

  it('returns false when a newer sequence has claimed latest', () => {
    assert.equal(isLatestSequence(1, 2), false);
    assert.equal(isLatestSequence(9, 10), false);
  });

  it('returns false for any mismatch (even when mine > latest, defensive)', () => {
    assert.equal(isLatestSequence(5, 3), false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Simulated fast-dropdown race (P2 fix for PR #2963 review)
// ────────────────────────────────────────────────────────────────────────────
//
// Mimics the loadCurrent() flow without instantiating the Panel class
// (which transitively imports @/services/i18n and fails node:test).
// Each "load" claims a sequence, awaits a controllable RPC, then calls a
// rendered callback ONLY if isLatestSequence(mySeq, latestSeq). The test
// orchestrates two overlapping loads where the first RPC resolves AFTER
// the second, and asserts only the second render fires.

describe('loadCurrent race simulation', () => {
  it('drops an earlier in-flight response when a later region is selected', async () => {
    const state = { latestSequence: 0, currentRegion: 'mena', rendered: [] as string[] };

    // Two resolvable deferreds so the test controls finish order.
    let resolveA: (value: string) => void;
    let resolveB: (value: string) => void;
    const pA = new Promise<string>((resolve) => { resolveA = resolve; });
    const pB = new Promise<string>((resolve) => { resolveB = resolve; });

    async function loadCurrent(regionId: string, promise: Promise<string>) {
      state.latestSequence += 1;
      const mySeq = state.latestSequence;
      state.currentRegion = regionId;
      const result = await promise;
      if (!isLatestSequence(mySeq, state.latestSequence)) return;
      state.rendered.push(`${regionId}:${result}`);
    }

    // Kick off call A (mena), then call B (east-asia) — call B claims
    // the later sequence. Order of resolution is intentionally reversed:
    // B resolves first, then A. A must be discarded as stale.
    const loadA = loadCurrent('mena', pA);
    const loadB = loadCurrent('east-asia', pB);

    resolveB!('snapshot-east-asia');
    await loadB;
    resolveA!('snapshot-mena');
    await loadA;

    assert.deepEqual(state.rendered, ['east-asia:snapshot-east-asia']);
  });

  it('renders the latest load even when it resolves before an earlier one', async () => {
    const state = { latestSequence: 0, rendered: [] as string[] };

    let resolveA: (value: string) => void;
    let resolveB: (value: string) => void;
    const pA = new Promise<string>((resolve) => { resolveA = resolve; });
    const pB = new Promise<string>((resolve) => { resolveB = resolve; });

    async function loadCurrent(regionId: string, promise: Promise<string>) {
      state.latestSequence += 1;
      const mySeq = state.latestSequence;
      const result = await promise;
      if (!isLatestSequence(mySeq, state.latestSequence)) return;
      state.rendered.push(`${regionId}:${result}`);
    }

    const loadA = loadCurrent('mena', pA);
    const loadB = loadCurrent('europe', pB);

    // A resolves first (normal ordering), but B has claimed a later seq,
    // so when A checks the arbitrator (seq 1 vs latest 2) it discards.
    resolveA!('snap-a');
    await loadA;
    resolveB!('snap-b');
    await loadB;

    assert.deepEqual(state.rendered, ['europe:snap-b']);
  });

  it('three rapid switches render only the last one', async () => {
    const state = { latestSequence: 0, rendered: [] as string[] };

    const resolvers: Array<(value: string) => void> = [];
    const promises = [0, 1, 2].map(
      () => new Promise<string>((resolve) => { resolvers.push(resolve); }),
    );

    async function loadCurrent(regionId: string, promise: Promise<string>) {
      state.latestSequence += 1;
      const mySeq = state.latestSequence;
      const result = await promise;
      if (!isLatestSequence(mySeq, state.latestSequence)) return;
      state.rendered.push(`${regionId}:${result}`);
    }

    const loadMena = loadCurrent('mena', promises[0]!);
    const loadEu = loadCurrent('europe', promises[1]!);
    const loadEa = loadCurrent('east-asia', promises[2]!);

    // Resolve out of order: middle first, then last, then first.
    resolvers[1]!('snap-eu');
    await loadEu;
    resolvers[2]!('snap-ea');
    await loadEa;
    resolvers[0]!('snap-mena');
    await loadMena;

    assert.deepEqual(state.rendered, ['east-asia:snap-ea']);
  });

  it('a single load (no race) still renders', async () => {
    const state = { latestSequence: 0, rendered: [] as string[] };
    async function loadCurrent(regionId: string, promise: Promise<string>) {
      state.latestSequence += 1;
      const mySeq = state.latestSequence;
      const result = await promise;
      if (!isLatestSequence(mySeq, state.latestSequence)) return;
      state.rendered.push(`${regionId}:${result}`);
    }
    await loadCurrent('mena', Promise.resolve('snap'));
    assert.deepEqual(state.rendered, ['mena:snap']);
  });
});
