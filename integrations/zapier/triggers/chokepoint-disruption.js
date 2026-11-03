'use strict';

const { BASE_URL, PATHS, EVENT_REGISTRY } = require('../constants');
const { subscribe, unsubscribe, receive, toInteger } = require('../lib/hooks');

const EVENT = EVENT_REGISTRY.events['chokepoint.disruption'];
const INPUT = EVENT.inputSchema.properties;
const DEFAULT_THRESHOLD = INPUT.alertThreshold.default;
// The in-app chokepoint_disruption alert rule uses the same floor, so Slack
// rules and Zaps agree on what counts as a disruption.
const DEFAULT_MIN_LIVE_SIGNAL = INPUT.minLiveSignal.recommended;

// Same precedence as the delivery worker (REASON_RULES), for sample rows only.
function sampleReason(cp) {
  if (Number(cp.aisDisruptions) > 0) return 'ais_congestion_spike';
  if (Number(cp.activeWarnings) > 0) return 'navigational_warning';
  const ts = cp.transitSummary || {};
  if (ts.todayCountsAvailable === true && Number.isFinite(ts.wowChangePct) && ts.wowChangePct <= -25) return 'transit_drop';
  return 'score_threshold';
}

const readInputs = (bundle) => ({
  chokepointId: String(bundle.inputData.chokepoint || '').trim(),
  alertThreshold: toInteger(bundle.inputData.alert_threshold, DEFAULT_THRESHOLD),
  minLiveSignal: toInteger(bundle.inputData.min_live_signal, DEFAULT_MIN_LIVE_SIGNAL),
});

const performSubscribe = (z, bundle) => {
  const { chokepointId, alertThreshold, minLiveSignal } = readInputs(bundle);
  return subscribe(z, bundle, {
    eventType: EVENT.key,
    chokepointIds: chokepointId ? [chokepointId] : [],
    alertThreshold,
    minLiveSignal,
  });
};

const performUnsubscribe = (z, bundle) => unsubscribe(z, bundle);

const perform = (z, bundle) => receive(z, bundle, { eventType: EVENT.key });

// Sample rows for the Zap editor: the live status of the chosen chokepoint,
// shaped exactly like a delivery so field mapping survives the switch to real
// events. Ids are unique per chokepoint and feed time.
const performList = async (z, bundle) => {
  const { chokepointId, alertThreshold } = readInputs(bundle);
  const response = await z.request({ url: `${BASE_URL}${PATHS.chokepointStatus}` });
  const data = response.data || {};
  const chokepoints = Array.isArray(data.chokepoints) ? data.chokepoints : [];
  const fetchedAt = typeof data.fetchedAt === 'string' ? data.fetchedAt : new Date().toISOString();
  return chokepoints
    .filter((cp) => !chokepointId || cp.id === chokepointId)
    .map((cp) => ({
      id: `sample:${cp.id}:${fetchedAt}`,
      eventType: EVENT.key,
      deliveryId: null,
      subscriberId: 'sample',
      chokepointId: cp.id,
      score: cp.disruptionScore,
      alertThreshold,
      triggeredAt: fetchedAt,
      reason: sampleReason(cp),
      details: {
        name: cp.name,
        status: cp.status || null,
        activeWarnings: cp.activeWarnings || 0,
        aisDisruptions: cp.aisDisruptions || 0,
        congestionLevel: cp.congestionLevel || null,
        warRiskTier: cp.warRiskTier || null,
        wowChangePct: cp.transitSummary && cp.transitSummary.todayCountsAvailable === true
          && Number.isFinite(cp.transitSummary.wowChangePct) ? cp.transitSummary.wowChangePct : null,
        previousScore: null,
        scoresFetchedAt: fetchedAt,
      },
    }));
};

module.exports = {
  key: 'chokepoint_disruption',
  noun: EVENT.noun,
  display: {
    label: 'New Chokepoint Disruption',
    // The registry names the API field; Zapier users see the input's label.
    description: EVENT.description.replace('minLiveSignal', 'the Minimum Live Signal Points'),
  },
  operation: {
    type: 'hook',
    inputFields: [
      {
        key: 'chokepoint',
        label: 'Chokepoint',
        type: 'string',
        required: true,
        dynamic: 'chokepoint_list.id.name',
        helpText: 'The maritime chokepoint to watch, such as the Strait of Hormuz or the Suez Canal.',
      },
      {
        key: 'alert_threshold',
        label: 'Disruption Score Threshold',
        type: 'integer',
        required: false,
        default: String(DEFAULT_THRESHOLD),
        helpText: INPUT.alertThreshold.description,
      },
      {
        key: 'min_live_signal',
        label: 'Minimum Live Signal Points',
        type: 'integer',
        required: false,
        default: String(DEFAULT_MIN_LIVE_SIGNAL),
        helpText: INPUT.minLiveSignal.description,
      },
    ],
    performSubscribe,
    performUnsubscribe,
    perform,
    performList,
    sample: { id: 'whd_74f1d94e09a3968ee447b2a33513522b', eventType: EVENT.key, deliveryId: 'whd_74f1d94e09a3968ee447b2a33513522b', ...EVENT.sample },
    outputFields: [
      { key: 'id', label: 'Delivery ID' },
      { key: 'chokepointId', label: 'Chokepoint ID' },
      { key: 'score', label: 'Disruption Score', type: 'integer' },
      { key: 'alertThreshold', label: 'Alert Threshold', type: 'integer' },
      { key: 'triggeredAt', label: 'Triggered At', type: 'datetime' },
      { key: 'reason', label: 'Reason' },
      { key: 'details__name', label: 'Chokepoint Name' },
      { key: 'details__status', label: 'Status Band' },
      { key: 'details__activeWarnings', label: 'Active Navigational Warnings', type: 'integer' },
      { key: 'details__aisDisruptions', label: 'AIS Disruptions', type: 'integer' },
      { key: 'details__congestionLevel', label: 'Congestion Level' },
      { key: 'details__warRiskTier', label: 'War Risk Tier' },
      { key: 'details__wowChangePct', label: 'Week-over-week Transit Change (%)', type: 'number' },
      { key: 'details__previousScore', label: 'Previous Score', type: 'integer' },
    ],
  },
};
