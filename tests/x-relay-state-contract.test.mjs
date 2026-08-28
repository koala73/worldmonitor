import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// scripts/ais-relay.cjs has no module.exports and no require.main guard, so
// importing it boots the whole relay — nothing here can execute it. What is left
// in this file is therefore ONLY the wiring that genuinely lives in ais-relay.cjs
// and cannot be reached any other way: the poll loop's scheduling, the guard's
// construction, and the /x route.
//
// The cycle itself (hydrate / publish / pollOnce) moved to
// scripts/lib/x-poll-cycle.cjs precisely so it could stop being asserted as
// source TEXT and start being EXECUTED. Every assertion this file used to make
// about those three functions now has a real behavioural test in
// tests/x-poll-cycle.test.mjs, named inline below so the trade is auditable:
//
//   fail-closed hydration, no publish over an unread state
//       -> 'clears the latch and resumes once the read succeeds'
//   cursors re-read under the lock, no stale cursor-map writeback
//       -> 'adopts the peer cursor map read under the lock instead of
//          republishing stale cursors'
//   serving snapshot re-read with them, peer's posts preserved
//       -> 'folds a peer post that only exists in Redis back into the published
//          snapshot'
//   429 backoff takes the LATER deadline / HIGHER attempt count
//       -> 'keeps the LATER deadline and the HIGHER attempt count when Redis is
//          older' and 'adopts a peer backoff that is later than ours'
//   publish precedes commit; a lost lease leaves state uncommitted
//       -> 'leaves xState uncommitted when the lease-guarded publish fails'
//   seed meta only after a real poll
//       -> 'omits seed metadata when no account was actually polled'
//   lock-loser re-hydrates and re-arms exactly once
//       -> 're-hydrates, refuses to poll, and re-arms the guard exactly once'
//   completed poll fenced on the guard generation
//       -> 'discards a result that lands after the guard generation moved on'
//
// Those replacements are not merely present, they are known to bite: reverting
// the peer-item fold, the Math.max backoff, the generation fence, or fail-closed
// hydration each turns that suite red.
const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

function functionBody(name) {
  const start = relay.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  // Every function in this file is top-level, but most are `async function`.
  // Terminating only on `\nfunction ` made an async declaration invisible as an
  // end marker, so a body ran on through every async function that followed it
  // and any assertion here could be satisfied by code in a different function.
  // Stop at the next top-level declaration of either kind.
  const rest = relay.slice(start + 1);
  const offsets = ['\nfunction ', '\nasync function ']
    .map((marker) => rest.indexOf(marker))
    .filter((index) => index >= 0);
  const next = offsets.length ? Math.min(...offsets) : -1;
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe('X relay wiring contract', () => {
  it('builds the poll cycle with the real relay collaborators', () => {
    // The cycle must be constructed from this file's Redis helpers and state, or
    // the executable tests in x-poll-cycle.test.mjs would be exercising a module
    // production never actually wires up.
    assert.match(relay, /const \{ createXPollCycle \} = require\('\.\/lib\/x-poll-cycle\.cjs'\)/);
    assert.match(relay, /const xPollCycle = createXPollCycle\(\{/);
    for (const dep of [
      'xState', 'xNewsAccounts', 'loadXAccounts',
      'upstashGet', 'upstashSetNx', 'upstashPublishXIfLockOwner', 'upstashReleaseLockIfOwner',
      'getPollGeneration', 'scheduleRetry',
      'X_FEED_CACHE_KEY', 'X_FEED_POLL_STATE_KEY', 'X_FEED_POLL_LOCK_KEY', 'X_FEED_META_KEY',
    ]) {
      assert.match(relay, new RegExp(`\\n\\s+${dep}[,:]`), `cycle must receive ${dep}`);
    }
  });

  it('hydrates once before scheduling the first poll', () => {
    const loop = functionBody('startXPollLoop');
    assert.match(loop, /await xPollCycle\.hydrate\(\)/);
    // Resume on the ORIGINAL cadence rather than polling immediately on every
    // restart: a crash-looping replica would otherwise re-poll 64 accounts on
    // each boot, against a bearer shared with company-monitoring-worker.
    assert.match(loop, /xState\.lastPollAt \+ X_POLL_INTERVAL_MS/);
    // A restart must not step on a live 429 window either.
    assert.match(loop, /xState\.rateLimitedUntil/);
    assert.doesNotMatch(loop, /sourceState: 'unavailable'/);
  });

  it('fences the guard on its own counter, never the persisted snapshot version', () => {
    assert.match(relay, /createPollGenerationGuard/);
    assert.match(relay, /stuckAfterMs: X_POLL_STUCK_AFTER_MS/);

    // The guard's run counter must NOT be xState.generation. That field is the
    // persisted snapshot version, and hydrate() rewrites it from Redis in the
    // middle of a live poll (lease conflict, hydration retry) — which retired the
    // generation the guard was fencing on, so its `.finally` never cleared
    // inFlight and the next tick skipped a whole cycle.
    assert.match(relay, /let xPollGeneration = 0;/);
    assert.match(relay, /getGeneration: \(\) => xPollGeneration/);
    assert.match(relay, /setGeneration: \(generation\) => \{ xPollGeneration = generation; \}/);
    assert.doesNotMatch(relay, /getGeneration: \(\) => xState\.generation/);
    // The cycle reads the counter through an accessor, so it cannot reach the
    // module-level mutable and cannot be handed xState.generation by mistake.
    assert.match(relay, /getPollGeneration: \(\) => xPollGeneration/);

    // The abort has to fire while the Redis lease is still held, and the guard is
    // only re-evaluated when a scheduled tick calls it — so the threshold must
    // sit below the CADENCE, not merely below the lease TTL: nothing evaluates it
    // in between, so a value in that gap never fires at all. Execute the two
    // definitions we actually ship across the clamp range instead of pinning
    // their literals, so a re-tune of either cannot drift them apart.
    const leaseExpression = /const X_FEED_POLL_LOCK_TTL_SECONDS = ([^;]+);/.exec(relay);
    const stuckExpression = /const X_POLL_STUCK_AFTER_MS = ([^;]+);/.exec(relay);
    assert.ok(leaseExpression && stuckExpression, 'lease TTL and stuck threshold must both be named constants');
    const evaluate = (expression, intervalMs) => new Function('X_POLL_INTERVAL_MS', `return (${expression});`)(intervalMs);
    for (const intervalMs of [5 * 60_000, 10 * 60_000, 15 * 60_000]) {
      const stuckAfterMs = evaluate(stuckExpression[1], intervalMs);
      const leaseMs = evaluate(leaseExpression[1], intervalMs) * 1000;
      assert.ok(stuckAfterMs > 0, `stuck threshold must stay positive at a ${intervalMs}ms cadence`);
      assert.ok(stuckAfterMs < intervalMs, `stuck threshold must fire on the next tick at a ${intervalMs}ms cadence`);
      assert.ok(stuckAfterMs < leaseMs, `stuck threshold must fire before the lease lapses at a ${intervalMs}ms cadence`);
    }
  });

  it('lets RPC request tombstones while the first-party default hides them', () => {
    assert.match(relay, /includeDeleted = url\.searchParams\.get\('includeDeleted'\) === '1'/);
    assert.match(relay, /if \(!includeDeleted && it\.contentState === 'deleted'\) return false/);
  });
});
