import type { AppContext, AppModule } from '@/app/app-context';
import { startSmartPollLoop, VisibilityHub, type SmartPollLoopHandle } from '@/services/runtime';

/**
 * #6683: a lane's in-flight latch may only be held for a lease THIS scheduler
 * owns. `finally` releases the latch only when the awaited callback settles,
 * and a callback whose network call never settles — a third-party `fetch`
 * wrapper that rebuilds the request without `init.signal`, or re-wraps the
 * promise without forwarding rejection — parks the lane for the life of the
 * page with no outward symptom. Racing a scheduler-owned deadline mirrors
 * `withCollectorDeadline` from #6681 and inherits its two lessons:
 *
 *  1. the race wraps the WHOLE callback promise, so every `await` between
 *     latch-acquire and latch-release is inside the bound, not just the first
 *     fetch (the collector's first fix missed the response-body read);
 *  2. the lease sits a grace period above any request-side
 *     `AbortSignal.timeout`, so a cooperative lane always wins its own race
 *     and is never miscounted as wedged.
 *
 * The request-side bound is each lane's own `AbortSignal.timeout(...)` and is
 * not declared here, so the lease is floored well above typical request
 * timeouts and anchored to the lane's interval; only the already-anomalous
 * stalled tail ever reaches it (a healthy lane settles in milliseconds).
 */
const LANE_LEASE_FLOOR_MS = 15_000;
const LANE_LEASE_GRACE_MS = 5_000;

function laneLeaseMs(intervalMs: number): number {
  return Math.max(intervalMs, LANE_LEASE_FLOOR_MS) + LANE_LEASE_GRACE_MS;
}

/**
 * Run one refresh lane callback under a scheduler-owned lease (#6683).
 * Extracted so the lease semantics are unit-testable in isolation.
 *
 * - the latch (`inFlight`) is released in a `finally` that now ALWAYS runs,
 *   because the awaited promise is the callback raced against the lease —
 *   never the bare callback, which may not settle at all;
 * - the loser of the race is `.catch`-silenced so an abandoned callback's
 *   late rejection cannot surface as an unhandled rejection on the page;
 * - on expiry the lane warns (a wedged lane is otherwise indistinguishable
 *   from one whose data has not changed). A refresh lane is idempotent — it
 *   re-reads current state — so releasing and re-running is safe (no #6288
 *   duplicate-write caveat). Cancellation of a cooperative callback stays
 *   with the poll loop's own controller (stop()/hidden aborts), which this
 *   scheduler now forwards via `fn(signal)` instead of dropping it.
 */
export async function runLaneWithLease(
  name: string,
  fn: (signal?: AbortSignal) => Promise<boolean | void>,
  signal: AbortSignal | undefined,
  intervalMs: number,
  inFlight: Set<string>,
  warn: (message: string) => void = console.warn,
): Promise<boolean | void> {
  if (inFlight.has(name)) return;
  inFlight.add(name);
  const leaseMs = laneLeaseMs(intervalMs);
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const lease = new Promise<{ expired: true }>((resolve) => {
    leaseTimer = setTimeout(() => resolve({ expired: true }), leaseMs);
  });
  try {
    const callback = Promise.resolve(fn(signal));
    void callback.catch(() => {});
    const settled = callback.then(
      (value) => ({ expired: false as const, value }),
      (error) => ({ expired: false as const, error }),
    );
    const raced = await Promise.race([settled, lease]);
    if (raced.expired) {
      warn(
        `[App] Refresh ${name} lease expired after ${leaseMs}ms without settling — latch released and lane re-runnable; the callback is still parked (unbounded await, or a fetch wrapper that drops the abort signal)`,
      );
      return;
    }
    if ('error' in raced) throw raced.error;
    return raced.value;
  } finally {
    if (leaseTimer !== undefined) clearTimeout(leaseTimer);
    inFlight.delete(name);
  }
}

export interface RefreshRegistration {
  name: string;
  fn: (signal?: AbortSignal) => Promise<boolean | void>;
  intervalMs: number;
  condition?: () => boolean;
  runImmediately?: boolean;
}

export class RefreshScheduler implements AppModule {
  private ctx: AppContext;
  private refreshRunners = new Map<string, { loop: SmartPollLoopHandle; intervalMs: number }>();
  private flushTimeoutIds = new Set<ReturnType<typeof setTimeout>>();
  private hiddenSince = 0;
  private visibilityHub = new VisibilityHub();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  init(): void {}

  destroy(): void {
    for (const timeoutId of this.flushTimeoutIds) {
      clearTimeout(timeoutId);
    }
    this.flushTimeoutIds.clear();
    for (const { loop } of this.refreshRunners.values()) {
      loop.stop();
    }
    this.refreshRunners.clear();
    this.visibilityHub.destroy();
  }

  setHiddenSince(ts: number): void {
    this.hiddenSince = ts;
  }

  getHiddenSince(): number {
    return this.hiddenSince;
  }

  scheduleRefresh(
    name: string,
    fn: (signal?: AbortSignal) => Promise<boolean | void>,
    intervalMs: number,
    condition?: () => boolean,
    options: { runImmediately?: boolean } = {},
  ): void {
    this.refreshRunners.get(name)?.loop.stop();

    const loop = startSmartPollLoop(async (pollCtx) => {
      if (this.ctx.isDestroyed) return;
      if (condition && !condition()) return;
      if (this.ctx.isDestroyed) return;
      if (condition && !condition()) return;
      return runLaneWithLease(name, fn, pollCtx?.signal, intervalMs, this.ctx.inFlight);
    }, {
      intervalMs,
      pauseWhenHidden: true,
      refreshOnVisible: false,
      runImmediately: options.runImmediately ?? false,
      maxBackoffMultiplier: 4,
      visibilityHub: this.visibilityHub,
      onError: (e) => {
        console.error(`[App] Refresh ${name} failed:`, e);
      },
    });

    this.refreshRunners.set(name, { loop, intervalMs });
  }

  flushStaleRefreshes(): void {
    if (!this.hiddenSince) return;
    const hiddenMs = Date.now() - this.hiddenSince;
    this.hiddenSince = 0;

    for (const timeoutId of this.flushTimeoutIds) {
      clearTimeout(timeoutId);
    }
    this.flushTimeoutIds.clear();

    // Collect stale tasks and sort by interval ascending (highest-frequency first)
    const stale: { loop: SmartPollLoopHandle; intervalMs: number }[] = [];
    for (const entry of this.refreshRunners.values()) {
      if (hiddenMs >= entry.intervalMs) {
        stale.push(entry);
      }
    }
    stale.sort((a, b) => a.intervalMs - b.intervalMs);

    // Tiered stagger: first 4 gaps are 100ms (covering tasks 1-5), remaining gaps are 300ms
    const FLUSH_STAGGER_FAST_MS = 100;
    const FLUSH_STAGGER_SLOW_MS = 300;
    let stagger = 0;
    let idx = 0;
    for (const entry of stale) {
      const delay = stagger;
      stagger += (idx < 4) ? FLUSH_STAGGER_FAST_MS : FLUSH_STAGGER_SLOW_MS;
      idx++;
      const timeoutId = setTimeout(() => {
        this.flushTimeoutIds.delete(timeoutId);
        entry.loop.trigger();
      }, delay);
      this.flushTimeoutIds.add(timeoutId);
    }
  }

  registerAll(registrations: RefreshRegistration[]): void {
    for (const reg of registrations) {
      this.scheduleRefresh(reg.name, reg.fn, reg.intervalMs, reg.condition, {
        runImmediately: reg.runImmediately,
      });
    }
  }
}
