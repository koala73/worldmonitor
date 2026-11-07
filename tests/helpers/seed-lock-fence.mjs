// Shared handling of runSeed's seed-lock fence for hand-rolled Upstash doubles.
//
// runSeed renews its lock and writes the canonical key and seed-meta through
// two pinned Lua scripts (SM-122). Doubles that only model plain commands can
// route those EVALs through these helpers: a held lock answers [1, ''], and a
// fenced write is the plain SET it performs while the lock is held.
// tests/seed-utils-lock-fencing.test.mjs executes the real Lua instead.
import { SEED_LOCK_FENCED_SET_SCRIPT, SEED_LOCK_RENEW_SCRIPT } from '../../scripts/_seed-utils.mjs';

/** Upstash reply body for either fence script while the run holds its lock. */
export const SEED_LOCK_HELD_RESULT = Object.freeze([1, '']);

export function isSeedLockFence(command) {
  return Array.isArray(command)
    && String(command[0]).toUpperCase() === 'EVAL'
    && (command[1] === SEED_LOCK_RENEW_SCRIPT || command[1] === SEED_LOCK_FENCED_SET_SCRIPT);
}

/**
 * The SET a fenced write performs when the lock is held, or null when the
 * command is not a fenced write (including a plain lock renewal).
 */
export function fencedSetAsSet(command) {
  if (!Array.isArray(command) || String(command[0]).toUpperCase() !== 'EVAL') return null;
  if (command[1] !== SEED_LOCK_FENCED_SET_SCRIPT) return null;
  const [, , , , key, , , payload, ttlSeconds] = command;
  return ttlSeconds === '' ? ['SET', key, payload] : ['SET', key, payload, 'EX', ttlSeconds];
}

/**
 * Wrap a hand-rolled Upstash fetch double so runSeed's fence EVALs behave as
 * if the run holds its lock: a fenced write reaches the double as the plain
 * SET it performs (so recording, failure injection and storage stay as they
 * were), and both fence scripts answer [1, ''] unless that SET failed.
 */
export function withSeedLockFence(fetchImpl) {
  return async (url, opts = {}) => {
    let command = null;
    if (typeof opts?.body === 'string') {
      try { command = JSON.parse(opts.body); } catch { /* not a JSON command */ }
    }
    if (!isSeedLockFence(command)) return fetchImpl(url, opts);
    const asSet = fencedSetAsSet(command);
    if (asSet) {
      const resp = await fetchImpl(url, { ...opts, body: JSON.stringify(asSet) });
      if (!resp?.ok) return resp;
      const reply = await resp.json().catch(() => null);
      if (reply?.error != null) return Response.json(reply);
    }
    return Response.json({ result: SEED_LOCK_HELD_RESULT });
  };
}
