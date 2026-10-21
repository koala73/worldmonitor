import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CHINA_DECISION_SIGNAL_SOURCE_KEYS,
  projectChinaDecisionSignalWireResponse,
  resolveChinaDecisionSignalSnapshot,
} from '../server/worldmonitor/intelligence/v1/get-china-decision-signals';

const ctx = {} as never;
const macroProvenance = JSON.parse(readFileSync(
  new URL('./fixtures/decision-signal-provenance/china-macro-official.json', import.meta.url),
  'utf8',
)).provenance as Record<string, unknown>;
const corridorProvenance = (
  JSON.parse(readFileSync(
    new URL('./fixtures/decision-signal-provenance/positive.json', import.meta.url),
    'utf8',
  )) as Array<{ id: string; provenance: Record<string, unknown> }>
).find((fixture) => fixture.id === 'corridor-stale-content')?.provenance;

function retargetProvenance(
  source: Record<string, unknown>,
  signalId: string,
): Record<string, unknown> {
  const value = structuredClone(source);
  value.signalId = signalId;
  const claims = value.claims as Record<string, {
    status: string;
    value?: Record<string, unknown>;
  }>;
  if (
    claims.original_reference?.status === 'known'
    && claims.original_reference.value
  ) {
    claims.original_reference.value.id = signalId;
  }
  return value;
}

describe('China decision-signal RPC composition (#5580)', () => {
  it('isolates source and RPC failures while returning the stable six-group wire shape', async () => {
    const reads: string[][] = [];
    const snapshot = await resolveChinaDecisionSignalSnapshot(ctx, {
      now: () => '2026-07-26T11:00:00Z',
      readBatch: async (keys, raw) => {
        assert.equal(raw, true);
        reads.push(keys);
        return new Map();
      },
      getMacro: async () => {
        throw new Error('macro unavailable');
      },
      getCorridors: async () => ({ corridors: [] }),
      getNowcast: async () => null,
    });

    assert.deepEqual(reads, [Object.values(CHINA_DECISION_SIGNAL_SOURCE_KEYS)]);
    assert.equal(snapshot.groups.length, 6);
    assert.equal(snapshot.groups.every((group) => group.state === 'unavailable'), true);

    const wire = projectChinaDecisionSignalWireResponse(snapshot);
    assert.equal(wire.generatedAt, '2026-07-26T11:00:00Z');
    assert.equal(wire.upstreamUnavailable, true);
    assert.deepEqual(JSON.parse(wire.payloadJson), snapshot);
  });

  it('does not convert one failed cache batch into a failure of independent composed endpoints', async () => {
    assert.ok(corridorProvenance);
    const macroSignal = retargetProvenance(macroProvenance, 'macro:gdp:2026-q2');
    const corridorSignal = retargetProvenance(
      corridorProvenance,
      'corridor:shanghai-port:2026-07-26',
    );
    const snapshot = await resolveChinaDecisionSignalSnapshot(ctx, {
      now: () => '2026-07-26T11:00:00Z',
      readBatch: async () => {
        throw new Error('redis batch unavailable');
      },
      getMacro: async () => ({
        unavailable: false,
        indicators: [{
          label: 'Industrial production',
          value: 5.4,
          unit: '%',
          category: 'activity',
          direction: 'strengthening',
          vintageId: '2026-06:v1',
          provenanceJson: JSON.stringify(macroSignal),
        }],
      }),
      getCorridors: async () => ({
        corridors: [{
          id: 'shanghai-export',
          name: 'Shanghai export corridor',
          availability: 'available',
          conditions: [{
            family: 'port',
            availability: 'stale',
            summary: 'Port calls below recent baseline',
            provenance: corridorSignal,
          }],
        }],
      }),
      getNowcast: async () => ({
        methodVersion: 'china-activity-nowcast/v1',
        evaluatedAt: '2026-07-26T11:00:00Z',
        comparisonWindow: { endsAt: '2026-07-26T11:00:00Z' },
        state: 'agreement',
        official: { provenance: macroSignal },
        contributions: [{
          included: true,
          observationId: 'corridor:shanghai-port:2026-07-26',
          provenance: corridorSignal,
        }],
        confidence: { level: 'high' },
      }),
    });

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.groups.length, 6);
    assert.deepEqual(
      snapshot.groups
        .filter((group) => group.state !== 'unavailable')
        .map((group) => group.id),
      ['macro', 'corridor-conditions', 'activity-nowcast'],
    );
    assert.deepEqual(
      snapshot.groups
        .filter((group) => [
          'policy-enforcement',
          'cross-strait-activity',
          'corporate-disclosures',
        ].includes(group.id))
        .map((group) => group.state),
      ['unavailable', 'unavailable', 'unavailable'],
    );
    assert.deepEqual(snapshot.access, {
      anonymous: 'bounded_public_summary',
      pro: 'same_provenance_via_mcp',
      operator: 'source_health_only',
    });
  });
});
