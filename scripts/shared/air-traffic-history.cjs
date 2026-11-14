'use strict';

const { BIN_MS } = require('./air-traffic-aggregate.cjs');

const PREFIX = 'aviation:traffic:history:v1';
const RETENTION_DAYS = 35;
// api/health.js watches this stable key. The day hashes rotate at UTC midnight,
// and health reads data keys with STRLEN, which a hash fails.
const HEARTBEAT_KEY = 'seed-meta:aviation:traffic-history';
const HEARTBEAT_TTL_SECONDS = 7 * 86400;
const ACTIVATION_KEY = 'seed-activated:aviation:traffic-history';

const COUNT_FIELDS = ['usSeen', 'usAirborne', 'usLowClimbing', 'euAirborne', 'statesTotal'];
const isCount = (v) => Number.isInteger(v) && v >= 0;

function validPoint(point) {
  if (!point || !Number.isInteger(point.t) || point.t % BIN_MS !== 0) return false;
  if (point.status === 'gap') return Object.keys(point).length === 2;
  if (point.status !== 'ok') return false;
  if (!COUNT_FIELDS.every((field) => isCount(point[field]))) return false;
  return point.hubs && typeof point.hubs === 'object'
    && Object.values(point.hubs).every((hub) => hub && isCount(hub.air) && isCount(hub.ground));
}

// An ok point uses HSET, so a later fetch of the same bin replaces it and an ok
// point replaces a gap. A gap uses HSETNX, so it never overwrites anything. Two
// relay replicas writing the same bin therefore leave one point, and a failed
// fetch on one replica cannot erase another replica's data.
function buildTrafficPointWrite(point) {
  if (!validPoint(point)) throw new TypeError('invalid traffic point');
  const day = new Date(point.t).toISOString().slice(0, 10);
  const key = `${PREFIX}:${day}`;
  const expireAt = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000) + 86400 + RETENTION_DAYS * 86400;
  const stored = point.status === 'gap'
    ? { t: point.t, status: 'gap' }
    : { t: point.t, status: 'ok', usSeen: point.usSeen, usAirborne: point.usAirborne, usLowClimbing: point.usLowClimbing, euAirborne: point.euAirborne, hubs: point.hubs };
  const commands = [
    [point.status === 'gap' ? 'HSETNX' : 'HSET', key, String(point.t), JSON.stringify(stored)],
    ['EXPIREAT', key, String(expireAt)],
  ];
  if (point.status === 'ok') {
    commands.push(
      ['SET', HEARTBEAT_KEY, JSON.stringify({ fetchedAt: point.t, recordCount: point.statesTotal }), 'EX', String(HEARTBEAT_TTL_SECONDS)],
      ['SET', ACTIVATION_KEY, '1'],
    );
  }
  return { key, field: String(point.t), expireAt, commands };
}

// `pipeline` runs an Upstash /pipeline body and resolves to its result array.
async function recordTrafficPoint(point, pipeline) {
  if (typeof pipeline !== 'function') throw new TypeError('pipeline must be a function');
  const write = buildTrafficPointWrite(point);
  const results = await pipeline(write.commands);
  if (!Array.isArray(results) || results.length !== write.commands.length || results.some((r) => !r || r.error)) {
    throw new Error('traffic_history_write_failed');
  }
  return { key: write.key, field: write.field };
}

// True when the bin already holds an ok point, so a replica can skip the fetch.
function isOkPointValue(value) {
  if (typeof value !== 'string') return false;
  try { return JSON.parse(value)?.status === 'ok'; } catch { return false; }
}

function dayKeyFor(t) {
  return `${PREFIX}:${new Date(t).toISOString().slice(0, 10)}`;
}

module.exports = {
  PREFIX, RETENTION_DAYS, HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS, ACTIVATION_KEY,
  buildTrafficPointWrite, recordTrafficPoint, isOkPointValue, dayKeyFor,
};
