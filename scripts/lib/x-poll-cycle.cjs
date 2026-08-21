'use strict';

// ─────────────────────────────────────────────────────────────
// X news-account poll cycle (Track A / #6654), lifted verbatim out of
// scripts/ais-relay.cjs so it can be EXECUTED by tests. The relay entrypoint is
// 13k lines with no module.exports and no require.main guard, so importing it
// boots the whole relay — which meant this glue could only ever be asserted
// against as source text. Three defects (a generation-field collision, a lease
// handoff that dropped a peer replica's posts, and a stuck-abort threshold that
// outlived the Redis lease) all lived here and all were invisible to a regex.
// Everything the cycle reaches for is injected, so a test can drive the Redis
// lease, hydration and publish paths directly.
// ─────────────────────────────────────────────────────────────

const REQUIRED_DEPS = [
  'xState',
  'xNewsAccounts',
  'loadXAccounts',
  'upstashGet',
  'upstashSetNx',
  'upstashPublishXIfLockOwner',
  'upstashReleaseLockIfOwner',
  'getPollGeneration',
  'scheduleRetry',
  'randomId',
];

function createXPollCycle(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (deps[name] == null) throw new TypeError(`${name} is required`);
  }
  const {
    // The relay's mutable in-process X state. Mutated in place, exactly as it
    // was when these three functions lived next to it.
    xState,
    xNewsAccounts,
    loadXAccounts,
    upstashGet,
    upstashSetNx,
    upstashPublishXIfLockOwner,
    upstashReleaseLockIfOwner,
    // The poll guard's in-process run counter — NOT xState.generation. Read
    // through an accessor so this module can never reach a module-level mutable
    // in the relay. See the comment on `let xPollGeneration` there for why the
    // two counters must stay apart.
    getPollGeneration,
    // guardedXPoll. Re-arms the guard after a lease conflict; takes the same
    // `retryAfterLeaseConflict` argument the guard passes down.
    scheduleRetry,
    randomId,
    X_ENABLED = false,
    X_BEARER_TOKEN = '',
    X_FEED_CACHE_KEY,
    X_FEED_META_KEY,
    X_FEED_POLL_STATE_KEY,
    X_FEED_POLL_LOCK_KEY,
    X_FEED_TTL_SECONDS,
    X_FEED_META_TTL_SECONDS,
    X_FEED_POLL_LOCK_TTL_SECONDS,
    X_MAX_FEED_ITEMS,
    X_MAX_TEXT_CHARS,
    log = () => {},
    warn = () => {},
    now = Date.now,
    pid = process.pid,
    fetchImpl = (...args) => globalThis.fetch(...args),
    // setTimeout + unref, injectable so a test does not have to wait out the
    // one-second lease-conflict retry delay.
    setTimer = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  } = deps;

  async function hydrate() {
    // upstashGet resolves null for BOTH "key absent" and "GET failed" (HTTP error,
    // timeout, parse failure). Those must not be treated alike: an absent key is a
    // legitimately empty start, but a failed read means Redis still holds last-good
    // state we cannot see. Hydrating from a failed read and then publishing would
    // overwrite that last-good snapshot with a near-empty one — a transient blip
    // turned into permanent data loss. The onFailure callback is the only place
    // the distinction survives, so latch it here.
    let readFailed = false;
    const snapshot = await upstashGet(X_FEED_CACHE_KEY, (reason) => {
      readFailed = true;
      warn(`[Relay] X snapshot hydration failed: ${reason}`);
    });
    const pollState = await upstashGet(X_FEED_POLL_STATE_KEY, (reason) => {
      readFailed = true;
      warn(`[Relay] X poll-state hydration failed: ${reason}`);
    });
    if (readFailed) {
      // Fail closed. pollOnce retries hydration and skips the cycle while this is
      // set, so we never publish from a state we could not fully read.
      xState.hydrationFailed = true;
      warn('[Relay] X hydration incomplete — refusing to poll or publish until a clean read');
      return false;
    }
    xState.hydrationFailed = false;
    const hydrated = xNewsAccounts.hydrateXFeedSnapshot(snapshot, {
      maxItems: X_MAX_FEED_ITEMS,
      pollState,
    });
    if (!hydrated) return false;
    xState.cursorByAccountId = hydrated.cursorByAccountId;
    xState.accountIdByHandle = hydrated.accountIdByHandle;
    xState.catchupByAccountId = hydrated.catchupByAccountId;
    xState.items = hydrated.items;
    xState.lookupOffset = hydrated.lookupOffset;
    xState.accountOffset = hydrated.accountOffset;
    xState.generation = hydrated.generation;
    xState.lastPollAt = hydrated.lastPollAt;
    xState.lastHealthyAt = hydrated.lastHealthyAt;
    xState.lastCoverage = hydrated.lastCoverage;
    // LATER deadline and HIGHER attempt count, never plain assignment — the same
    // invariant mergeRefreshedPollState enforces under the lock, and this is where
    // it matters most: hydrate also runs mid-poll, so a 429 backoff this
    // process recorded seconds ago would otherwise be cleared by an older Redis
    // copy and the next tick would go straight back at a rate-limited upstream.
    xState.rateLimitedUntil = Math.max(xState.rateLimitedUntil || 0, hydrated.rateLimitedUntil);
    xState.rateLimitAttempt = Math.max(xState.rateLimitAttempt || 0, hydrated.rateLimitAttempt);
    log(`[Relay] X snapshot hydrated: generation ${xState.generation}, ${xState.items.length} items`);
    return true;
  }

  async function publish(expectedAccounts, { cycleComplete, accountsPolled, lockOwner, state = xState } = {}) {
    const snapshot = xNewsAccounts.buildXFeedSnapshot(state, {
      enabled: X_ENABLED,
      expectedAccounts,
    });
    const meta = accountsPolled > 0 ? {
      fetchedAt: state.lastPollAt,
      recordCount: snapshot.count,
      generation: snapshot.generation,
      coverage: snapshot.coverage,
      sourceState: cycleComplete ? 'ok' : 'degraded',
    } : null;
    const published = await upstashPublishXIfLockOwner({
      lockKey: X_FEED_POLL_LOCK_KEY,
      owner: lockOwner,
      snapshotKey: X_FEED_CACHE_KEY,
      snapshot,
      pollStateKey: X_FEED_POLL_STATE_KEY,
      pollState: xNewsAccounts.buildXPollState(state, { expectedAccounts }),
      ttlSeconds: X_FEED_TTL_SECONDS,
      metaKey: X_FEED_META_KEY,
      meta,
      metaTtlSeconds: X_FEED_META_TTL_SECONDS,
    });
    if (!published) {
      xState.lastError = xState.lastError || 'lost X poll lease before publication';
      return false;
    }
    return true;
  }

  async function pollOnce({ generation, signal, retryAfterLeaseConflict = false } = {}) {
    if (!X_ENABLED) return;
    if (xState.rateLimitedUntil && now() < xState.rateLimitedUntil) return;

    const lockOwner = `ais-relay:${pid}:${generation}:${now()}:${randomId()}`;
    const lockResult = await upstashSetNx(X_FEED_POLL_LOCK_KEY, lockOwner, X_FEED_POLL_LOCK_TTL_SECONDS);
    if (lockResult !== 'new') {
      warn(`[Relay] X poll skipped: shared lease is ${lockResult}`);
      // The /x route serves this process's xState.items. A replica that keeps
      // losing the lease used to hydrate once at boot and then never refresh, so
      // it served frozen (or, after a failed boot hydrate, empty) data forever
      // while Redis held last-good — and a load balancer would flip first-party
      // /api/x-feed between fresh and stale on alternate requests. Re-hydrate on
      // every lost lease so a non-owner converges, bounding its staleness to one
      // poll interval instead of the process lifetime.
      await hydrate();
      // One retry only. Passing `true` here would make the retry re-arm itself on
      // the next conflict, and a lease-conflict return clears the guard's
      // in-flight flag immediately — the hydrate just above only rewrites the
      // persisted snapshot version, so this run's poll-guard generation stamp
      // survives it and the guard's `.finally` still matches. That
      // self-perpetuated a ~1Hz SETNX + log storm for the whole lease TTL
      // (X_FEED_POLL_LOCK_TTL_SECONDS, ~17min) whenever a peer replica held the
      // lease. If this single retry also loses, the next scheduled tick picks it up.
      if (retryAfterLeaseConflict) {
        setTimer(() => {
          if (generation === getPollGeneration()) scheduleRetry(false);
        }, 1000);
      }
      return;
    }

    try {
      const accounts = xState.accounts.length ? xState.accounts : loadXAccounts();
      if (!accounts.length) return;

      // A previous cycle's read failure leaves us unable to see last-good state.
      // Retry once; if Redis is still unreadable, skip rather than publish over it.
      if (xState.hydrationFailed) {
        await hydrate();
        if (xState.hydrationFailed) {
          xState.lastError = 'X hydration still failing; skipped poll to protect last-good Redis state';
          return;
        }
      }

      // Cursors may have advanced under another replica since our boot hydrate.
      // buildXPollState serialises the WHOLE cursor map, including accounts this
      // cycle never touches — so polling from stale in-memory cursors and then
      // publishing would write those stale values back over a peer's newer ones,
      // rewinding since_id and re-fetching windows that were already consumed.
      // Re-read under the lock so we start from Redis truth.
      //
      // The serving snapshot has to be re-read with it. mergeRefreshedPollState
      // returns poll bookkeeping ONLY, on purpose, so items stay at whatever this
      // process last hydrated — and on the lease-conflict path that hydrate always
      // ran before the lease holder published, so our copy is missing that peer's
      // posts. Publishing from it drops them permanently: the cursor map we just
      // read has already advanced past their ids, so they are never re-fetched.
      let stateReadFailed = false;
      const freshPollState = await upstashGet(X_FEED_POLL_STATE_KEY, (reason) => {
        stateReadFailed = true;
        warn(`[Relay] X poll-state re-read failed: ${reason}`);
      });
      const freshSnapshot = await upstashGet(X_FEED_CACHE_KEY, (reason) => {
        stateReadFailed = true;
        warn(`[Relay] X snapshot re-read failed: ${reason}`);
      });
      if (stateReadFailed) {
        xState.lastError = 'Redis re-read failed under the lock; skipped cycle rather than risk a cursor rewind or item loss';
        return;
      }
      if (freshPollState) {
        const refreshed = xNewsAccounts.hydrateXFeedSnapshot(null, { pollState: freshPollState });
        if (refreshed) {
          // Cursors from Redis; rate-limit deadline whichever is LATER. See
          // mergeRefreshedPollState — the bearer is shared across replicas, so a
          // peer's 429 backoff applies here too, but it must not clear a backoff
          // this process recorded moments ago.
          Object.assign(xState, xNewsAccounts.mergeRefreshedPollState(xState, refreshed));
          // The snapshot version is Redis-owned like the cursors and must never go
          // backwards: a replica that sat out several peer cycles would otherwise
          // republish a lower number than the one already in Redis.
          xState.generation = Math.max(xState.generation, refreshed.generation);
        }
      }
      if (freshSnapshot) {
        const servingItems = xNewsAccounts.hydrateXFeedSnapshot(freshSnapshot, { maxItems: X_MAX_FEED_ITEMS });
        // mergeAndDedup is id-keyed and order-stable, so folding Redis's items in
        // is idempotent — the peer's posts come back and ours are still here for
        // the publish below.
        if (servingItems) xState.items = xNewsAccounts.mergeAndDedup(xState.items, servingItems.items, X_MAX_FEED_ITEMS);
      }
      // Honour a peer's still-active backoff rather than burning shared quota on a
      // 429 we already know about. The pre-lock check above only saw this
      // process's own state.
      if (xState.rateLimitedUntil && now() < xState.rateLimitedUntil) {
        xState.lastError = 'shared X rate-limit window still open; deferring poll';
        return;
      }

      const pollStart = now();
      const next = await xNewsAccounts.pollXFeed({
        accounts,
        state: xState,
        bearerToken: X_BEARER_TOKEN,
        fetchImpl: (...args) => fetchImpl(...args),
        now,
        maxFeedItems: X_MAX_FEED_ITEMS,
        maxTextChars: X_MAX_TEXT_CHARS,
        signal,
      });

      if (generation !== getPollGeneration() || signal?.aborted) {
        warn(`[Relay] X poll generation ${generation} finished stale; discarding result`);
        return;
      }

      // Rate-limit state is protective and applies whether or not we publish —
      // dropping it on a publish failure would let the next tick hammer a 429ing
      // upstream.
      xState.rateLimitedUntil = next.rateLimitedUntil || 0;
      xState.rateLimitAttempt = next.rateLimitAttempt || 0;
      xState.lastError = next.lastError;

      const pollCompletedAt = now();
      const candidate = {
        ...xState,
        // The persisted snapshot version advances once per PUBLISHED snapshot. It
        // used to move only as a side effect of the guard writing its run counter
        // into this same field; now that the guard fences on its own counter, the
        // publish path owns it. Built on the value re-read under the lock above, so
        // it stays monotonic across replicas.
        generation: xState.generation + 1,
        cursorByAccountId: next.cursorByAccountId,
        accountIdByHandle: next.accountIdByHandle,
        catchupByAccountId: next.catchupByAccountId,
        items: next.items,
        lookupOffset: next.lookupOffset || 0,
        accountOffset: next.accountOffset || 0,
        lastPollAt: pollCompletedAt,
        lastCoverage: {
          expected: accounts.length,
          polled: next.accountsPolled,
          failed: next.accountsFailed,
          attempted: next.accountsAttempted,
          complete: next.cycleComplete,
        },
        lastHealthyAt: next.cycleComplete ? pollCompletedAt : xState.lastHealthyAt,
      };

      const elapsed = ((pollCompletedAt - pollStart) / 1000).toFixed(1);
      log(`[Relay] X poll: ${next.accountsPolled}/${accounts.length} accounts, ${next.newCount} new posts, ${candidate.items.length} total, ${next.accountsFailed} errors (${elapsed}s)`);

      // Publish BEFORE committing. Advancing xState first left this process's
      // cursors ahead of Redis whenever the lease-guarded EVAL failed, so /x here
      // served data no other replica could see and the seed-meta key silently went
      // unrefreshed. On failure we keep the previous state and re-poll the same
      // window next cycle; mergeAndDedup makes that idempotent.
      const published = await publish(accounts.length, {
        cycleComplete: next.cycleComplete,
        accountsPolled: next.accountsPolled,
        lockOwner,
        state: candidate,
      });
      if (!published) {
        warn('[Relay] X publish failed; keeping previous state so Redis stays the source of truth');
        return;
      }
      Object.assign(xState, candidate);
    } finally {
      await upstashReleaseLockIfOwner(X_FEED_POLL_LOCK_KEY, lockOwner);
    }
  }

  return { hydrate, publish, pollOnce };
}

module.exports = { createXPollCycle };
