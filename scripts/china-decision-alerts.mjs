// Final China decision-signal alert policy (#5580).
//
// Alerts are deliberately narrower than the public snapshot:
// - a first snapshot never fans out historical records;
// - raw source arrivals do not alert;
// - policy/corporate alerts require a new reviewed lineage;
// - activity alerts require a comparison or baseline-band transition;
// - corrections, amendments, and repeat ingests keep the same dedupe lineage;
// - this surface never manufactures high/critical severity from raw data.

import {
  publishNotificationEvent,
  publishNotificationEventOutcome,
} from './regional-snapshot/alert-emitter.mjs';

const REVIEWED_POLICY_ACTIONS = new Set([
  'final_rule',
  'administrative_approval_restriction',
  'investigation',
  'enforcement_penalty',
  'effective_date_change',
]);

const MEDIUM_POLICY_ACTIONS = new Set([
  'administrative_approval_restriction',
  'investigation',
  'enforcement_penalty',
]);

const REVIEWED_CORPORATE_TYPES = new Set([
  'halt',
  'resumption',
  'earnings_warning',
  'restructuring',
  'share_pledge',
  'investigation',
  'exchange_risk_alert',
]);

const MEDIUM_CORPORATE_TYPES = new Set([
  'halt',
  'investigation',
  'exchange_risk_alert',
]);

const TYPED_EVENT_COOLDOWN_SECONDS = 24 * 60 * 60;
const TRANSITION_COOLDOWN_SECONDS = 12 * 60 * 60;

function group(snapshot, id) {
  return Array.isArray(snapshot?.groups)
    ? snapshot.groups.find((candidate) => candidate?.id === id) ?? null
    : null;
}

function groupItems(snapshot, id) {
  const candidate = group(snapshot, id);
  if (!candidate || candidate.state === 'unavailable' || !Array.isArray(candidate.items)) return [];
  return candidate.items.filter(Boolean);
}

function currentItems(snapshot, id) {
  return groupItems(snapshot, id).filter((item) => item.stale !== true);
}

function previousLineages(snapshot, id) {
  // A stale prior item still owns its lineage. If a source later recovers and
  // republishes that same lineage as fresh, it is recovery — not a new event.
  return new Set(groupItems(snapshot, id).map((item) => item.lineageId).filter(Boolean));
}

function isNewPublishedLineage(previous, item) {
  const priorGeneratedAt = Date.parse(previous?.generatedAt ?? '');
  const publishedAt = Date.parse(item?.publishedAt ?? '');
  return Number.isFinite(priorGeneratedAt)
    && Number.isFinite(publishedAt)
    && publishedAt > priorGeneratedAt;
}

function typedEvent({
  domain,
  item,
  kind,
  severity,
  generatedAt,
}) {
  return {
    eventType: `china_${domain}_decision_signal`,
    severity,
    cooldownSeconds: TYPED_EVENT_COOLDOWN_SECONDS,
    payload: {
      title: `China ${kind}: ${item.label}`,
      surface: 'china-decision-signals',
      domain,
      countryCode: 'CN',
      signal_id: item.id,
      lineage_id: item.lineageId,
      source_name: item.sourceName,
      triggered_at: generatedAt,
      dedupe_key: `china:${domain}:${item.lineageId}`,
      details: {
        summary: item.summary,
        publisher_type: item.publisherType,
      },
    },
  };
}

function buildTypedEvents(previous, next) {
  const events = [];
  const previousPolicy = previousLineages(previous, 'policy-enforcement');
  for (const item of currentItems(next, 'policy-enforcement')) {
    const actionType = item.metadata?.actionType;
    if (
      !item.lineageId
      || previousPolicy.has(item.lineageId)
      || !isNewPublishedLineage(previous, item)
      || !REVIEWED_POLICY_ACTIONS.has(actionType)
    ) continue;
    events.push(typedEvent({
      domain: 'policy',
      item,
      kind: 'policy/enforcement update',
      severity: MEDIUM_POLICY_ACTIONS.has(actionType) ? 'medium' : 'low',
      generatedAt: next.generatedAt,
    }));
  }

  const previousCorporate = previousLineages(previous, 'corporate-disclosures');
  for (const item of currentItems(next, 'corporate-disclosures')) {
    const disclosureType = item.metadata?.disclosureType;
    if (
      !item.lineageId
      || previousCorporate.has(item.lineageId)
      || !isNewPublishedLineage(previous, item)
      || !REVIEWED_CORPORATE_TYPES.has(disclosureType)
    ) continue;
    events.push(typedEvent({
      domain: 'corporate',
      item,
      kind: 'reviewed corporate disclosure',
      severity: MEDIUM_CORPORATE_TYPES.has(disclosureType) ? 'medium' : 'low',
      generatedAt: next.generatedAt,
    }));
  }
  return events;
}

function baselineBandMap(snapshot) {
  const bands = group(snapshot, 'cross-strait-activity')?.metadata?.baselineBands;
  if (!Array.isArray(bands)) return new Map();
  return new Map(bands
    .filter((band) => band?.category && Number.isInteger(band?.windowDays) && band?.band)
    .map((band) => [`${band.category}:${band.windowDays}`, band]));
}

function buildBaselineTransitionEvents(previous, next) {
  const prior = baselineBandMap(previous);
  const current = baselineBandMap(next);
  const events = [];
  for (const [key, band] of current) {
    const before = prior.get(key);
    if (
      !before
      || before.band === band.band
      || ['insufficient_data', 'unavailable'].includes(before.band)
      || ['insufficient_data', 'unavailable'].includes(band.band)
    ) continue;
    events.push({
      eventType: 'china_cross_strait_baseline_transition',
      severity: band.band === 'elevated' ? 'medium' : 'low',
      cooldownSeconds: TRANSITION_COOLDOWN_SECONDS,
      payload: {
        title: `China cross-Strait activity: ${band.category} ${before.band} → ${band.band} (${band.windowDays}d median)`,
        surface: 'china-decision-signals',
        domain: 'cross-strait-activity',
        countryCode: 'CN',
        triggered_at: next.generatedAt,
        dedupe_key: `china:cross-strait-baseline:${key}:${before.band}:${band.band}`,
        details: {
          category: band.category,
          window_days: band.windowDays,
          from: before.band,
          to: band.band,
          ratio: band.ratio ?? null,
          difference: band.difference ?? null,
        },
      },
    });
  }
  return events;
}

function comparisonState(snapshot) {
  const item = currentItems(snapshot, 'activity-nowcast')[0];
  return typeof item?.metadata?.comparisonState === 'string'
    ? item.metadata.comparisonState
    : null;
}

function buildNowcastTransitionEvents(previous, next) {
  const before = comparisonState(previous);
  const after = comparisonState(next);
  if (!before || !after || before === after || after === 'insufficient_data') return [];
  return [{
    eventType: 'china_activity_nowcast_transition',
    severity: 'medium',
    cooldownSeconds: TRANSITION_COOLDOWN_SECONDS,
    payload: {
      title: `China activity nowcast: ${before} → ${after}`,
      surface: 'china-decision-signals',
      domain: 'activity-nowcast',
      countryCode: 'CN',
      triggered_at: next.generatedAt,
      dedupe_key: `china:activity-nowcast:${before}:${after}`,
      details: { from: before, to: after },
    },
  }];
}

export function buildChinaDecisionAlertEvents(previous, next) {
  if (!previous || !next) return [];
  return [
    ...buildTypedEvents(previous, next),
    ...buildBaselineTransitionEvents(previous, next),
    ...buildNowcastTransitionEvents(previous, next),
  ];
}

export async function emitChinaDecisionAlerts(previous, next, opts = {}) {
  const events = buildChinaDecisionAlertEvents(previous, next);
  const publisher = opts.publishEvent ?? publishNotificationEvent;
  let enqueued = 0;
  for (const event of events) {
    try {
      if (await publisher(event)) enqueued += 1;
    } catch (error) {
      console.warn(`[china-decision-alerts] ${event.eventType} publish failed: ${error?.message ?? error}`);
    }
  }
  return { events, enqueued };
}

export async function publishChinaDecisionAlertEvents(events, opts = {}) {
  const publisher = opts.publishEvent ?? publishNotificationEventOutcome;
  const pending = [];
  let enqueued = 0;
  let deduped = 0;
  for (const event of events) {
    try {
      const outcome = await publisher(event);
      if (outcome === true || outcome?.enqueued === true) {
        enqueued += 1;
      } else if (outcome?.dedupHit === true) {
        // The queue already owns this event. Treat a dedup hit as delivered so
        // a durable outbox does not retain it until the cooldown expires.
        deduped += 1;
      } else {
        pending.push(event);
      }
    } catch (error) {
      console.warn(`[china-decision-alerts] ${event.eventType} publish failed: ${error?.message ?? error}`);
      pending.push(event);
    }
  }
  return { events, enqueued, deduped, pending };
}
