'use strict';

const { BASE_URL, PATHS, EVENT_REGISTRY } = require('../constants');
const { subscribe, unsubscribe, receive, toNumber, readList, scopeFromInputs } = require('../lib/hooks');

const EVENT = EVENT_REGISTRY.events['natural.hazard'];
const INPUT = EVENT.inputSchema.properties;
const HAZARD_TYPE_CHOICES = Object.fromEntries(INPUT.hazardTypes.items.enum.map((type) => [type, type]));
const ALERT_LEVEL_CHOICES = Object.fromEntries(INPUT.minAlertLevel.enum.map((level) => [level, level]));
const SAMPLE_ROWS = 10;

const readInputs = (bundle) => ({
  hazardTypes: readList(bundle.inputData.hazard_types),
  minMagnitude: toNumber(bundle.inputData.min_magnitude, INPUT.minMagnitude.default),
  minAlertLevel: String(bundle.inputData.min_alert_level || INPUT.minAlertLevel.default),
  countries: readList(bundle.inputData.countries).map((code) => code.toUpperCase()),
});

const performSubscribe = (z, bundle) => subscribe(z, bundle, {
  eventType: EVENT.key,
  scope: scopeFromInputs(readInputs(bundle)),
});

const performUnsubscribe = (z, bundle) => unsubscribe(z, bundle);

const perform = (z, bundle) => receive(z, bundle, { eventType: EVENT.key });

// The worker's mapping (scripts/shipping-webhook-worker.mjs earthquakeCandidate
// and naturalEventCandidate), repeated here because Zapier bundles only this
// folder. Samples are not geocoded: countryCodes is [] (deliveries carry it).
const GDACS_ALERT_EMOJI = /^\s*(\u{1F534}|\u{1F7E0})\s*/u;
// Same rule as the worker's isPrescribedBurn: planned burns are not wildfire alerts.
const PRESCRIBED_BURN = /^prescribed (?:fire|burn)\b|\brx\b/i;
const NHC_ADVISORY_ID = /^(nhc-[A-Z]{2}\d{2})-[^-]+$/;
const STORM_CLASSIFICATION = /^(?:super typhoon|typhoon|hurricane|major hurricane|tropical storm|tropical depression|tropical cyclone|severe tropical storm|severe cyclonic storm|very severe cyclonic storm|cyclonic storm|cyclone|subtropical storm|subtropical depression|post-tropical cyclone|potential tropical cyclone|remnants of|storm|depression)\s+/i;

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const iso = (ms) => (finite(ms) > 0 ? new Date(ms).toISOString() : null);

function row(eventId, fields, occurredMs) {
  const occurredAt = iso(occurredMs);
  return {
    id: `sample:${eventId}`,
    eventType: EVENT.key,
    deliveryId: null,
    subscriberId: 'sample',
    eventId,
    ...fields,
    countryCodes: [],
    occurredAt,
    triggeredAt: occurredAt,
    reason: 'new_hazard',
  };
}

function earthquakeRow(quake) {
  const magnitude = finite(quake && quake.magnitude);
  const lat = finite(quake && quake.location && quake.location.latitude);
  const lon = finite(quake && quake.location && quake.location.longitude);
  if (!quake || typeof quake.id !== 'string' || !quake.id || magnitude === null || lat === null || lon === null || !(finite(quake.occurredAt) > 0)) return null;
  const place = typeof quake.place === 'string' ? quake.place.trim() : '';
  return row(`eq:${quake.id}`, {
    hazardType: 'earthquakes',
    title: place ? `M${magnitude.toFixed(1)} - ${place}` : `M${magnitude.toFixed(1)} earthquake`,
    source: quake.source === 'nrcan' ? 'nrcan' : 'usgs',
    sourceUrl: quake.sourceUrl || null,
    lat,
    lon,
    magnitude,
    depthKm: finite(quake.depthKm),
    nearTestSite: quake.nearTestSite === true,
    alertLevel: null,
    stormName: null,
    stormCategory: null,
    windKt: null,
  }, quake.occurredAt);
}

function naturalSource(event) {
  const id = event.id;
  if (id.startsWith('EONET_')) return 'eonet';
  if (id.startsWith('nhc-')) return 'nhc';
  if (id.startsWith('gdacs-')) return 'gdacs';
  const named = typeof event.sourceName === 'string' ? event.sourceName.trim().toLowerCase() : '';
  return named || (id.startsWith('cyclone:') ? 'gdacs' : 'eonet');
}

function naturalRow(event) {
  const lat = finite(event && event.lat);
  const lon = finite(event && event.lon);
  if (!event || typeof event.id !== 'string' || !event.id || event.category === 'earthquakes' || event.closed === true) return null;
  if (event.id.startsWith('hko-warning:')) return null;
  if (event.category === 'wildfires' && typeof event.title === 'string' && PRESCRIBED_BURN.test(event.title)) return null;
  if (lat === null || lon === null || !event.category || !(finite(event.date) > 0)) return null;
  const rawTitle = typeof event.title === 'string' ? event.title : '';
  const emoji = (GDACS_ALERT_EMOJI.exec(rawTitle) || [])[1];
  const title = rawTitle.replace(GDACS_ALERT_EMOJI, '').trim();
  let alertLevel = null;
  if (event.id.startsWith('gdacs-')) {
    alertLevel = event.alertLevel === 'Red' || event.alertLevel === 'Orange'
      ? event.alertLevel
      : emoji === '\u{1F534}' ? 'Red' : emoji === '\u{1F7E0}' ? 'Orange' : null;
  }
  const storm = event.category === 'severeStorms';
  const stormName = typeof event.stormName === 'string' && event.stormName.trim()
    ? event.stormName.trim()
    : storm && STORM_CLASSIFICATION.test(title) ? title.replace(STORM_CLASSIFICATION, '').trim() || null : null;
  const unit = typeof event.magnitudeUnit === 'string' ? event.magnitudeUnit.trim().toLowerCase() : '';
  const windKt = finite(event.windKt) > 0
    ? event.windKt
    : storm && (unit === 'kt' || unit === 'kts') && finite(event.magnitude) > 0 ? event.magnitude : null;
  const match = NHC_ADVISORY_ID.exec(event.id);
  // An escalation to Red is a second event, so a Red GDACS id ends in :red.
  return row(`nat:${match ? match[1] : event.id}${alertLevel === 'Red' ? ':red' : ''}`, {
    hazardType: event.category,
    title: title || event.categoryTitle || event.category,
    source: naturalSource(event),
    sourceUrl: event.sourceUrl || null,
    lat,
    lon,
    magnitude: null,
    depthKm: null,
    nearTestSite: null,
    alertLevel,
    stormName: storm ? stormName : null,
    stormCategory: Number.isInteger(event.stormCategory) ? event.stormCategory : null,
    windKt,
  }, event.date);
}

function matches(item, { hazardTypes, minMagnitude, minAlertLevel }) {
  if (hazardTypes.length && !hazardTypes.includes(item.hazardType)) return false;
  if (item.hazardType === 'earthquakes' && !(item.magnitude >= minMagnitude)) return false;
  if (minAlertLevel === 'Red' && item.source === 'gdacs' && item.alertLevel !== 'Red') return false;
  return true;
}

// Sample rows: the current earthquakes and natural events, shaped like
// deliveries, filtered by hazard types, the magnitude floor and the alert
// level (not by country: samples are not geocoded), newest first. When the
// scope leaves nothing, the newest hazards are shown so the editor has rows.
const performList = async (z, bundle) => {
  const inputs = readInputs(bundle);
  // One failed list still leaves the other's rows; both failing is an error
  // (an invalid key fails both).
  const [quakes, natural] = await Promise.all([
    z.request({ url: `${BASE_URL}${PATHS.earthquakes}`, skipThrowForStatus: true }),
    z.request({ url: `${BASE_URL}${PATHS.naturalEvents}`, skipThrowForStatus: true }),
  ]);
  const failed = (response) => !response || response.status >= 400;
  if (failed(quakes) && failed(natural)) {
    if (quakes.status === 401) {
      throw new z.errors.ExpiredAuthError('WorldMonitor rejected the API key. Reconnect with an active wm_ key from Settings, API Keys.');
    }
    throw new z.errors.Error(`WorldMonitor API error ${quakes.status} on both hazard lists.`, 'ApiError', quakes.status);
  }
  const quakeList = !failed(quakes) && quakes.data && Array.isArray(quakes.data.earthquakes) ? quakes.data.earthquakes : [];
  const eventList = !failed(natural) && natural.data && Array.isArray(natural.data.events) ? natural.data.events : [];
  const seen = new Set();
  const rows = [...quakeList.map(earthquakeRow), ...eventList.map(naturalRow)]
    .filter((item) => item && !seen.has(item.id) && seen.add(item.id))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const scoped = rows.filter((item) => matches(item, inputs));
  return (scoped.length ? scoped : rows).slice(0, SAMPLE_ROWS);
};

module.exports = {
  key: 'natural_hazard',
  noun: EVENT.noun,
  display: {
    label: 'New Natural Hazard',
    description: EVENT.description,
  },
  operation: {
    type: 'hook',
    inputFields: [
      {
        key: 'hazard_types',
        label: 'Hazard Types',
        type: 'string',
        required: false,
        list: true,
        choices: HAZARD_TYPE_CHOICES,
        helpText: INPUT.hazardTypes.description,
      },
      {
        key: 'min_magnitude',
        label: 'Minimum Earthquake Magnitude',
        type: 'number',
        required: false,
        default: String(INPUT.minMagnitude.default),
        helpText: INPUT.minMagnitude.description,
      },
      {
        key: 'min_alert_level',
        label: 'Minimum GDACS Alert Level',
        type: 'string',
        required: false,
        choices: ALERT_LEVEL_CHOICES,
        default: INPUT.minAlertLevel.default,
        helpText: INPUT.minAlertLevel.description,
      },
      {
        key: 'countries',
        label: 'Countries',
        type: 'string',
        required: false,
        list: true,
        helpText: `${INPUT.countries.description} Test samples are not placed in a country; deliveries are.`,
      },
    ],
    performSubscribe,
    performUnsubscribe,
    perform,
    performList,
    sample: { id: 'whd_6a8c0e2f4b6d8a0c2e4f6b8d0a2c4e70', eventType: EVENT.key, deliveryId: 'whd_6a8c0e2f4b6d8a0c2e4f6b8d0a2c4e70', ...EVENT.sample },
    outputFields: [
      { key: 'id', label: 'Delivery ID' },
      { key: 'eventId', label: 'Hazard ID' },
      { key: 'hazardType', label: 'Hazard Type' },
      { key: 'title', label: 'Title' },
      { key: 'source', label: 'Source' },
      { key: 'sourceUrl', label: 'Source URL' },
      { key: 'lat', label: 'Latitude', type: 'number' },
      { key: 'lon', label: 'Longitude', type: 'number' },
      { key: 'countryCodes', label: 'Country Codes', list: true },
      { key: 'occurredAt', label: 'Occurred At', type: 'datetime' },
      { key: 'magnitude', label: 'Magnitude', type: 'number' },
      { key: 'depthKm', label: 'Depth (km)', type: 'number' },
      { key: 'nearTestSite', label: 'Near Nuclear Test Site', type: 'boolean' },
      { key: 'alertLevel', label: 'GDACS Alert Level' },
      { key: 'stormName', label: 'Storm Name' },
      { key: 'stormCategory', label: 'Storm Category', type: 'integer' },
      { key: 'windKt', label: 'Wind (kt)', type: 'number' },
      { key: 'triggeredAt', label: 'Triggered At', type: 'datetime' },
      { key: 'reason', label: 'Reason' },
    ],
  },
};
