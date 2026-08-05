// #6060 — a healthy quiet window is not an operational source failure.
//
// Production evidence (2026-08-02): China decision coverage read 4/6 against a
// minimum of 6. One of the two missing groups was corporate-disclosures with
// the explicit reason "healthy_quiet_window: Healthy exchange queries contained
// no qualifying disclosure events" — the exchanges answered, they simply had
// nothing to report. Counting that identically to activity-nowcast, which was
// genuinely unavailable for stale and missing inputs, produced a single
// undifferentiated 4/6 warning that named neither failure.
//
// These tests pin the split: a healthy quiet window is operationally covered,
// every other unavailable cause is not, and the product state of the quiet
// group is untouched (still `unavailable`, still zero items).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';
import { jsonResponse } from '../api/_json-response.js';
import {
  chinaDecisionSignalGroupDiagnostics,
  declareChinaDecisionSignalRecords,
  summarizeChinaDecisionGroups,
} from '../scripts/seed-china-decision-signals.mjs';

const { classifyKey, SEED_META } = __testing__;

const GROUP_IDS = [
  'macro',
  'policy-enforcement',
  'cross-strait-activity',
  'corporate-disclosures',
  'corridor-conditions',
  'activity-nowcast',
];

function item(lineageId) {
  return {
    id: `${lineageId}:v1`,
    lineageId,
    label: lineageId,
    summary: 'Reviewed signal',
    sourceName: 'Official source',
    publisherType: 'government_official',
    stale: false,
    metadata: {},
  };
}

function snapshot(overrides = {}) {
  const groups = Object.fromEntries(GROUP_IDS.map((id) => [id, {
    id,
    state: 'unavailable',
    items: [],
    metadata: {},
  }]));
  for (const [id, value] of Object.entries(overrides)) {
    groups[id] = { ...groups[id], ...value };
  }
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-02T14:40:00.000Z',
    groups: GROUP_IDS.map((id) => groups[id]),
    access: {
      anonymous: 'bounded_public_summary',
      pro: 'same_provenance_via_mcp',
      operator: 'source_health_only',
    },
  };
}

const healthyQuiet = {
  state: 'unavailable',
  items: [],
  reason: 'healthy_quiet_window: Healthy exchange queries contained no qualifying disclosure events.',
  metadata: { unavailableCause: 'healthy_quiet_window' },
};

// The exact 2026-08-02 14:40 UTC production snapshot.
function auditSnapshot() {
  return snapshot({
    macro: { state: 'partial', items: [item('macro-1')] },
    'policy-enforcement': { state: 'partial', items: [item('policy-1')] },
    'cross-strait-activity': { state: 'available', items: [item('cross-strait-1')] },
    'corporate-disclosures': healthyQuiet,
    'corridor-conditions': { state: 'partial', items: [item('corridor-1')] },
    'activity-nowcast': {
      state: 'unavailable',
      items: [],
      reason: 'insufficient_data: Missing or stale input families: freight (missing_directional_value), maritime (marked_stale), energy (missing_directional_value), corridor (missing_directional_value).',
      metadata: { unavailableCause: 'insufficient_data' },
    },
  });
}

describe('China decision coverage classes (#6060)', () => {
  it('counts a healthy quiet window as operational source coverage', () => {
    // 4 populated groups + the healthy quiet window = 5. activity-nowcast is
    // genuinely unavailable and must still not count.
    assert.equal(declareChinaDecisionSignalRecords(auditSnapshot()), 5);
  });

  it('does not change the quiet group product state or invent disclosure events', () => {
    const quiet = auditSnapshot().groups
      .find((group) => group.id === 'corporate-disclosures');
    assert.equal(quiet.state, 'unavailable', 'the public state stays truthful');
    assert.deepEqual(quiet.items, [], 'no disclosure event is manufactured');
  });

  it('counts only healthy_quiet_window — every other unavailable cause stays uncovered', () => {
    for (const cause of [
      'insufficient_data',
      'provenance_rejected',
      'upstream_unavailable',
      'unknown',
    ]) {
      const value = snapshot({
        'corporate-disclosures': {
          state: 'unavailable',
          items: [],
          metadata: { unavailableCause: cause },
        },
      });
      assert.equal(
        declareChinaDecisionSignalRecords(value),
        0,
        `${cause} is a real operational failure`,
      );
    }
  });

  it('fails closed on a missing, malformed, or non-string cause', () => {
    for (const metadata of [
      {},
      { unavailableCause: null },
      { unavailableCause: ['healthy_quiet_window'] },
      { unavailableCause: 'healthy_quiet_window ' },
      { unavailableCause: 'HEALTHY_QUIET_WINDOW' },
    ]) {
      assert.equal(
        declareChinaDecisionSignalRecords(snapshot({
          'corporate-disclosures': { state: 'unavailable', items: [], metadata },
        })),
        0,
        `metadata ${JSON.stringify(metadata)} does not prove a healthy quiet window`,
      );
    }
    assert.equal(
      declareChinaDecisionSignalRecords(snapshot({
        'corporate-disclosures': { state: 'unavailable', items: [], metadata: undefined },
      })),
      0,
      'a group with no metadata at all is not covered',
    );
  });

  it('never counts a group twice or exceeds the group cardinality', () => {
    const allQuiet = snapshot(Object.fromEntries(
      GROUP_IDS.map((id) => [id, { ...healthyQuiet }]),
    ));
    assert.equal(declareChinaDecisionSignalRecords(allQuiet), GROUP_IDS.length);
  });

  it('summarizes the three operator-facing classes separately', () => {
    const counts = summarizeChinaDecisionGroups(auditSnapshot().groups);
    assert.equal(counts.populated, 4);
    assert.equal(counts.partial, 3);
    assert.equal(counts.stale, 0);
    assert.equal(counts.unavailable, 2, 'the raw public state is unchanged');
    assert.equal(counts.healthyQuiet, 1, 'quiet is broken out of unavailable');
    assert.equal(counts.operationallyCovered, 5);
  });

  it('names the cause of every uncovered group in the seed diagnostics', () => {
    const diagnostics = chinaDecisionSignalGroupDiagnostics(auditSnapshot());

    assert.deepEqual(diagnostics.groupStates, {
      macro: 'partial',
      'policy-enforcement': 'partial',
      'cross-strait-activity': 'available',
      'corporate-disclosures': 'unavailable',
      'corridor-conditions': 'partial',
      'activity-nowcast': 'unavailable',
    });
    assert.deepEqual(diagnostics.unavailableCauses, {
      'corporate-disclosures': 'healthy_quiet_window',
      'activity-nowcast': 'insufficient_data',
    });
    assert.equal(diagnostics.groupCounts.healthyQuiet, 1);
    assert.equal(diagnostics.groupCounts.operationallyCovered, 5);
  });

  it('reports an unknown cause rather than omitting an uncovered group', () => {
    const diagnostics = chinaDecisionSignalGroupDiagnostics(snapshot());
    assert.equal(Object.keys(diagnostics.unavailableCauses).length, GROUP_IDS.length);
    assert.equal(
      Object.values(diagnostics.unavailableCauses).every((cause) => cause === 'unknown'),
      true,
      'a group with no declared cause is unknown, never silently covered',
    );
    assert.equal(diagnostics.groupCounts.operationallyCovered, 0);
  });

  it('keeps decision items out of the bounded diagnostics patch', () => {
    const diagnostics = chinaDecisionSignalGroupDiagnostics(auditSnapshot());
    assert.doesNotMatch(JSON.stringify(diagnostics), /macro-1|policy-1|corridor-1/);
  });
});

// ── health projection ──────────────────────────────────────────────────────

const DECISION_META_KEY = 'seed-meta:intelligence:china-decision-signals';
const DECISION_DATA_KEY = 'intelligence:china-decision-signals:v1';
const NOW = Date.parse('2026-08-02T14:42:58.000Z');

function classifyDecisionSignals(meta) {
  return classifyKey('chinaDecisionSignals', DECISION_DATA_KEY, {}, {
    keyStrens: new Map([[DECISION_DATA_KEY, 8192]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[DECISION_META_KEY, JSON.stringify(meta)]]),
    keyMetaErrors: new Map(),
    now: NOW,
  });
}

// What the seeder actually writes: runSeed's own freshness fields plus the
// afterPublish diagnostics patch, flattened onto the same seed-meta object.
function decisionMeta(snapshotValue) {
  return {
    fetchedAt: NOW - 5 * 60_000,
    recordCount: declareChinaDecisionSignalRecords(snapshotValue),
    ...chinaDecisionSignalGroupDiagnostics(snapshotValue),
  };
}

describe('health decision-group classes (#6060)', () => {
  it('requires all six groups to be operationally covered', () => {
    assert.equal(SEED_META.chinaDecisionSignals.minRecordCount, 6);
  });

  it('separates healthy quiet, stale and genuinely unavailable groups', () => {
    const entry = classifyDecisionSignals(decisionMeta(auditSnapshot()));

    assert.equal(entry.records, 5, 'the quiet window no longer costs a coverage slot');
    assert.equal(entry.status, 'COVERAGE_PARTIAL', 'the real nowcast failure still warns');
    assert.deepEqual(entry.decisionGroups.quietGroups, ['corporate-disclosures']);
    assert.deepEqual(entry.decisionGroups.staleGroups, []);
    assert.deepEqual(entry.decisionGroups.unavailableGroups, [
      { id: 'activity-nowcast', unavailableCause: 'insufficient_data' },
    ]);
    assert.equal(entry.decisionGroups.operationallyCovered, 5);
    assert.equal(entry.decisionGroups.healthyQuiet, 1);
  });

  it('reports OK when the only unavailable group is a healthy quiet window', () => {
    const entry = classifyDecisionSignals(decisionMeta(snapshot({
      macro: { state: 'available', items: [item('macro-1')] },
      'policy-enforcement': { state: 'available', items: [item('policy-1')] },
      'cross-strait-activity': { state: 'available', items: [item('cross-strait-1')] },
      'corporate-disclosures': healthyQuiet,
      'corridor-conditions': { state: 'available', items: [item('corridor-1')] },
      'activity-nowcast': { state: 'available', items: [item('nowcast-1')] },
    })));

    assert.equal(entry.records, 6);
    assert.equal(entry.status, 'OK', 'a quiet exchange window is not an incident');
    assert.deepEqual(entry.decisionGroups.unavailableGroups, []);
    assert.deepEqual(entry.decisionGroups.quietGroups, ['corporate-disclosures']);
  });

  // /api/seed-health already publishes the full state map. Without it here, a
  // caller polling /api/health sees `partial: 3` but cannot tell WHICH three
  // without a second request to the sibling endpoint.
  it('names every group state, not just the counts', () => {
    const entry = classifyDecisionSignals(decisionMeta(auditSnapshot()));

    assert.deepEqual(entry.decisionGroups.groupStates, {
      macro: 'partial',
      'policy-enforcement': 'partial',
      'cross-strait-activity': 'available',
      'corporate-disclosures': 'unavailable',
      'corridor-conditions': 'partial',
      'activity-nowcast': 'unavailable',
    });
    assert.deepEqual(entry.decisionGroups.partialGroups, [
      'macro',
      'policy-enforcement',
      'corridor-conditions',
    ]);
    assert.equal(
      entry.decisionGroups.partialGroups.length,
      entry.decisionGroups.partial,
      'the named list and the count agree',
    );
  });

  it('names a stale group apart from an unavailable one', () => {
    const entry = classifyDecisionSignals(decisionMeta(snapshot({
      'corridor-conditions': { state: 'stale', items: [item('corridor-1')] },
    })));
    assert.deepEqual(entry.decisionGroups.staleGroups, ['corridor-conditions']);
    assert.equal(entry.decisionGroups.unavailableGroups.length, 5);
  });

  it('does not invent a group breakdown when the producer wrote no diagnostics', () => {
    const entry = classifyDecisionSignals({ fetchedAt: NOW - 5 * 60_000, recordCount: 4 });
    assert.equal(entry.status, 'COVERAGE_PARTIAL', 'the coverage floor still fails closed');
    assert.equal(entry.decisionGroups, undefined);
  });

  // api/_json-response.js drops any key literally named `cause` (an
  // Error.cause leak guard), so classifying correctly in memory proves
  // nothing about what an operator receives. Assert against the real
  // serializer both surfaces go through.
  it('survives the shared response serializer', async () => {
    const entry = classifyDecisionSignals(decisionMeta(auditSnapshot()));
    const body = await jsonResponse({ checks: { chinaDecisionSignals: entry } }, 200).json();
    const served = body.checks.chinaDecisionSignals;

    assert.deepEqual(served.decisionGroups.unavailableGroups, [
      { id: 'activity-nowcast', unavailableCause: 'insufficient_data' },
    ]);
    assert.deepEqual(served.decisionGroups.quietGroups, ['corporate-disclosures']);
    assert.deepEqual(
      served.decisionGroups,
      entry.decisionGroups,
      'no diagnostic field is silently stripped on the wire',
    );
  });

  // seed-health's sibling projection withholds the whole breakdown on a
  // malformed counts object; health must not publish a block of nulls instead.
  it('withholds the breakdown when groupCounts is malformed', () => {
    for (const counts of [undefined, null, 'not-an-object', 42, []]) {
      const entry = classifyDecisionSignals({
        ...decisionMeta(auditSnapshot()),
        groupCounts: counts,
      });
      assert.equal(
        entry.decisionGroups,
        undefined,
        `groupCounts=${JSON.stringify(counts) ?? 'undefined'} must not publish a null-filled block`,
      );
    }
  });

  it('fails closed when the producer omits a canonical group state', () => {
    const entry = classifyDecisionSignals({
      ...decisionMeta(auditSnapshot()),
      groupStates: { macro: 'available', 'not-a-group': 'available' },
      unavailableCauses: { 'not-a-group': 'healthy_quiet_window' },
    });
    assert.equal(
      entry.decisionGroups,
      undefined,
      'a partial state map cannot be published as a complete diagnostic contract',
    );
  });
});
