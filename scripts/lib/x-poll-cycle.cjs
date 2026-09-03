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
  'xPostBudget',
  'loadXAccounts',
  'upstashGet',
  'upstashSetNx',
  'upstashPublishXIfLockOwner',
  'upstashReleaseLockIfOwner',
  'getPollGeneration',
  'scheduleRetry',
  'randomId',
];

const DEFAULT_X_POLL_INTERVAL_MS = 15 * 60 * 1000;

function xPollSlot(nowMs, intervalMs = DEFAULT_X_POLL_INTERVAL_MS) {
  const timestamp = Number(nowMs);
  const interval = Number(intervalMs);
  if (!Number.isFinite(timestamp) || !Number.isFinite(interval) || interval <= 0) {
    throw new TypeError('a valid poll time and interval are required');
  }
  const startsAt = Math.floor(timestamp / interval) * interval;
  return {
    id: new Date(startsAt).toISOString(),
    startsAt,
    endsAt: startsAt + interval,
  };
}

function createXPollCycle(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (deps[name] == null) throw new TypeError(`${name} is required`);
  }
  const {
    // The relay's mutable in-process X state. Mutated in place, exactly as it
    // was when these three functions lived next to it.
    xState,
    xNewsAccounts,
    xPostBudget,
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
    X_CURATED_LIST_ID = '',
    X_POLL_INTERVAL_MS = DEFAULT_X_POLL_INTERVAL_MS,
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
    const [snapshot, pollState] = await Promise.all([
      upstashGet(X_FEED_CACHE_KEY, (reason) => {
        readFailed = true;
        warn(`[Relay] X snapshot hydration failed: ${reason}`);
      }),
      upstashGet(X_FEED_POLL_STATE_KEY, (reason) => {
        readFailed = true;
        warn(`[Relay] X poll-state hydration failed: ${reason}`);
      }),
    ]);
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
    xState.lastDeletionAuditAt = hydrated.lastDeletionAuditAt;
    xState.lastCycleUsage = hydrated.lastCycleUsage;
    xState.postBudget = hydrated.postBudget;
    xState.items = hydrated.items;
    xState.lookupOffset = hydrated.lookupOffset;
    xState.generation = hydrated.generation;
    xState.lastPollAt = hydrated.lastPollAt;
    xState.lastHealthyAt = hydrated.lastHealthyAt;
    xState.lastAttemptAt = hydrated.lastAttemptAt;
    xState.lastProviderSuccessAt = hydrated.lastProviderSuccessAt;
    xState.lastAcceptedPublicationAt = hydrated.lastAcceptedPublicationAt;
    xState.lastAttemptSlot = hydrated.lastAttemptSlot;
    xState.lastProviderSuccessSlot = hydrated.lastProviderSuccessSlot;
    xState.lastPublishedSlot = hydrated.lastPublishedSlot;
    xState.lastCoverage = hydrated.lastCoverage;
    // LATER deadline and HIGHER attempt count, never plain assignment — the same
    // invariant mergeRefreshedPollState enforces under the lock, and this is where
    // it matters most: hydrate also runs mid-poll, so a 429 backoff this
    // process recorded seconds ago would otherwise be cleared by an older Redis
    // copy and the next tick would go straight back at a rate-limited upstream.
    const mergedBackoff = xNewsAccounts.mergeRefreshedPollState(xState, hydrated);
    xState.rateLimitedUntil = mergedBackoff.rateLimitedUntil;
    xState.rateLimitAttempt = mergedBackoff.rateLimitAttempt;
    xState.backoffCause = mergedBackoff.backoffCause;
    if (xState.rateLimitedUntil && now() < xState.rateLimitedUntil) {
      xState.lastError = xNewsAccounts.sharedBackoffMessage(xState.backoffCause);
    }
    log(`[Relay] X snapshot hydrated: generation ${xState.generation}, ${xState.items.length} items`);
    return true;
  }

  async function publish(expectedAccounts, { cycleComplete, listAccepted, lockOwner, state = xState } = {}) {
    const snapshot = xNewsAccounts.buildXFeedSnapshot(state, {
      enabled: X_ENABLED,
      expectedAccounts,
    });
    const meta = listAccepted ? {
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
    const initialSlot = xPollSlot(now(), X_POLL_INTERVAL_MS);
    if (xState.lastAttemptSlot === initialSlot.id) return;
    if (xState.rateLimitedUntil && now() < xState.rateLimitedUntil) {
      xState.lastError = xNewsAccounts.sharedBackoffMessage(xState.backoffCause);
      return;
    }

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
      // whenever a peer replica held the lease. If this single retry also loses,
      // the next scheduled tick picks it up.
      if (retryAfterLeaseConflict) {
        setTimer(() => {
          if (generation === getPollGeneration()) scheduleRetry(false);
        }, 1000);
      }
      return;
    }

    let retryCurrentSlot = false;
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

      // Re-read aggregate poll state and the serving snapshot under the lock.
      // This makes the slot fence and last-good feed Redis-authoritative across
      // replicas before this process spends another paid request.
      let stateReadFailed = false;
      const [freshPollState, freshSnapshot] = await Promise.all([
        upstashGet(X_FEED_POLL_STATE_KEY, (reason) => {
          stateReadFailed = true;
          warn(`[Relay] X poll-state re-read failed: ${reason}`);
        }),
        upstashGet(X_FEED_CACHE_KEY, (reason) => {
          stateReadFailed = true;
          warn(`[Relay] X snapshot re-read failed: ${reason}`);
        }),
      ]);
      if (stateReadFailed) {
        xState.lastError = 'Redis re-read failed under the lock; skipped cycle rather than risk duplicate spend or item loss';
        return;
      }
      if (freshPollState) {
        const refreshed = xNewsAccounts.hydrateXFeedSnapshot(null, { pollState: freshPollState });
        if (refreshed) {
          // Rate-limit deadline whichever is LATER. See mergeRefreshedPollState
          // — the bearer is shared across replicas, so a
          // peer's 429 backoff applies here too, but it must not clear a backoff
          // this process recorded moments ago.
          Object.assign(xState, xNewsAccounts.mergeRefreshedPollState(xState, refreshed));
          // The snapshot version is Redis-owned and must never go backwards: a
          // replica that sat out several peer cycles would otherwise
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
        xState.lastError = xNewsAccounts.sharedBackoffMessage(xState.backoffCause);
        return;
      }
      const activeSlot = xPollSlot(now(), X_POLL_INTERVAL_MS);
      if (xState.lastAttemptSlot === activeSlot.id) return;

      const pollStart = now();
      const next = await xNewsAccounts.pollXFeed({
        accounts,
        state: xState,
        bearerToken: X_BEARER_TOKEN,
        listId: X_CURATED_LIST_ID,
        coverageId: `list-slot:${activeSlot.id}`,
        fetchImpl: (...args) => fetchImpl(...args),
        now,
        maxFeedItems: X_MAX_FEED_ITEMS,
        maxTextChars: X_MAX_TEXT_CHARS,
        withReturnedPosts: (request) => xPostBudget.withReturnedPosts(request),
        signal,
      });
      retryCurrentSlot = xPollSlot(now(), X_POLL_INTERVAL_MS).id !== activeSlot.id;

      if (generation !== getPollGeneration() || signal?.aborted) {
        warn(`[Relay] X poll generation ${generation} finished stale; discarding result`);
        return;
      }

      // Rate-limit state is protective and applies whether or not we publish —
      // dropping it on a publish failure would let the next tick hammer a 429ing
      // upstream.
      xState.rateLimitedUntil = next.rateLimitedUntil || 0;
      xState.rateLimitAttempt = next.rateLimitAttempt || 0;
      xState.backoffCause = next.backoffCause || null;
      xState.lastError = next.lastError;

      const pollCompletedAt = now();
      const acceptedSourceAt = next.listAccepted
        ? Math.min(Number(next.providerSuccessAt) || pollCompletedAt, pollCompletedAt)
        : xState.lastPollAt;
      const candidate = {
        ...xState,
        // The persisted snapshot version advances once per PUBLISHED snapshot. It
        // used to move only as a side effect of the guard writing its run counter
        // into this same field; now that the guard fences on its own counter, the
        // publish path owns it. Built on the value re-read under the lock above, so
        // it stays monotonic across replicas.
        generation: xState.generation + 1,
        lastDeletionAuditAt: next.lastDeletionAuditAt || 0,
        lastCycleUsage: next.lastCycleUsage || null,
        postBudget: next.postBudget || null,
        items: next.listAccepted ? next.items : xState.items,
        lookupOffset: next.lookupOffset || 0,
        lastAttemptAt: pollCompletedAt,
        lastAttemptSlot: activeSlot.id,
        lastProviderSuccessAt: next.providerSuccess
          ? (next.providerSuccessAt || pollCompletedAt)
          : xState.lastProviderSuccessAt,
        lastProviderSuccessSlot: next.providerSuccess
          ? (next.providerSuccessSlot || activeSlot.id)
          : xState.lastProviderSuccessSlot,
        lastAcceptedPublicationAt: next.listAccepted ? pollCompletedAt : xState.lastAcceptedPublicationAt,
        lastPublishedSlot: next.listAccepted ? activeSlot.id : xState.lastPublishedSlot,
        lastPollAt: acceptedSourceAt,
        lastCoverage: next.listAccepted ? {
          expected: accounts.length,
          polled: next.accountsPolled,
          failed: next.accountsFailed,
          attempted: next.accountsAttempted,
          complete: next.cycleComplete,
        } : xState.lastCoverage,
        lastHealthyAt: next.listAccepted && next.cycleComplete ? acceptedSourceAt : xState.lastHealthyAt,
      };

      const elapsed = ((pollCompletedAt - pollStart) / 1000).toFixed(1);
      const usage = next.lastCycleUsage || {};
      const budget = next.postBudget || {};
      log(`[Relay] X poll: ${next.accountsPolled}/${accounts.length} accounts, ${next.newCount} new Posts, ${candidate.items.length} total, ${next.accountsFailed} errors, requests ${usage.requestsUsed || 0}/${usage.requestLimit || 0}, Posts ${usage.postsRead || 0}/${usage.postReadLimit || 0}, day ${budget.dailyUsed || 0}/${budget.dailyLimit || 0}, month ${budget.monthlyUsed || 0}/${budget.monthlyLimit || 0} (${elapsed}s)`);

      // Publish BEFORE committing. Advancing xState first left this process's
      // cursors ahead of Redis whenever the lease-guarded EVAL failed, so /x here
      // served data no other replica could see and the seed-meta key silently went
      // unrefreshed. On failure we keep the previous state and re-poll the same
      // window next cycle. The paid List response stays in Redis as a
      // receipt, so the next replica replays it without calling X again.
      const published = await publish(accounts.length, {
        cycleComplete: next.cycleComplete,
        listAccepted: next.listAccepted,
        lockOwner,
        state: candidate,
      });
      if (!published) {
        warn('[Relay] X publish failed; keeping previous state so Redis stays the source of truth');
        return;
      }
      Object.assign(xState, candidate);
      if (next.receiptAcks?.length) {
        const acknowledged = await xPostBudget.ackReceipts(next.receiptAcks);
        if (!acknowledged) {
          warn('[Relay] X receipt acknowledgement failed; the next cycle will recover it without calling X');
        }
      }
    } finally {
      await upstashReleaseLockIfOwner(X_FEED_POLL_LOCK_KEY, lockOwner);
      if (retryCurrentSlot) {
        setTimer(() => {
          if (generation === getPollGeneration()) scheduleRetry(false);
        }, 1000);
      }
    }
  }

  return { hydrate, publish, pollOnce };
}

module.exports = { createXPollCycle, xPollSlot };
