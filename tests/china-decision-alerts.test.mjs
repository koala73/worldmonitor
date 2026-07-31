import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildChinaDecisionAlertEvents,
  emitChinaDecisionAlerts,
} from '../scripts/china-decision-alerts.mjs';
import {
  CHINA_DECISION_SIGNALS_KEY,
  CHINA_DECISION_SIGNALS_ROUTE,
  chinaDecisionSignalGroupDiagnostics,
  createChinaDecisionSignalSeedHooks,
  deliverChinaDecisionSignalAlertOutbox,
  declareChinaDecisionSignalRecords,
  fetchChinaDecisionSignals,
  prepareChinaDecisionSignalAlertEvents,
  publishChinaDecisionSignalAlerts,
  validateChinaDecisionSignalSnapshot,
} from '../scripts/seed-china-decision-signals.mjs';

const GROUP_IDS = [
  'macro',
  'policy-enforcement',
  'cross-strait-activity',
  'corporate-disclosures',
  'corridor-conditions',
  'activity-nowcast',
];

function item(lineageId, metadata = {}) {
  return {
    id: `${lineageId}:v1`,
    lineageId,
    label: lineageId,
    summary: 'Reviewed signal',
    sourceName: 'Official source',
    publisherType: 'government_official',
    publishedAt: '2026-07-26T12:05:00.000Z',
    stale: false,
    metadata,
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
    generatedAt: '2026-07-26T12:00:00.000Z',
    groups: GROUP_IDS.map((id) => groups[id]),
    access: {
      anonymous: 'bounded_public_summary',
      pro: 'same_provenance_via_mcp',
      operator: 'source_health_only',
    },
  };
}

describe('China decision-signal alert policy (#5580)', () => {
  it('rejects contradictory state/item combinations in the published snapshot', () => {
    const unavailableWithItem = snapshot({
      macro: { items: [item('macro-contradiction')] },
    });
    const availableWithoutItem = snapshot({
      macro: { state: 'available' },
    });

    assert.equal(validateChinaDecisionSignalSnapshot(unavailableWithItem), false);
    assert.equal(validateChinaDecisionSignalSnapshot(availableWithoutItem), false);
  });

  it('never fans out historical records on the first canonical snapshot', () => {
    const next = snapshot({
      'policy-enforcement': {
        state: 'available',
        items: [item('policy-1', { actionType: 'enforcement_penalty' })],
      },
    });
    assert.deepEqual(buildChinaDecisionAlertEvents(null, next), []);
  });

  it('alerts once for a new reviewed lineage and suppresses corrections/repeats', () => {
    const previous = snapshot({
      'policy-enforcement': {
        state: 'available',
        items: [item('policy-existing', { actionType: 'final_rule' })],
      },
    });
    const next = snapshot({
      'policy-enforcement': {
        state: 'available',
        items: [
          item('policy-existing', {
            actionType: 'enforcement_penalty',
            revision: { state: 'corrected', sequence: 2 },
          }),
          item('policy-new', { actionType: 'enforcement_penalty' }),
          item('policy-draft', { actionType: 'consultation_draft' }),
        ],
      },
    });

    const events = buildChinaDecisionAlertEvents(previous, next);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'china_policy_decision_signal');
    assert.equal(events[0].severity, 'medium');
    assert.equal(events[0].payload.lineage_id, 'policy-new');
    assert.equal(events[0].payload.dedupe_key, 'china:policy:policy-new');
    assert.equal(events[0].payload.countryCode, 'CN');
    assert.equal(events[0].cooldownSeconds, 24 * 60 * 60);
  });

  it('does not re-alert a known lineage when its source recovers from stale', () => {
    const stale = item('policy-recovered', { actionType: 'final_rule' });
    stale.stale = true;
    const previous = snapshot({
      'policy-enforcement': {
        state: 'stale',
        items: [stale],
      },
    });
    const next = snapshot({
      'policy-enforcement': {
        state: 'available',
        items: [item('policy-recovered', { actionType: 'final_rule' })],
      },
    });

    assert.deepEqual(buildChinaDecisionAlertEvents(previous, next), []);
  });

  it('does not alert when an older bounded item rotates into the top four', () => {
    const previous = snapshot({
      'policy-enforcement': {
        state: 'available',
        items: [item('policy-visible', { actionType: 'final_rule' })],
      },
    });
    const rotated = item('policy-previously-omitted', { actionType: 'final_rule' });
    rotated.publishedAt = '2026-07-26T11:55:00.000Z';
    const next = snapshot({
      'policy-enforcement': {
        state: 'available',
        items: [rotated],
      },
    });

    assert.deepEqual(buildChinaDecisionAlertEvents(previous, next), []);
  });

  it('does not alert on a raw cross-Strait arrival without a baseline transition', () => {
    const previous = snapshot();
    const next = snapshot({
      'cross-strait-activity': {
        state: 'available',
        items: [item('mnd-2026-07-26', { observationKind: 'official_daily_claim' })],
      },
    });
    assert.deepEqual(buildChinaDecisionAlertEvents(previous, next), []);
  });

  it('emits only reviewed baseline and deterministic-nowcast transitions', () => {
    const previous = snapshot({
      'cross-strait-activity': {
        state: 'available',
        metadata: {
          baselineBands: [{
            category: 'plaAircraftSorties',
            windowDays: 30,
            band: 'typical',
            state: 'sufficient',
            ratio: 1.1,
          }],
        },
      },
      'activity-nowcast': {
        state: 'available',
        items: [item('nowcast-before', { comparisonState: 'agreement' })],
      },
    });
    const next = snapshot({
      'cross-strait-activity': {
        state: 'available',
        metadata: {
          baselineBands: [{
            category: 'plaAircraftSorties',
            windowDays: 30,
            band: 'elevated',
            state: 'sufficient',
            ratio: 1.8,
            difference: 8,
          }],
        },
      },
      'activity-nowcast': {
        state: 'available',
        items: [item('nowcast-after', { comparisonState: 'divergence' })],
      },
    });

    const events = buildChinaDecisionAlertEvents(previous, next);
    assert.deepEqual(events.map((event) => event.eventType), [
      'china_cross_strait_baseline_transition',
      'china_activity_nowcast_transition',
    ]);
    assert.equal(events.every((event) => event.severity === 'medium'), true);
    assert.equal(events.every((event) => event.cooldownSeconds === 12 * 60 * 60), true);
    assert.equal(events.every((event) => event.payload.countryCode === 'CN'), true);
  });

  it('keeps publishing best-effort and exposes the canonical seed contract', async () => {
    const previous = snapshot();
    const next = snapshot({
      'corporate-disclosures': {
        state: 'available',
        items: [item('corp-new', { disclosureType: 'investigation' })],
      },
    });
    const considered = [];
    const result = await emitChinaDecisionAlerts(previous, next, {
      publishEvent: async (event) => {
        considered.push(event);
        return true;
      },
    });
    assert.equal(result.enqueued, 1);
    assert.equal(considered[0].eventType, 'china_corporate_decision_signal');
    assert.equal(CHINA_DECISION_SIGNALS_KEY, 'intelligence:china-decision-signals:v1');
    assert.equal(validateChinaDecisionSignalSnapshot(snapshot()), true);
    assert.equal(validateChinaDecisionSignalSnapshot(next), false);
    assert.equal(declareChinaDecisionSignalRecords(snapshot()), 0);
    assert.equal(declareChinaDecisionSignalRecords(next), 1);

    const failed = await publishChinaDecisionSignalAlerts(next, {
      readPrevious: async () => {
        throw new Error('redis unavailable');
      },
    });
    assert.deepEqual(failed, { events: [], enqueued: 0 });
  });

  it('builds bounded seed diagnostics without copying decision items', () => {
    const value = snapshot({
      macro: { state: 'available', items: [item('macro-item')] },
      'policy-enforcement': { state: 'partial', items: [item('policy-item')] },
      'cross-strait-activity': { state: 'stale', items: [item('cross-strait-item')] },
    });
    const diagnostics = chinaDecisionSignalGroupDiagnostics(value);

    assert.deepEqual(diagnostics.groupCounts, {
      populated: 3,
      partial: 1,
      stale: 1,
      unavailable: 3,
    });
    assert.deepEqual(diagnostics.groupStates, {
      macro: 'available',
      'policy-enforcement': 'partial',
      'cross-strait-activity': 'stale',
      'corporate-disclosures': 'unavailable',
      'corridor-conditions': 'unavailable',
      'activity-nowcast': 'unavailable',
    });
    assert.doesNotMatch(JSON.stringify(diagnostics), /macro-item|policy-item|cross-strait-item/);
  });

  it('returns the diagnostics patch before a rejected durable alert delivery', async () => {
    const writes = [];
    const hooks = createChinaDecisionSignalSeedHooks({
      prepareAlerts: async () => [{ eventType: 'china_policy_decision_signal' }],
      diagnosticsFor: chinaDecisionSignalGroupDiagnostics,
      log: () => {},
      deliverAlerts: async () => {
        throw new Error('outbox unavailable');
      },
    });
    const value = snapshot({
      macro: { state: 'available', items: [item('macro-published')] },
    });

    await hooks.beforePublish(value);
    const afterPublishResult = await hooks.afterPublish(value);
    // runSeed writes this patch before calling afterFreshness. Model that
    // boundary explicitly so delivery rejection cannot regress seed-meta order.
    writes.push(afterPublishResult.freshnessMetaPatch);
    await assert.rejects(hooks.afterFreshness(value), /outbox unavailable/);

    assert.deepEqual(writes, [chinaDecisionSignalGroupDiagnostics(value)]);
  });

  it('continues publishing after one alert publisher rejects', async () => {
    const previous = snapshot();
    const next = snapshot({
      'policy-enforcement': {
        state: 'available',
        items: [item('policy-new', { actionType: 'final_rule' })],
      },
      'corporate-disclosures': {
        state: 'available',
        items: [item('corp-new', { disclosureType: 'investigation' })],
      },
    });
    const attempts = [];
    const result = await emitChinaDecisionAlerts(previous, next, {
      publishEvent: async (event) => {
        attempts.push(event.eventType);
        if (event.eventType === 'china_policy_decision_signal') {
          throw new Error('policy transport unavailable');
        }
        return true;
      },
    });

    assert.deepEqual(attempts, [
      'china_policy_decision_signal',
      'china_corporate_decision_signal',
    ]);
    assert.equal(result.events.length, 2);
    assert.equal(result.enqueued, 1);
  });

  it('retries failed post-publication alerts from the durable outbox', async () => {
    const event = {
      eventType: 'china_policy_decision_signal',
      payload: { dedupe_key: 'china:policy:retry-me' },
    };
    const writes = [];
    const first = await deliverChinaDecisionSignalAlertOutbox([event], {
      readOutbox: async () => [],
      writeOutbox: async (pending) => writes.push(pending),
      publishEvents: async (events) => ({
        events,
        enqueued: 0,
        deduped: 0,
        pending: events,
      }),
    });
    assert.deepEqual(first.pending, [event]);
    assert.deepEqual(writes, [[event]]);

    const second = await deliverChinaDecisionSignalAlertOutbox([], {
      readOutbox: async () => writes.at(-1),
      writeOutbox: async (pending) => writes.push(pending),
      publishEvents: async (events) => ({
        events,
        enqueued: events.length,
        deduped: 0,
        pending: [],
      }),
    });
    assert.equal(second.enqueued, 1);
    assert.deepEqual(writes.at(-1), []);
  });

  it('fails closed when the previous canonical snapshot cannot be read', async () => {
    await assert.rejects(
      () => prepareChinaDecisionSignalAlertEvents(snapshot(), {
        readPrevious: async () => {
          throw new Error('canonical read unavailable');
        },
      }),
      /canonical read unavailable/,
    );
  });

  it('preserves the durable outbox when its current value cannot be read', async () => {
    let published = false;
    let written = false;
    await assert.rejects(
      () => deliverChinaDecisionSignalAlertOutbox([], {
        readOutbox: async () => {
          throw new Error('outbox read unavailable');
        },
        publishEvents: async () => {
          published = true;
          return { events: [], enqueued: 0, deduped: 0, pending: [] };
        },
        writeOutbox: async () => {
          written = true;
        },
      }),
      /outbox read unavailable/,
    );
    assert.equal(published, false);
    assert.equal(written, false);
  });

  it('seeds only the validated public RPC contract', async () => {
    const canonical = snapshot();
    const calls = [];
    const result = await fetchChinaDecisionSignals({
      apiBaseUrl: 'https://api-staging.example',
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          accept: init.headers.Accept,
          userAgent: init.headers['User-Agent'],
        });
        return new Response(JSON.stringify({
          payloadJson: JSON.stringify(canonical),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    assert.deepEqual(result, canonical);
    assert.deepEqual(calls, [{
      url: `https://api-staging.example${CHINA_DECISION_SIGNALS_ROUTE}`,
      accept: 'application/json',
      userAgent: 'worldmonitor-china-decision-signals-seed/1.0',
    }]);

    const invalid = structuredClone(canonical);
    invalid.groups.reverse();
    await assert.rejects(
      () => fetchChinaDecisionSignals({
        fetchImpl: async () => new Response(JSON.stringify({
          payload_json: JSON.stringify(invalid),
        })),
      }),
      /canonical six-group contract/,
    );
  });
});
