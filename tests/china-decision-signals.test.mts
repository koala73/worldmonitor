import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CHINA_DECISION_SIGNAL_GROUP_IDS,
  CHINA_DECISION_SIGNAL_MAX_SERIALIZED_BYTES,
  composeChinaDecisionSignals,
  isChinaDecisionSignalSnapshot,
} from '../shared/china-decision-signals';
import { TOOL_REGISTRY } from '../api/mcp/registry';
import {
  DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS,
  validateDecisionSignalProvenance,
} from '../shared/decision-signal-provenance';

type Fixture = {
  id: string;
  familyId: string;
  provenance: Record<string, unknown>;
};

const positive = JSON.parse(readFileSync(
  new URL('./fixtures/decision-signal-provenance/positive.json', import.meta.url),
  'utf8',
)) as Fixture[];
const macro = JSON.parse(readFileSync(
  new URL('./fixtures/decision-signal-provenance/china-macro-official.json', import.meta.url),
  'utf8',
)) as Fixture;

function provenance(id: string): Record<string, unknown> {
  const fixture = id === macro.id
    ? macro
    : positive.find((candidate) => candidate.id === id);
  assert.ok(fixture, `missing fixture ${id}`);
  return structuredClone(fixture.provenance);
}

function retarget(
  value: Record<string, unknown>,
  signalId: string,
): Record<string, unknown> {
  value.signalId = signalId;
  const originalReference = (
    value.claims as Record<string, { status: string; value?: Record<string, unknown> }>
  ).original_reference;
  if (originalReference.status === 'known' && originalReference.value) {
    originalReference.value.id = signalId;
  }
  return value;
}

describe('China decision-signal final composition (#5580)', () => {
  it('publishes all six launched domains through one ordered, provenance-valid contract', () => {
    const generatedAt = '2026-07-26T10:45:00Z';
    const macroProvenance = retarget(provenance('china-macro-official-numeric'), 'macro:gdp:2026-q2');
    const policyProvenance = retarget(provenance('typed-document-translated'), 'policy:samr:2026-07');
    const crossStraitProvenance = retarget(provenance('operational-explicit-unknowns'), 'cross-strait:taiwan-mnd:2026-07-25');
    const corporateProvenance = retarget(provenance('exchange-disclosure-superseded'), 'disclosure:sse:600000:2026-07');
    (
      corporateProvenance.claims as Record<string, { status: string; value?: Record<string, unknown> }>
    ).supersession = { status: 'known', value: { state: 'current' } };
    const corridorProvenance = retarget(provenance('corridor-stale-content'), 'corridor:shanghai-port:2026-07-26');

    const snapshot = composeChinaDecisionSignals({
      generatedAt,
      macro: {
        unavailable: false,
        indicators: [{
          label: 'Industrial production',
          value: 5.4,
          unit: '%',
          category: 'activity',
          direction: 'strengthening',
          vintageId: '2026-06:v1',
          provenanceJson: JSON.stringify(macroProvenance),
        }],
      },
      policy: {
        agencies: { SAMR: { status: 'ok' } },
        events: [{
          lineageId: 'samr-guidance-2026',
          titleTranslated: 'Market enforcement guidance',
          agency: 'SAMR',
          actionType: 'announcement_guidance',
          status: 'announced',
          supersession: { state: 'current' },
          sectors: [],
          entities: [],
          provenance: policyProvenance,
        }],
      },
      crossStrait: {
        status: 'healthy',
        coverage: { usableMndReportingDays: 91 },
        baselines: {
          semantics: 'prior-usable-reporting-days-excluding-current',
          categories: {
            plaAircraftSorties: {
              windows: {
                30: {
                  state: 'sufficient',
                  ratio: 1.8,
                  difference: 8,
                },
                90: {
                  state: 'insufficient_data',
                  ratio: null,
                  difference: null,
                },
              },
            },
          },
        },
        observations: [{
          sourceId: 'taiwan-mnd',
          observationKind: 'official_daily_claim',
          reportingDay: '2026-07-25',
          summary: 'Taiwan MND daily activity claim',
          categories: { plaAircraftSorties: 18, planShips: 7 },
          provenance: crossStraitProvenance,
        }],
      },
      corporate: {
        status: 'healthy',
        events: [{
          announcementId: 'sse-600000-2026-07',
          exchange: 'SSE',
          issuer: { symbol: '600000', name: 'Example issuer' },
          disclosureType: 'investigation',
          status: 'current',
          titleOriginal: '关于立案调查的公告',
          provenance: corporateProvenance,
        }],
      },
      corridors: {
        corridors: [{
          id: 'shanghai-export',
          name: 'Shanghai export corridor',
          availability: 'available',
          conditions: [{
            family: 'port',
            availability: 'stale',
            summary: 'Port calls below recent baseline',
            provenance: corridorProvenance,
          }],
        }],
      },
      nowcast: {
        methodVersion: 'china-activity-nowcast/v1',
        evaluatedAt: generatedAt,
        comparisonWindow: { endsAt: generatedAt },
        state: 'agreement',
        official: { provenance: macroProvenance },
        contributions: [{
          included: true,
          observationId: 'corridor:shanghai-port:2026-07-26',
          provenance: corridorProvenance,
        }],
        confidence: { level: 'high' },
        missingInputs: [],
        sensitivity: [],
        limitations: ['Directional comparison only.'],
        audit: { deterministic: true, llmNumericComputation: false },
      },
    });

    assert.equal(isChinaDecisionSignalSnapshot(snapshot), true);
    assert.equal(isChinaDecisionSignalSnapshot({
      ...snapshot,
      access: { ...snapshot.access, operator: 'bounded_public_summary' },
    }), false);
    const tampered = structuredClone(snapshot);
    tampered.groups[0].items[0].sourceName = 'Relabeled source';
    assert.equal(isChinaDecisionSignalSnapshot(tampered), false);
    assert.deepEqual(snapshot.groups.map((candidate) => candidate.id), CHINA_DECISION_SIGNAL_GROUP_IDS);
    assert.deepEqual(
      snapshot.groups.map((candidate) => candidate.state),
      // cross-strait-activity is 'stale', not 'available': its item's content
      // freshness is 'timestamp_unknown', which must not be treated as fresh.
      ['available', 'available', 'stale', 'available', 'stale', 'available'],
    );
    assert.equal(
      snapshot.groups.find((candidate) => candidate.id === 'cross-strait-activity')
        ?.items[0]?.stale,
      true,
      'an unknown content timestamp is reported as stale, not fabricated as fresh',
    );
    assert.deepEqual(snapshot.access, {
      anonymous: 'bounded_public_summary',
      pro: 'same_provenance_via_mcp',
      operator: 'source_health_only',
    });
    assert.equal(snapshot.groups.every((candidate) => candidate.items.length === 1), true);
    assert.deepEqual(
      snapshot.groups.find((candidate) => candidate.id === 'cross-strait-activity')
        ?.metadata.baselineBands,
      [
        {
          category: 'plaAircraftSorties',
          windowDays: 30,
          state: 'sufficient',
          band: 'elevated',
          difference: 8,
          ratio: 1.8,
        },
        {
          category: 'plaAircraftSorties',
          windowDays: 90,
          state: 'insufficient_data',
          band: 'insufficient_data',
          difference: null,
          ratio: null,
        },
      ],
    );
    for (const item of snapshot.groups.flatMap((candidate) => candidate.items)) {
      assert.equal(validateDecisionSignalProvenance(item.provenance).ok, true);
      assert.ok(item.sourceName);
      assert.ok(item.publisherType);
      assert.equal(Object.hasOwn(item.metadata, 'revision'), true);
      assert.equal(Object.hasOwn(item.metadata, 'supersession'), true);
      assert.equal(Object.hasOwn(item.metadata, 'corroboration'), true);
    }
    const nowcast = snapshot.groups.at(-1)?.items[0];
    assert.equal(nowcast?.provenance.familyId, 'derived_comparison');
    assert.deepEqual(
      (
        nowcast?.provenance.claims.derivation as {
          status: 'known';
          value: { inputSignalIds: string[] };
        }
      ).value.inputSignalIds,
      ['macro:gdp:2026-q2', 'corridor:shanghai-port:2026-07-26'],
    );
  });

  it('fails closed per domain without hiding unrelated healthy groups', () => {
    const policyProvenance = retarget(provenance('typed-document-translated'), 'policy:samr:valid');
    const snapshot = composeChinaDecisionSignals({
      generatedAt: '2026-07-26T10:45:00Z',
      policy: {
        agencies: { SAMR: { status: 'ok' } },
        events: [
          {
            lineageId: 'valid',
            titleOriginal: 'Valid reviewed event',
            agency: 'SAMR',
            actionType: 'final_rule',
            status: 'in_force',
            supersession: { state: 'current' },
            sectors: [],
            entities: [],
            provenance: policyProvenance,
          },
          {
            lineageId: 'invalid',
            titleOriginal: 'Invalid event',
            supersession: { state: 'current' },
            sectors: [],
            entities: [],
            provenance: { signalId: 'missing-contract' },
          },
        ],
      },
    });

    const policy = snapshot.groups.find((candidate) => candidate.id === 'policy-enforcement');
    assert.equal(policy?.state, 'partial');
    assert.equal(policy?.items.length, 1);
    assert.match(policy?.reason ?? '', /failed the launch\/provenance boundary/);
    assert.equal(
      snapshot.groups.filter((candidate) => candidate.id !== 'policy-enforcement')
        .every((candidate) => candidate.state === 'unavailable'),
      true,
      'an outage in one domain does not manufacture data in another',
    );
  });

  it('launches the existing deterministic comparison family only at the final composition boundary', () => {
    assert.equal(
      DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS.derived_comparison.launchStatus,
      'launched',
    );
  });

  it('bounds the maximum public shape below the MCP tool budget without truncating retained provenance', () => {
    const generatedAt = '2026-07-26T10:45:00Z';
    const crossStraitProvenance = retarget(
      provenance('operational-explicit-unknowns'),
      'cross-strait:taiwan-mnd:oversized-coverage',
    );
    const events = Array.from({ length: 4 }, (_, index) => {
      const signalId = `policy:samr:oversized-${index}`;
      return {
        signalId,
        lineageId: `samr-oversized-${index}`,
        titleOriginal: `Oversized policy ${index} ${'政'.repeat(8_000)}`,
        agency: 'SAMR',
        actionType: 'announcement_guidance',
        status: 'announced',
        supersession: { state: 'current' },
        sectors: [],
        entities: [],
        provenance: retarget(provenance('typed-document-translated'), signalId),
      };
    });
    const input = {
      generatedAt,
      policy: {
        agencies: { SAMR: { status: 'ok' } },
        events,
      },
      crossStrait: {
        status: 'healthy',
        coverage: {
          note: 'coverage'.repeat(20_000),
        },
        observations: [{
          sourceId: 'taiwan-mnd',
          observationKind: 'official_daily_claim',
          reportingDay: '2026-07-25',
          summary: 'Taiwan MND daily activity claim',
          categories: { plaAircraftSorties: 18, planShips: 7 },
          provenance: crossStraitProvenance,
        }],
      },
    };

    const snapshot = composeChinaDecisionSignals(input);
    const repeated = composeChinaDecisionSignals(input);
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === 'get_china_decision_signals');
    assert.ok(tool);
    assert.equal(
      tool._outputBudgetBytes,
      CHINA_DECISION_SIGNAL_MAX_SERIALIZED_BYTES,
      'the MCP budget covers the canonical composition bound exactly',
    );

    const serializedBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    assert.ok(
      serializedBytes <= tool._outputBudgetBytes,
      `snapshot ${serializedBytes}B exceeds MCP budget ${tool._outputBudgetBytes}B`,
    );
    assert.equal(isChinaDecisionSignalSnapshot(snapshot), true);
    assert.deepEqual(repeated, snapshot, 'bounded composition remains deterministic');

    const policy = snapshot.groups.find((candidate) => candidate.id === 'policy-enforcement');
    assert.ok(policy);
    assert.ok(
      Number(policy.metadata.omittedItemCount) > 0,
      'oversized whole items are reported as omitted',
    );
    assert.ok(
      policy.state === 'partial' || policy.state === 'unavailable',
      'omission remains explicit in group state',
    );
    assert.ok(policy.items.length > 0, 'the fixture exercises retained provenance as well as omission');
    const provenanceBySignal = new Map(events.map((event) => [event.signalId, event.provenance]));
    for (const item of policy.items) {
      assert.deepEqual(
        item.provenance,
        provenanceBySignal.get(item.id),
        'retained item provenance is preserved verbatim',
      );
    }

    const crossStrait = snapshot.groups.find((candidate) => candidate.id === 'cross-strait-activity');
    assert.equal(crossStrait?.metadata.metadataOmittedForSerialization, true);
    // Trimming supplemental metadata to fit the byte budget must not paper
    // over the fact that the retained item's content timestamp is unknown:
    // the group stays 'stale', it isn't relabeled 'partial' by the trim.
    assert.equal(crossStrait?.state, 'stale');
    assert.match(crossStrait?.reason ?? '', /Supplemental group metadata omitted/);
  });
});
