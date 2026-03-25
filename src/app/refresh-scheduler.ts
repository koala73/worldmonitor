import type { AppContext, AppModule } from '@/app/app-context';
import { startSmartPollLoop, VisibilityHub, type SmartPollLoopHandle } from '@/services/runtime';

export interface RefreshRegistration {
  name: string;
  fn: () => Promise<boolean | void>;
  intervalMs: number;
  condition?: () => boolean;
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
    fn: () => Promise<boolean | void>,
    intervalMs: number,
    condition?: () => boolean
  ): void {
    this.refreshRunners.get(name)?.loop.stop();

    const loop = startSmartPollLoop(async () => {
      if (this.ctx.isDestroyed) return;
      if (condition && !condition()) return;
      if (this.ctx.inFlight.has(name)) return;

      this.ctx.inFlight.add(name);
      try {
        return await fn();
      } finally {
        this.ctx.inFlight.delete(name);
      }
    }, {
      intervalMs,
      pauseWhenHidden: true,
      refreshOnVisible: false,
      runImmediately: false,
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
      this.scheduleRefresh(reg.name, reg.fn, reg.intervalMs, reg.condition);
    }
  }
}
