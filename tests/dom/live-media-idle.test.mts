import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeLiveMediaIdle } from '@/services/live-media-idle';
import { LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, setLiveMediaIdleStop } from '@/services/live-stream-settings';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove', 'wheel', 'click'];

const disposers: Array<() => void> = [];

function subscribe(listener: Parameters<typeof subscribeLiveMediaIdle>[0] = vi.fn()) {
  const dispose = subscribeLiveMediaIdle(listener);
  disposers.push(dispose);
  return { listener, dispose };
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

function userActivity(type = 'mousemove', target: EventTarget = document): void {
  target.dispatchEvent(new Event(type));
}

describe('live media idle clock', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    Reflect.deleteProperty(document, 'hidden');
    vi.useRealTimers();
    localStorage.clear();
  });

  it('fires at the policy duration and not before', () => {
    const { listener } = subscribe();
    vi.advanceTimersByTime(HOUR - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(HOUR);
  });

  it('pushes the deadline out on every kind of user activity', () => {
    const { listener } = subscribe();
    for (const type of ACTIVITY_EVENTS) {
      vi.advanceTimersByTime(50 * MINUTE);
      userActivity(type);
    }
    const scroller = document.createElement('div');
    document.body.append(scroller);
    vi.advanceTimersByTime(50 * MINUTE);
    userActivity('scroll', scroller);
    scroller.remove();

    vi.advanceTimersByTime(HOUR - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires once per idle episode and starts the next episode at the next activity', () => {
    const { listener } = subscribe();
    vi.advanceTimersByTime(HOUR);
    vi.advanceTimersByTime(10 * HOUR);
    expect(listener).toHaveBeenCalledTimes(1);

    userActivity('keydown');
    vi.advanceTimersByTime(HOUR - 1);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('suspends while the tab is hidden and treats becoming visible as activity', () => {
    const { listener } = subscribe();
    vi.advanceTimersByTime(30 * MINUTE);
    setHidden(true);
    vi.advanceTimersByTime(10 * HOUR);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    setHidden(false);
    vi.advanceTimersByTime(HOUR - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('starts suspended when the first subscriber joins a hidden tab', () => {
    setHidden(true);
    const { listener } = subscribe();
    vi.advanceTimersByTime(10 * HOUR);
    expect(listener).not.toHaveBeenCalled();
    setHidden(false);
    vi.advanceTimersByTime(HOUR);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never fires and holds no timer when the policy is never', () => {
    setLiveMediaIdleStop('never');
    const { listener } = subscribe();
    userActivity('click');
    vi.advanceTimersByTime(24 * HOUR);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-arms from the last activity when the policy changes', () => {
    const { listener } = subscribe();
    vi.advanceTimersByTime(10 * MINUTE);
    setLiveMediaIdleStop(30);
    vi.advanceTimersByTime(20 * MINUTE - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledWith(30 * MINUTE);
  });

  it('fires on the next tick when a shorter policy is already past due', () => {
    const { listener } = subscribe();
    vi.advanceTimersByTime(20 * MINUTE);
    setLiveMediaIdleStop(15);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(listener).toHaveBeenCalledWith(15 * MINUTE);
  });

  it('starts counting when another tab turns never into a duration', () => {
    setLiveMediaIdleStop('never');
    const { listener } = subscribe();
    vi.advanceTimersByTime(3 * HOUR);
    localStorage.setItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, '240');
    window.dispatchEvent(new StorageEvent('storage', { key: LIVE_MEDIA_IDLE_STOP_STORAGE_KEY }));
    vi.advanceTimersByTime(HOUR - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledWith(4 * HOUR);
  });

  it('isolates a throwing subscriber from the others', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribe(() => {
      throw new Error('boom');
    });
    const { listener } = subscribe();
    vi.advanceTimersByTime(HOUR);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it('keeps running for remaining subscribers and fully detaches after the last one leaves', () => {
    const added: string[] = [];
    const removed: string[] = [];
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    addSpy.mockImplementation(function (this: Document, type, ...rest) {
      added.push(type);
      return EventTarget.prototype.addEventListener.call(this, type, ...rest);
    });
    removeSpy.mockImplementation(function (this: Document, type, ...rest) {
      removed.push(type);
      return EventTarget.prototype.removeEventListener.call(this, type, ...rest);
    });

    const first = subscribe();
    const second = subscribe();
    first.dispose();
    first.dispose();
    vi.advanceTimersByTime(HOUR);
    expect(first.listener).not.toHaveBeenCalled();
    expect(second.listener).toHaveBeenCalledTimes(1);

    second.dispose();
    userActivity('mousemove');
    expect(vi.getTimerCount()).toBe(0);
    expect(added.length).toBeGreaterThan(0);
    expect([...removed].sort()).toEqual([...added].sort());
    addSpy.mockRestore();
    removeSpy.mockRestore();

    const third = subscribe();
    vi.advanceTimersByTime(HOUR);
    expect(third.listener).toHaveBeenCalledTimes(1);
  });
});
