import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adaptSnapshot } from '../server/worldmonitor/intelligence/v1/get-regional-snapshot';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const handlerSrc = readFileSync(
  resolve(root, 'server/worldmonitor/intelligence/v1/get-regional-snapshot.ts'),
  'utf-8',
);

const handlerIndexSrc = readFileSync(
  resolve(root, 'server/worldmonitor/intelligence/v1/handler.ts'),
  'utf-8',
);

const premiumPathsSrc = readFileSync(
  resolve(root, 'src/shared/premium-paths.ts'),
  'utf-8',
);

const gatewaySrc = readFileSync(
  resolve(root, 'server/gateway.ts'),
  'utf-8',
);

const protoSrc = readFileSync(
  resolve(root, 'proto/worldmonitor/intelligence/v1/get_regional_snapshot.proto'),
  'utf-8',
);

// ────────────────────────────────────────────────────────────────────────────
// adaptSnapshot: snake_case -> camelCase adapter (the substantive logic)
// ────────────────────────────────────────────────────────────────────────────

describe('adaptSnapshot', () => {
  it('maps all top-level region fields', () => {
    const result = adaptSnapshot({
      region_id: 'mena',
      generated_at: 1_700_000_000_000,
    });
    assert.equal(result.regionId, 'mena');
    assert.equal(result.generatedAt, 1_700_000_000_000);
  });

  it('defaults missing top-level fields to empty values', () => {
    const result = adaptSnapshot({});
    assert.equal(result.regionId, '');
    assert.equal(result.generatedAt, 0);
    assert.deepEqual(result.actors, []);
    assert.deepEqual(result.leverageEdges, []);
    assert.deepEqual(result.scenarioSets, []);
    assert.deepEqual(result.transmissionPaths, []);
    assert.deepEqual(result.evidence, []);
  });

  it('adapts SnapshotMeta fields', () => {
    const result = adaptSnapshot({
      meta: {
        snapshot_id: 'abc123',
        model_version: '0.1.0',
        scoring_version: '1.0.0',
        geography_version: '1.0.0',
        snapshot_confidence: 0.85,
        missing_inputs: ['forecast:predictions:v2'],
        stale_inputs: [],
        valid_until: 1_700_021_600_000,
        trigger_reason: 'scheduled_6h',
        narrative_provider: 'groq',
        narrative_model: 'mixtral-8x7b',
      },
    });
    assert.ok(result.meta);
    assert.equal(result.meta.snapshotId, 'abc123');
    assert.equal(result.meta.modelVersion, '0.1.0');
    assert.equal(result.meta.scoringVersion, '1.0.0');
    assert.equal(result.meta.snapshotConfidence, 0.85);
    assert.deepEqual(result.meta.missingInputs, ['forecast:predictions:v2']);
    assert.equal(result.meta.validUntil, 1_700_021_600_000);
    assert.equal(result.meta.triggerReason, 'scheduled_6h');
    assert.equal(result.meta.narrativeProvider, 'groq');
    assert.equal(result.meta.narrativeModel, 'mixtral-8x7b');
  });

  it('adapts RegimeState', () => {
    const result = adaptSnapshot({
      regime: {
        label: 'stressed_equilibrium',
        previous_label: 'calm',
        transitioned_at: 1_700_000_000_000,
        transition_driver: 'diff-engine',
      },
    });
    assert.ok(result.regime);
    assert.equal(result.regime.label, 'stressed_equilibrium');
    assert.equal(result.regime.previousLabel, 'calm');
    assert.equal(result.regime.transitionedAt, 1_700_000_000_000);
    assert.equal(result.regime.transitionDriver, 'diff-engine');
  });

  it('adapts BalanceVector with all 7 axes', () => {
    const result = adaptSnapshot({
      balance: {
        coercive_pressure: 0.72,
        domestic_fragility: 0.58,
        capital_stress: 0.45,
        energy_vulnerability: 0.3,
        alliance_cohesion: 0.62,
        maritime_access: 0.55,
        energy_leverage: 0.8,
        net_balance: 0.12,
        pressures: [
          { axis: 'coercive_pressure', description: 'IRGC naval', magnitude: 0.72, evidence_ids: ['xss:1'], orientation: 'pressure' },
        ],
        buffers: [
          { axis: 'energy_leverage', description: '6 producers', magnitude: 1.0, evidence_ids: [], orientation: 'buffer' },
        ],
      },
    });
    assert.ok(result.balance);
    assert.equal(result.balance.coercivePressure, 0.72);
    assert.equal(result.balance.domesticFragility, 0.58);
    assert.equal(result.balance.capitalStress, 0.45);
    assert.equal(result.balance.energyVulnerability, 0.3);
    assert.equal(result.balance.allianceCohesion, 0.62);
    assert.equal(result.balance.maritimeAccess, 0.55);
    assert.equal(result.balance.energyLeverage, 0.8);
    assert.equal(result.balance.netBalance, 0.12);
    assert.equal(result.balance.pressures.length, 1);
    assert.equal(result.balance.pressures[0]?.axis, 'coercive_pressure');
    assert.deepEqual(result.balance.pressures[0]?.evidenceIds, ['xss:1']);
    assert.equal(result.balance.buffers.length, 1);
  });

  it('adapts ActorState array', () => {
    const result = adaptSnapshot({
      actors: [
        {
          actor_id: 'iran',
          name: 'Iran',
          role: 'aggressor',
          leverage_domains: ['military', 'energy'],
          leverage_score: 0.68,
          delta: 0,
          evidence_ids: ['forecast:f1'],
        },
      ],
    });
    assert.equal(result.actors.length, 1);
    const iran = result.actors[0];
    assert.ok(iran);
    assert.equal(iran.actorId, 'iran');
    assert.equal(iran.name, 'Iran');
    assert.equal(iran.role, 'aggressor');
    assert.deepEqual(iran.leverageDomains, ['military', 'energy']);
    assert.equal(iran.leverageScore, 0.68);
    assert.deepEqual(iran.evidenceIds, ['forecast:f1']);
  });

  it('adapts LeverageEdge array', () => {
    const result = adaptSnapshot({
      leverage_edges: [
        {
          from_actor_id: 'russia',
          to_actor_id: 'germany',
          mechanism: 'energy_supply',
          strength: 0.75,
          evidence_ids: ['e1'],
        },
      ],
    });
    assert.equal(result.leverageEdges.length, 1);
    const edge = result.leverageEdges[0];
    assert.ok(edge);
    assert.equal(edge.fromActorId, 'russia');
    assert.equal(edge.toActorId, 'germany');
    assert.equal(edge.mechanism, 'energy_supply');
    assert.equal(edge.strength, 0.75);
  });

  it('adapts ScenarioSet with nested lanes and transmissions', () => {
    const result = adaptSnapshot({
      scenario_sets: [
        {
          horizon: '24h',
          lanes: [
            {
              name: 'escalation',
              probability: 0.45,
              trigger_ids: ['t1', 't2'],
              consequences: ['price spike'],
              transmissions: [
                {
                  start: 'Hormuz threat',
                  mechanism: 'insurance spike',
                  end: 'Brent +$10',
                  severity: 'critical',
                  corridor_id: 'hormuz',
                  confidence: 0.85,
                  latency_hours: 24,
                  impacted_asset_class: 'crude',
                  impacted_regions: ['mena', 'east-asia'],
                  magnitude_low: 10,
                  magnitude_high: 25,
                  magnitude_unit: 'usd_bbl',
                  template_id: 'hormuz_blockade',
                  template_version: '1.0.0',
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(result.scenarioSets.length, 1);
    const set = result.scenarioSets[0];
    assert.ok(set);
    assert.equal(set.horizon, '24h');
    assert.equal(set.lanes.length, 1);
    const lane = set.lanes[0];
    assert.ok(lane);
    assert.equal(lane.name, 'escalation');
    assert.equal(lane.probability, 0.45);
    assert.deepEqual(lane.triggerIds, ['t1', 't2']);
    assert.equal(lane.transmissions.length, 1);
    const trans = lane.transmissions[0];
    assert.ok(trans);
    assert.equal(trans.corridorId, 'hormuz');
    assert.equal(trans.latencyHours, 24);
    assert.equal(trans.impactedAssetClass, 'crude');
    assert.deepEqual(trans.impactedRegions, ['mena', 'east-asia']);
    assert.equal(trans.magnitudeLow, 10);
    assert.equal(trans.magnitudeHigh, 25);
    assert.equal(trans.templateId, 'hormuz_blockade');
    assert.equal(trans.templateVersion, '1.0.0');
  });

  it('adapts TriggerLadder with all three buckets and nested TriggerThreshold', () => {
    const result = adaptSnapshot({
      triggers: {
        active: [
          {
            id: 'hormuz_transit_drop',
            description: 'Hormuz transit drops',
            threshold: {
              metric: 'chokepoint:hormuz:transit_count',
              operator: 'delta_lt',
              value: -0.20,
              window_minutes: 1440,
              baseline: 'trailing_7d',
            },
            activated: true,
            activated_at: 1_700_000_000_000,
            scenario_lane: 'escalation',
            evidence_ids: ['e1'],
          },
        ],
        watching: [],
        dormant: [],
      },
    });
    assert.ok(result.triggers);
    assert.equal(result.triggers.active.length, 1);
    assert.equal(result.triggers.watching.length, 0);
    assert.equal(result.triggers.dormant.length, 0);
    const trigger = result.triggers.active[0];
    assert.ok(trigger);
    assert.equal(trigger.id, 'hormuz_transit_drop');
    assert.equal(trigger.activated, true);
    assert.equal(trigger.activatedAt, 1_700_000_000_000);
    assert.equal(trigger.scenarioLane, 'escalation');
    assert.ok(trigger.threshold);
    assert.equal(trigger.threshold.metric, 'chokepoint:hormuz:transit_count');
    assert.equal(trigger.threshold.operator, 'delta_lt');
    assert.equal(trigger.threshold.value, -0.20);
    assert.equal(trigger.threshold.windowMinutes, 1440);
    assert.equal(trigger.threshold.baseline, 'trailing_7d');
  });

  it('adapts MobilityState with nested airspace/flight/airport arrays', () => {
    const result = adaptSnapshot({
      mobility: {
        airspace: [{ airspace_id: 'LLLL', status: 'restricted', reason: 'conflict' }],
        flight_corridors: [{ corridor: 'Tehran-Baghdad', stress_level: 0.8, rerouted_flights_24h: 42 }],
        airports: [{ icao: 'OIIE', name: 'Imam Khomeini', status: 'disrupted', disruption_reason: 'drills' }],
        reroute_intensity: 0.35,
        notam_closures: ['OIIX-A0042'],
      },
    });
    assert.ok(result.mobility);
    assert.equal(result.mobility.airspace.length, 1);
    const airspace = result.mobility.airspace[0];
    assert.ok(airspace);
    assert.equal(airspace.airspaceId, 'LLLL');
    assert.equal(result.mobility.flightCorridors.length, 1);
    const corr = result.mobility.flightCorridors[0];
    assert.ok(corr);
    assert.equal(corr.reroutedFlights24h, 42);
    assert.equal(result.mobility.airports.length, 1);
    const airport = result.mobility.airports[0];
    assert.ok(airport);
    assert.equal(airport.disruptionReason, 'drills');
    assert.equal(result.mobility.rerouteIntensity, 0.35);
    assert.deepEqual(result.mobility.notamClosures, ['OIIX-A0042']);
  });

  it('adapts EvidenceItem array', () => {
    const result = adaptSnapshot({
      evidence: [
        {
          id: 'cii:IR',
          type: 'cii_spike',
          source: 'risk-scores',
          summary: 'IR CII 78 (UP)',
          confidence: 0.9,
          observed_at: 1_700_000_000_000,
          theater: '',
          corridor: '',
        },
      ],
    });
    assert.equal(result.evidence.length, 1);
    const ev = result.evidence[0];
    assert.ok(ev);
    assert.equal(ev.id, 'cii:IR');
    assert.equal(ev.type, 'cii_spike');
    assert.equal(ev.source, 'risk-scores');
    assert.equal(ev.observedAt, 1_700_000_000_000);
  });

  it('adapts RegionalNarrative with all 5 sections plus watch_items', () => {
    const result = adaptSnapshot({
      narrative: {
        situation: { text: 'Situation text', evidence_ids: ['s1'] },
        balance_assessment: { text: 'Balance text', evidence_ids: ['b1'] },
        outlook_24h: { text: '24h outlook', evidence_ids: ['o24'] },
        outlook_7d: { text: '7d outlook', evidence_ids: ['o7'] },
        outlook_30d: { text: '30d outlook', evidence_ids: ['o30'] },
        watch_items: [
          { text: 'Item 1', evidence_ids: ['w1'] },
          { text: 'Item 2', evidence_ids: ['w2'] },
        ],
      },
    });
    assert.ok(result.narrative);
    assert.equal(result.narrative.situation?.text, 'Situation text');
    assert.deepEqual(result.narrative.situation?.evidenceIds, ['s1']);
    assert.equal(result.narrative.balanceAssessment?.text, 'Balance text');
    assert.equal(result.narrative.outlook24h?.text, '24h outlook');
    assert.equal(result.narrative.outlook7d?.text, '7d outlook');
    assert.equal(result.narrative.outlook30d?.text, '30d outlook');
    assert.equal(result.narrative.watchItems.length, 2);
    assert.equal(result.narrative.watchItems[0]?.text, 'Item 1');
  });

  it('is robust to missing nested fields (empty array defaults)', () => {
    const result = adaptSnapshot({
      region_id: 'mena',
      generated_at: 1_700_000_000_000,
      balance: {},
      triggers: {},
      mobility: {},
      narrative: {},
    });
    assert.ok(result.balance);
    assert.equal(result.balance.coercivePressure, 0);
    assert.deepEqual(result.balance.pressures, []);
    assert.ok(result.triggers);
    assert.deepEqual(result.triggers.active, []);
    assert.ok(result.mobility);
    assert.deepEqual(result.mobility.airspace, []);
    assert.ok(result.narrative);
    assert.deepEqual(result.narrative.watchItems, []);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Handler structural checks (static analysis)
// ────────────────────────────────────────────────────────────────────────────

describe('get-regional-snapshot handler: structural checks', () => {
  it('imports getCachedJson from redis helpers', () => {
    assert.match(handlerSrc, /import\s*\{\s*getCachedJson\s*\}\s*from\s*'\.\.\/\.\.\/\.\.\/_shared\/redis'/);
  });

  it('uses the canonical :latest key prefix', () => {
    assert.match(handlerSrc, /'intelligence:snapshot:v1:'/);
  });

  it('uses the canonical snapshot-by-id key prefix', () => {
    assert.match(handlerSrc, /'intelligence:snapshot-by-id:v1:'/);
  });

  it('reads latest pointer then snapshot-by-id (two-hop lookup)', () => {
    // latest resolved before snapKey construction
    const latestIdx = handlerSrc.indexOf('latestKey');
    const snapKeyIdx = handlerSrc.indexOf('snapKey');
    assert.ok(latestIdx > 0 && snapKeyIdx > latestIdx, 'latest must resolve before snap lookup');
  });

  it('returns empty response on missing snapshot id', () => {
    assert.match(handlerSrc, /if \(!snapshotId\) \{\s*return \{\}/);
  });

  it('returns empty response on missing persisted snapshot', () => {
    assert.match(handlerSrc, /if \(!persisted \|\| typeof persisted !== 'object'\) \{\s*return \{\}/);
  });

  it('calls adaptSnapshot to produce the wire shape', () => {
    assert.match(handlerSrc, /adaptSnapshot\(persisted\)/);
  });

  it('exports getRegionalSnapshot handler matching the service interface', () => {
    assert.match(handlerSrc, /export const getRegionalSnapshot: IntelligenceServiceHandler\['getRegionalSnapshot'\]/);
  });
});

describe('intelligence handler registration', () => {
  it('imports getRegionalSnapshot from get-regional-snapshot module', () => {
    assert.match(handlerIndexSrc, /import \{ getRegionalSnapshot \} from '\.\/get-regional-snapshot'/);
  });

  it('registers getRegionalSnapshot on the handler object', () => {
    assert.match(handlerIndexSrc, /\s+getRegionalSnapshot,/);
  });
});

describe('security wiring', () => {
  it('adds the endpoint to PREMIUM_RPC_PATHS', () => {
    assert.match(premiumPathsSrc, /'\/api\/intelligence\/v1\/get-regional-snapshot'/);
  });

  it('has a RPC_CACHE_TIER entry for route-parity (even though premium paths bypass it)', () => {
    // At runtime the gateway checks PREMIUM_RPC_PATHS first and short-circuits
    // to 'slow-browser' regardless of RPC_CACHE_TIER. The entry exists to satisfy
    // tests/route-cache-tier.test.mjs which enforces that every generated GET
    // route has an explicit tier, and documents the intended tier if the endpoint
    // ever becomes non-premium.
    assert.match(gatewaySrc, /'\/api\/intelligence\/v1\/get-regional-snapshot':\s*'slow'/);
  });
});

describe('proto definition', () => {
  it('declares the GetRegionalSnapshot RPC method', () => {
    const serviceProtoSrc = readFileSync(
      resolve(root, 'proto/worldmonitor/intelligence/v1/service.proto'),
      'utf-8',
    );
    assert.match(serviceProtoSrc, /rpc GetRegionalSnapshot\(GetRegionalSnapshotRequest\) returns \(GetRegionalSnapshotResponse\)/);
  });

  it('validates region_id as strict lowercase kebab pattern (no trailing or consecutive hyphens)', () => {
    // Pattern: ^[a-z][a-z0-9]*(-[a-z0-9]+)*$
    // - Starts with a lowercase letter
    // - Each hyphen must be followed by at least one alphanumeric character
    // - Rejects "mena-", "east-asia-", "foo--bar"
    assert.match(
      protoSrc,
      /buf\.validate\.field\)\.string\.pattern = "\^\[a-z\]\[a-z0-9\]\*\(-\[a-z0-9\]\+\)\*\$"/,
    );
  });

  it('defines RegionalSnapshot with all 13 top-level fields', () => {
    assert.match(protoSrc, /message RegionalSnapshot \{/);
    assert.match(protoSrc, /string region_id = 1/);
    assert.match(protoSrc, /int64 generated_at = 2/);
    assert.match(protoSrc, /SnapshotMeta meta = 3/);
    assert.match(protoSrc, /RegimeState regime = 4/);
    assert.match(protoSrc, /BalanceVector balance = 5/);
    assert.match(protoSrc, /repeated ActorState actors = 6/);
    assert.match(protoSrc, /repeated LeverageEdge leverage_edges = 7/);
    assert.match(protoSrc, /repeated ScenarioSet scenario_sets = 8/);
    assert.match(protoSrc, /repeated TransmissionPath transmission_paths = 9/);
    assert.match(protoSrc, /TriggerLadder triggers = 10/);
    assert.match(protoSrc, /MobilityState mobility = 11/);
    assert.match(protoSrc, /repeated EvidenceItem evidence = 12/);
    assert.match(protoSrc, /RegionalNarrative narrative = 13/);
  });

  it('defines BalanceVector with all 7 axes plus net_balance and drivers', () => {
    assert.match(protoSrc, /double coercive_pressure = 1/);
    assert.match(protoSrc, /double domestic_fragility = 2/);
    assert.match(protoSrc, /double capital_stress = 3/);
    assert.match(protoSrc, /double energy_vulnerability = 4/);
    assert.match(protoSrc, /double alliance_cohesion = 5/);
    assert.match(protoSrc, /double maritime_access = 6/);
    assert.match(protoSrc, /double energy_leverage = 7/);
    assert.match(protoSrc, /double net_balance = 8/);
  });
});
