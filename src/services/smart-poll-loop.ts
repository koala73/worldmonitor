export type SmartPollReason = 'interval' | 'resume' | 'manual' | 'startup';

export interface SmartPollContext {
  signal?: AbortSignal;
  reason: SmartPollReason;
  isHidden: boolean;
}

export interface SmartPollOptions {
  intervalMs: number;
  hiddenIntervalMs?: number;
  hiddenMultiplier?: number;
  pauseWhenHidden?: boolean;
  refreshOnVisible?: boolean;
  runImmediately?: boolean;
  shouldRun?: () => boolean;
  maxBackoffMultiplier?: number;
  jitterFraction?: number;
  minIntervalMs?: number;
  onError?: (error: unknown) => void;
  visibilityDebounceMs?: number;
  visibilityHub?: VisibilityHub;
}

export class VisibilityHub {
  private listeners = new Set<() => void>();
  private listening = false;
  private handler: (() => void) | null = null;

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    this.ensureListening();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stopListening();
    };
  }

  destroy(): void {
    this.stopListening();
    this.listeners.clear();
  }

  private ensureListening(): void {
    if (this.listening || !hasVisibilityApi()) return;
    this.handler = () => {
      for (const cb of this.listeners) cb();
    };
    document.addEventListener('visibilitychange', this.handler);
    this.listening = true;
  }

  private stopListening(): void {
    if (!this.listening || !this.handler) return;
    document.removeEventListener('visibilitychange', this.handler);
    this.handler = null;
    this.listening = false;
  }
}

export interface SmartPollLoopHandle {
  stop: () => void;
  trigger: () => void;
  isActive: () => boolean;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError';
}

function hasVisibilityApi(): boolean {
  return typeof document !== 'undefined'
    && typeof document.addEventListener === 'function'
    && typeof document.removeEventListener === 'function';
}

function isDocumentHidden(): boolean {
  return hasVisibilityApi() && document.visibilityState === 'hidden';
}

export function startSmartPollLoop(
  poll: (ctx: SmartPollContext) => Promise<boolean | void> | boolean | void,
  opts: SmartPollOptions,
): SmartPollLoopHandle {
  const intervalMs = Math.max(1_000, Math.round(opts.intervalMs));
  const hiddenMultiplier = Math.max(1, opts.hiddenMultiplier ?? 10);
  const pauseWhenHidden = opts.pauseWhenHidden ?? false;
  const refreshOnVisible = opts.refreshOnVisible ?? true;
  const runImmediately = opts.runImmediately ?? false;
  const shouldRun = opts.shouldRun;
  const onError = opts.onError;
  const maxBackoffMultiplier = Math.max(1, opts.maxBackoffMultiplier ?? 4);
  const jitterFraction = Math.max(0, opts.jitterFraction ?? 0.1);
  const minIntervalMs = Math.max(250, opts.minIntervalMs ?? 1_000);
  const hiddenIntervalMs = opts.hiddenIntervalMs !== undefined
    ? Math.max(minIntervalMs, Math.round(opts.hiddenIntervalMs))
    : undefined;

  const visibilityDebounceMs = Math.max(0, opts.visibilityDebounceMs ?? 300);

  let active = true;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let visibilityDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let backoffMultiplier = 1;
  let activeController: AbortController | null = null;

  const clearTimer = () => {
    if (!timerId) return;
    clearTimeout(timerId);
    timerId = null;
  };

  const baseDelayMs = (hidden: boolean): number | null => {
    if (hidden) {
      if (pauseWhenHidden) return null;
      return hiddenIntervalMs ?? (intervalMs * hiddenMultiplier);
    }
    return intervalMs * backoffMultiplier;
  };

  const computeDelay = (baseMs: number): number => {
    const jitterRange = baseMs * jitterFraction;
    const jittered = baseMs + ((Math.random() * 2 - 1) * jitterRange);
    return Math.max(minIntervalMs, Math.round(jittered));
  };

  const scheduleNext = () => {
    if (!active) return;
    clearTimer();
    const base = baseDelayMs(isDocumentHidden());
    if (base === null) return;
    timerId = setTimeout(() => {
      timerId = null;
      void runOnce('interval');
    }, computeDelay(base));
  };

  const runOnce = async (reason: SmartPollReason): Promise<void> => {
    if (!active) return;

    const hidden = isDocumentHidden();
    if (hidden && pauseWhenHidden) {
      scheduleNext();
      return;
    }
    if (shouldRun && !shouldRun()) {
      scheduleNext();
      return;
    }
    if (inFlight) {
      scheduleNext();
      return;
    }

    inFlight = true;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeController = controller;

    try {
      const result = await poll({
        signal: controller?.signal,
        reason,
        isHidden: hidden,
      });

      if (result === false) {
        backoffMultiplier = Math.min(backoffMultiplier * 2, maxBackoffMultiplier);
      } else {
        backoffMultiplier = 1;
      }
    } catch (error) {
      if (!controller?.signal.aborted && !isAbortError(error)) {
        backoffMultiplier = Math.min(backoffMultiplier * 2, maxBackoffMultiplier);
        if (onError) onError(error);
      }
    } finally {
      if (activeController === controller) activeController = null;
      inFlight = false;
      scheduleNext();
    }
  };

  const clearVisibilityDebounce = () => {
    if (visibilityDebounceTimer) {
      clearTimeout(visibilityDebounceTimer);
      visibilityDebounceTimer = null;
    }
  };

  const handleVisibilityChange = () => {
    if (!active) return;
    const hidden = isDocumentHidden();

    if (hidden) {
      if (pauseWhenHidden) {
        clearTimer();
        activeController?.abort();
        return;
      }
      scheduleNext();
      return;
    }

    if (refreshOnVisible) {
      clearTimer();
      void runOnce('resume');
      return;
    }

    scheduleNext();
  };

  const onVisibilityChange = () => {
    if (!active) return;
    if (visibilityDebounceMs > 0 && !isDocumentHidden()) {
      clearVisibilityDebounce();
      visibilityDebounceTimer = setTimeout(handleVisibilityChange, visibilityDebounceMs);
      return;
    }
    handleVisibilityChange();
  };

  let unsubVisibility: (() => void) | null = null;
  if (opts.visibilityHub) {
    unsubVisibility = opts.visibilityHub.subscribe(onVisibilityChange);
  } else if (hasVisibilityApi()) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  if (runImmediately) {
    void runOnce('startup');
  } else {
    scheduleNext();
  }

  return {
    stop: () => {
      if (!active) return;
      active = false;
      clearTimer();
      clearVisibilityDebounce();
      activeController?.abort();
      activeController = null;
      if (unsubVisibility) {
        unsubVisibility();
        unsubVisibility = null;
      } else if (hasVisibilityApi()) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    },
    trigger: () => {
      if (!active) return;
      clearTimer();
      void runOnce('manual');
    },
    isActive: () => active,
  };
}
