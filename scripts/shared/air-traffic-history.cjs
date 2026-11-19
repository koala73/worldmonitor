'use strict';

const { BIN_MS } = require('./air-traffic-aggregate.cjs');

const PREFIX = 'aviation:traffic:history:v1';
const RETENTION_DAYS = 35;
// api/health.js watches this stable key. The day hashes rotate at UTC midnight,
// and health reads data keys with STRLEN, which a hash fails.
const HEARTBEAT_KEY = 'seed-meta:aviation:traffic-history';
const HEARTBEAT_TTL_SECONDS = 7 * 86400;
const ACTIVATION_KEY = 'seed-activated:aviation:traffic-history';

const MEASURES = Object.freeze([
  'usSeen', 'usAirborne', 'usLowClimbing', 'euAirborne',
  'usAirborneAirline', 'usLowClimbingAirline', 'euAirborneAirline',
]);
const CLIMB_MEASURES = new Set(['usLowClimbing', 'usLowClimbingAirline']);
const HUB_MEASURES = Object.freeze(['air', 'ground', 'dep']);
const MARKET_MEASURES = Object.freeze(['seen', 'dep']);

// Each source keeps its own day hashes, heartbeat and activation marker, so the
// series never mix and a ratio is only ever taken within one source. `measures`
// lists the counts a source can observe and therefore stores.
const SERIES = Object.freeze({
  opensky: Object.freeze({ prefix: PREFIX, heartbeatKey: HEARTBEAT_KEY, activationKey: ACTIVATION_KEY, measures: MEASURES, hubMeasures: HUB_MEASURES, marketMeasures: MARKET_MEASURES }),
  // Wingbits /v1/flights carries no vertical rate, so it cannot count climbers
  // or hub departures. Storing 0 there would read as a departure collapse.
  wingbits: Object.freeze({
    prefix: 'aviation:traffic:history:wingbits:v1',
    heartbeatKey: 'seed-meta:aviation:traffic-history-wingbits',
    activationKey: 'seed-activated:aviation:traffic-history-wingbits',
    measures: Object.freeze(MEASURES.filter((field) => !CLIMB_MEASURES.has(field))),
    hubMeasures: Object.freeze(HUB_MEASURES.filter((field) => field !== 'dep')),
    marketMeasures: Object.freeze(MARKET_MEASURES.filter((field) => field !== 'dep')),
  }),
});

const isCount = (v) => Number.isInteger(v) && v >= 0;

function validPoint(point, series) {
  if (!point || !Number.isInteger(point.t) || point.t % BIN_MS !== 0) return false;
  if (point.status === 'gap') return Object.keys(point).length === 2;
  if (point.status !== 'ok') return false;
  if (![...series.measures, 'statesTotal'].every((field) => isCount(point[field]))) return false;
  const countsOk = (group, fields) => group && typeof group === 'object'
    && Object.values(group).every((entry) => entry && fields.every((field) => isCount(entry[field])));
  return countsOk(point.hubs, series.hubMeasures)
    && (point.markets === undefined || countsOk(point.markets, series.marketMeasures));
}

const pick = (group, fields) => Object.fromEntries(Object.entries(group).map(([id, entry]) => [
  id, Object.fromEntries(fields.map((field) => [field, entry[field]])),
]));

// An ok point uses HSET, so a later fetch of the same bin replaces it and an ok
// point replaces a gap. A gap uses HSETNX, so it never overwrites anything. Two
// relay replicas writing the same bin therefore leave one point, and a failed
// fetch on one replica cannot erase another replica's data.
function buildTrafficPointWrite(point, fetchedAt = point?.t, series = SERIES.opensky) {
  if (!validPoint(point, series)) throw new TypeError('invalid traffic point');
  if (!Number.isFinite(fetchedAt)) throw new TypeError('fetchedAt must be a finite epoch ms');
  const day = new Date(point.t).toISOString().slice(0, 10);
  const key = `${series.prefix}:${day}`;
  const expireAt = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000) + 86400 + RETENTION_DAYS * 86400;
  const stored = point.status === 'gap'
    ? { t: point.t, status: 'gap' }
    : {
      t: point.t,
      status: 'ok',
      ...Object.fromEntries(series.measures.map((field) => [field, point[field]])),
      hubs: pick(point.hubs, series.hubMeasures),
      ...(point.markets ? { markets: pick(point.markets, series.marketMeasures) } : {}),
    };
  const commands = [
    [point.status === 'gap' ? 'HSETNX' : 'HSET', key, String(point.t), JSON.stringify(stored)],
    ['EXPIREAT', key, String(expireAt)],
  ];
  const metaCommands = point.status === 'ok'
    ? [
      ['SET', series.heartbeatKey, JSON.stringify({ fetchedAt, recordCount: point.statesTotal }), 'EX', String(HEARTBEAT_TTL_SECONDS)],
      ['SET', series.activationKey, '1'],
    ]
    : [];
  return { key, field: String(point.t), expireAt, commands, metaCommands };
}

async function runPipeline(pipeline, commands) {
  const results = await pipeline(commands);
  if (!Array.isArray(results) || results.length !== commands.length || results.some((r) => !r || r.error)) {
    throw new Error('traffic_history_write_failed');
  }
}

// `pipeline` runs an Upstash /pipeline body and resolves to its result array.
// `fetchedAt` is the fetch time, which the heartbeat records so health ages the
// series from the last real fetch rather than from the bin start. A pipeline
// runs every command even after one fails, so the heartbeat goes in a second
// pipeline that runs only once the point and its expiry are stored.
async function recordTrafficPoint(point, pipeline, fetchedAt = point?.t, series = SERIES.opensky) {
  if (typeof pipeline !== 'function') throw new TypeError('pipeline must be a function');
  const write = buildTrafficPointWrite(point, fetchedAt, series);
  await runPipeline(pipeline, write.commands);
  if (write.metaCommands.length > 0) await runPipeline(pipeline, write.metaCommands);
  return { key: write.key, field: write.field };
}

// True when the bin already holds an ok point, so a replica can skip the fetch.
function isOkPointValue(value) {
  if (typeof value !== 'string') return false;
  try { return JSON.parse(value)?.status === 'ok'; } catch { return false; }
}

function dayKeyFor(t, series = SERIES.opensky) {
  return `${series.prefix}:${new Date(t).toISOString().slice(0, 10)}`;
}

module.exports = {
  PREFIX, RETENTION_DAYS, HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS, ACTIVATION_KEY, SERIES,
  buildTrafficPointWrite, recordTrafficPoint, isOkPointValue, dayKeyFor,
};
