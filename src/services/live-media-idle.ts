import {
  getLiveMediaIdleStop,
  subscribeLiveStreamsSettingsChange,
  type LiveMediaIdleStop,
  type LiveStreamSettings,
} from '@/services/live-stream-settings';

/** Receives the idle-stop duration that elapsed, in milliseconds. */
type IdleListener = (idleAfterMs: number) => void;

interface IdleClock {
  lastActivityAt: number;
  suspended: boolean;
  notified: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  policyMs: number | null;
  readonly unsubscribeSettings: () => void;
}

const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove', 'wheel', 'click'] as const;
// Capture so scrolling a nested scroller, and input a component stops propagating, still count as activity.
const ACTIVITY_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };

const listeners = new Set<IdleListener>();
let clock: IdleClock | null = null;

function policyMsFor(idleStop: LiveMediaIdleStop): number | null {
  return idleStop === 'never' ? null : idleStop * 60_000;
}

function clearTimer(state: IdleClock): void {
  if (state.timer === null) return;
  clearTimeout(state.timer);
  state.timer = null;
}

function armFromLastActivity(state: IdleClock): void {
  clearTimer(state);
  if (state.suspended || state.notified || state.policyMs === null) return;
  const remaining = state.lastActivityAt + state.policyMs - Date.now();
  state.timer = setTimeout(onTimer, Math.max(0, remaining));
}

function onTimer(): void {
  if (!clock) return;
  clock.timer = null;
  if (clock.suspended || clock.notified || clock.policyMs === null) return;
  if (Date.now() - clock.lastActivityAt < clock.policyMs) {
    armFromLastActivity(clock);
    return;
  }
  clock.notified = true;
  const idleAfterMs = clock.policyMs;
  for (const listener of [...listeners]) {
    try {
      listener(idleAfterMs);
    } catch (error) {
      console.error('[live-media-idle] idle listener failed', error);
    }
  }
}

// Called for every mousemove, so it only moves the deadline; onTimer re-arms for the remainder.
function onActivity(): void {
  if (!clock) return;
  clock.lastActivityAt = Date.now();
  clock.notified = false;
  if (clock.timer === null) armFromLastActivity(clock);
}

function onVisibilityChange(): void {
  if (!clock) return;
  if (document.hidden) {
    clock.suspended = true;
    clearTimer(clock);
    return;
  }
  clock.suspended = false;
  onActivity();
}

function onSettingsChange(settings: LiveStreamSettings): void {
  if (!clock) return;
  clock.policyMs = policyMsFor(settings.idleStop);
  armFromLastActivity(clock);
}

function startClock(): void {
  const unsubscribeSettings = subscribeLiveStreamsSettingsChange(onSettingsChange);
  for (const type of ACTIVITY_EVENTS) document.addEventListener(type, onActivity, ACTIVITY_LISTENER_OPTIONS);
  document.addEventListener('visibilitychange', onVisibilityChange);
  clock = {
    lastActivityAt: Date.now(),
    suspended: document.hidden,
    notified: false,
    timer: null,
    policyMs: policyMsFor(getLiveMediaIdleStop()),
    unsubscribeSettings,
  };
  armFromLastActivity(clock);
}

function stopClock(): void {
  if (!clock) return;
  clearTimer(clock);
  clock.unsubscribeSettings();
  for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, onActivity, ACTIVITY_LISTENER_OPTIONS);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  clock = null;
}

/**
 * Subscribes to the single idle clock shared by every live media panel.
 *
 * The first subscriber installs document-wide activity and visibility listeners and starts the
 * clock; the last unsubscribe removes them. The clock fires once per idle episode, after the
 * idle-stop preference elapses without activity, and never signals "active again": ending an
 * idle stop is each panel's decision. A throwing subscriber is logged and does not block the rest.
 */
export function subscribeLiveMediaIdle(onIdle: IdleListener): () => void {
  const listener: IdleListener = (idleAfterMs) => onIdle(idleAfterMs);
  listeners.add(listener);
  if (!clock) startClock();
  return () => {
    if (!listeners.delete(listener)) return;
    if (listeners.size === 0) stopClock();
  };
}
