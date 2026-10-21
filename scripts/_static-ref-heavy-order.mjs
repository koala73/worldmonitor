/**
 * Order the static-reference heavy bundle without letting either cadence class
 * monopolise the only worst-case slot. Heavy members keep their daily rotation,
 * while the daily projection leads every second invocation. Therefore a
 * permanently due Military-Bases run and the projection each receive a slot
 * within any two consecutive ticks even though their combined reservations do
 * not fit once.
 */
import { randomUUID } from 'node:crypto';

import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

const TURN_KEY = 'bundle:turn:static-ref-heavy';
const LEASE_KEY = `${TURN_KEY}:lease`;
const LEASE_SECONDS = 15 * 60;
const CLAIM_TURN_LUA = `
local lease = redis.call('GET', KEYS[2])
if lease then return {0, ''} end
local turn = tonumber(redis.call('GET', KEYS[1]) or '0')
local leaseValue = ARGV[1] .. ':' .. tostring(turn)
local claimed = redis.call('SET', KEYS[2], leaseValue, 'NX', 'EX', ARGV[2])
if not claimed then return {0, ''} end
return {1, tostring(turn)}
`;
const ACK_TURN_LUA = `
local expected = ARGV[1] .. ':' .. ARGV[2]
if redis.call('GET', KEYS[2]) ~= expected then return 0 end
redis.call('SET', KEYS[1], tostring(tonumber(ARGV[2]) + 1))
redis.call('DEL', KEYS[2])
return 1
`;

export async function claimStaticRefHeavyTurn({
  credentials = getOptionalUpstashCreds(),
  fetchImpl = globalThis.fetch,
  token = randomUUID(),
} = {}) {
  if (!credentials || typeof fetchImpl !== 'function' || typeof token !== 'string' || token === '') return null;
  try {
    const body = await upstashCommand(credentials, [
      'EVAL',
      CLAIM_TURN_LUA,
      '2',
      TURN_KEY,
      LEASE_KEY,
      token,
      String(LEASE_SECONDS),
    ], {
      fetchImpl,
      timeoutMs: 5_000,
    });
    const [claimed, rawTurn] = Array.isArray(body.result) ? body.result : [];
    const turn = Number(rawTurn);
    return Number(claimed) === 1 && Number.isSafeInteger(turn) && turn >= 0
      ? { turn, token }
      : null;
  } catch {
    return null;
  }
}

export async function acknowledgeStaticRefHeavyTurn(claim, {
  credentials = getOptionalUpstashCreds(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (
    !credentials
    || typeof fetchImpl !== 'function'
    || !claim
    || !Number.isSafeInteger(claim.turn)
    || claim.turn < 0
    || typeof claim.token !== 'string'
    || claim.token === ''
  ) return false;
  try {
    const body = await upstashCommand(credentials, [
      'EVAL',
      ACK_TURN_LUA,
      '2',
      TURN_KEY,
      LEASE_KEY,
      claim.token,
      String(claim.turn),
    ], {
      fetchImpl,
      timeoutMs: 5_000,
    });
    return Number(body.result) === 1;
  } catch {
    return false;
  }
}

export function orderStaticRefHeavySections(heavySections, dailySections, turn) {
  if (!Number.isSafeInteger(turn) || turn < 0) {
    throw new TypeError('turn must be a non-negative safe integer');
  }
  if (heavySections.length === 0) return [...dailySections];

  const offset = turn % heavySections.length;
  const rotatedHeavy = [
    ...heavySections.slice(offset),
    ...heavySections.slice(0, offset),
  ];

  return turn % 2 === 0
    ? [...dailySections, ...rotatedHeavy]
    : [...rotatedHeavy, ...dailySections];
}
