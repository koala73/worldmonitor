/**
 * Order the static-reference heavy bundle without letting either cadence class
 * monopolise the only worst-case slot. Heavy members keep their daily rotation,
 * while the daily projection leads every second invocation. Therefore a permanently
 * due Military-Bases run and the projection each receive a slot within any two
 * consecutive ticks even though their combined reservations do not fit once.
 */
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

const TURN_KEY = 'bundle:turn:static-ref-heavy';

export async function claimStaticRefHeavyTurn({
  credentials = getOptionalUpstashCreds(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!credentials || typeof fetchImpl !== 'function') return null;
  try {
    const body = await upstashCommand(credentials, ['INCR', TURN_KEY], {
      fetchImpl,
      timeoutMs: 5_000,
    });
    const claimed = Number(body.result);
    return Number.isSafeInteger(claimed) && claimed > 0 ? claimed - 1 : null;
  } catch {
    return null;
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
