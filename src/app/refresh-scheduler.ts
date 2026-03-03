import type { AppContext, AppModule } from '@/app/app-context';
import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/runtime';

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
      // De-escalate global refresh loops in background tabs to cut API volume.
      hiddenMultiplier: 10,
      refreshOnVisible: false,
      runImmediately: false,
      maxBackoffMultiplier: 4,
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

    let stagger = 0;
    for (const { loop, intervalMs } of this.refreshRunners.values()) {
      if (hiddenMs < intervalMs) continue;
      const delay = stagger;
      stagger += 150;
      const timeoutId = setTimeout(() => {
        this.flushTimeoutIds.delete(timeoutId);
        loop.trigger();
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
