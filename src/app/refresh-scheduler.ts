import type { AppContext, AppModule } from '@/app/app-context';

export interface RefreshRegistration {
  name: string;
  fn: () => Promise<boolean | void>;
  intervalMs: number;
  condition?: () => boolean;
}

export class RefreshScheduler implements AppModule {
  private ctx: AppContext;
  private refreshTimeoutIds: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private refreshRunners = new Map<string, { run: () => Promise<void>; intervalMs: number }>();
  private hiddenSince = 0;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  init(): void {}

  destroy(): void {
    for (const timeoutId of this.refreshTimeoutIds.values()) {
      clearTimeout(timeoutId);
    }
    this.refreshTimeoutIds.clear();
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
    const HIDDEN_REFRESH_MULTIPLIER = 10;
    const JITTER_FRACTION = 0.1;
    const MIN_REFRESH_MS = 1000;
    // Max effective interval: intervalMs * 4 (backoff) * 10 (hidden) = 40x base
    const MAX_BACKOFF_MULTIPLIER = 4;

    let currentMultiplier = 1;

    const computeDelay = (baseMs: number, isHidden: boolean) => {
      const adjusted = baseMs * (isHidden ? HIDDEN_REFRESH_MULTIPLIER : 1);
      const jitterRange = adjusted * JITTER_FRACTION;
      const jittered = adjusted + (Math.random() * 2 - 1) * jitterRange;
      return Math.max(MIN_REFRESH_MS, Math.round(jittered));
    };
    const scheduleNext = (delay: number) => {
      if (this.ctx.isDestroyed) return;
      const timeoutId = setTimeout(run, delay);
      this.refreshTimeoutIds.set(name, timeoutId);
    };
    const run = async () => {
      if (this.ctx.isDestroyed) return;
      const isHidden = document.visibilityState === 'hidden';
      if (isHidden) {
        scheduleNext(computeDelay(intervalMs * currentMultiplier, true));
        return;
      }
      if (condition && !condition()) {
        scheduleNext(computeDelay(intervalMs * currentMultiplier, false));
        return;
      }
      if (this.ctx.inFlight.has(name)) {
        scheduleNext(computeDelay(intervalMs * currentMultiplier, false));
        return;
      }
      this.ctx.inFlight.add(name);
      try {
        const changed = await fn();
        if (changed === false) {
          currentMultiplier = Math.min(currentMultiplier * 2, MAX_BACKOFF_MULTIPLIER);
        } else {
          currentMultiplier = 1;
        }
      } catch (e) {
        console.error(`[App] Refresh ${name} failed:`, e);
        currentMultiplier = Math.min(currentMultiplier * 2, MAX_BACKOFF_MULTIPLIER);
      } finally {
        this.ctx.inFlight.delete(name);
        scheduleNext(computeDelay(intervalMs * currentMultiplier, false));
      }
    };
    this.refreshRunners.set(name, { run, intervalMs });
    scheduleNext(computeDelay(intervalMs, document.visibilityState === 'hidden'));
  }

  flushStaleRefreshes(): void {
    if (!this.hiddenSince) return;
    const hiddenMs = Date.now() - this.hiddenSince;
    this.hiddenSince = 0;

    let stagger = 0;
    for (const [name, { run, intervalMs }] of this.refreshRunners) {
      if (hiddenMs < intervalMs) continue;
      const pending = this.refreshTimeoutIds.get(name);
      if (pending) clearTimeout(pending);
      const delay = stagger;
      stagger += 150;
      this.refreshTimeoutIds.set(name, setTimeout(() => void run(), delay));
    }
  }

  registerAll(registrations: RefreshRegistration[]): void {
    for (const reg of registrations) {
      this.scheduleRefresh(reg.name, reg.fn, reg.intervalMs, reg.condition);
    }
  }
}
