/**
 * `Panel` content dirty-check — DOM regression coverage.
 *
 * Both content dirty-checks used to read `this.content.innerHTML`, which
 * serializes the entire panel subtree to a string. It was read twice per update
 * (once to decide whether to schedule the debounced write, once to decide
 * whether to perform it), on a render path every panel runs on every data tick.
 *
 * The replacement tracks the last committed string in `lastCommittedHtml`. That
 * is only sound if EVERY other writer invalidates it — `showLoading`,
 * `showError`, the locked states, `clearContent`, the saved-content restore. If
 * one forgets, the panel silently refuses to re-render content it believes is
 * already on screen, and the panel appears frozen on a stale loading spinner.
 *
 * The `re-renders identical content after …` cases below are the witnesses for
 * that: they set X, replace the DOM behind the cache, then set X again and
 * require it back. With the invalidation removed they fail; a plain
 * "same content twice is a no-op" test would not.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Panel } from '@/components/Panel';
import { unsafeRawHtml } from '@/utils/sanitize';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const CONTENT_DEBOUNCE_MS = 150;
const BODY_A = '<div class="probe-a">alpha</div>';
const BODY_B = '<div class="probe-b">beta</div>';

let panel: Panel;

function content(): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

function setBody(html: string, afterUpdate?: () => void): void {
  panel.setSafeContent(unsafeRawHtml(html, 'test fixture'), afterUpdate);
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  panel = new Panel({ id: 'content-cache-probe', title: 'Probe' });
  document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
});

afterEach(() => {
  panel.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('Panel content dirty-check', () => {
  it('commits content and reports it', () => {
    setBody(BODY_A);
    expect(content().querySelector('.probe-a')).not.toBeNull();
  });

  it('does not rewrite the DOM when the same content is set again', () => {
    setBody(BODY_A);
    const first = content().querySelector('.probe-a');
    expect(first).not.toBeNull();

    setBody(BODY_A);

    // Same node instance: the redundant write was skipped.
    expect(content().querySelector('.probe-a')).toBe(first);
  });

  it('still fires afterUpdate when the write is skipped as redundant', () => {
    setBody(BODY_A);
    const afterUpdate = vi.fn();

    setBody(BODY_A, afterUpdate);

    expect(afterUpdate).toHaveBeenCalledTimes(1);
  });

  it('swaps the DOM when the content actually changes', () => {
    setBody(BODY_A);
    setBody(BODY_B);

    expect(content().querySelector('.probe-a')).toBeNull();
    expect(content().querySelector('.probe-b')).not.toBeNull();
  });

  it('re-renders identical content after showLoading replaced it', () => {
    setBody(BODY_A);
    panel.showLoading();
    expect(content().querySelector('.panel-loading')).not.toBeNull();
    expect(content().querySelector('.probe-a')).toBeNull();

    setBody(BODY_A);

    expect(content().querySelector('.probe-a')).not.toBeNull();
    expect(content().querySelector('.panel-loading')).toBeNull();
  });

  it('re-renders identical content after showError replaced it', () => {
    setBody(BODY_A);
    panel.showError('boom');
    expect(content().querySelector('.panel-error-state')).not.toBeNull();

    setBody(BODY_A);

    expect(content().querySelector('.probe-a')).not.toBeNull();
    expect(content().querySelector('.panel-error-state')).toBeNull();
  });

  it('cancels a pending different write when content returns to the committed value', () => {
    // A is committed; B is queued behind the debounce; then the caller asks for A
    // again. Taking the "already committed" fast path without cancelling B lets B
    // land afterwards — the DOM ends up showing content nobody asked for, and it
    // stays that way until the next render.
    setBody(BODY_A);
    panel.setSafeContent(unsafeRawHtml(BODY_B, 'test fixture'));
    panel.setSafeContent(unsafeRawHtml(BODY_A, 'test fixture'));

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS * 3);

    expect(content().querySelector('.probe-b')).toBeNull();
    expect(content().querySelector('.probe-a')).not.toBeNull();
  });

  it('re-renders identical content after clearSensitiveContent emptied it', () => {
    setBody(BODY_A);
    // Protected: it is the entitlement-change path, and it is one of the
    // writers that must invalidate the cache.
    (panel as unknown as { clearSensitiveContent: () => void }).clearSensitiveContent();
    expect(content().querySelector('.probe-a')).toBeNull();

    setBody(BODY_A);

    expect(content().querySelector('.probe-a')).not.toBeNull();
  });
});

interface ImmediateWriter {
  setSafeContentImmediate: (html: ReturnType<typeof unsafeRawHtml>, afterUpdate?: () => void) => void;
  contentDebounceTimer: ReturnType<typeof setTimeout> | null;
  pendingContentCallback: (() => void) | null;
  _locked: boolean;
}

function immediate(): ImmediateWriter {
  return panel as unknown as ImmediateWriter;
}

function setBodyImmediate(html: string, afterUpdate?: () => void): void {
  immediate().setSafeContentImmediate(unsafeRawHtml(html, 'test fixture'), afterUpdate);
}

describe('Panel immediate safe content commit (#7775)', () => {
  it('commits through the safe HTML path without the 150 ms timer', () => {
    setBodyImmediate(BODY_A);

    expect(immediate().contentDebounceTimer).toBeNull();
    expect(content().querySelector('.probe-a')).not.toBeNull();
  });

  it('commits a still-queued same body immediately instead of waiting', () => {
    setBody(BODY_A);
    panel.setSafeContent(unsafeRawHtml(BODY_B, 'test fixture'));
    expect(immediate().contentDebounceTimer).not.toBeNull();
    expect(content().querySelector('.probe-b')).toBeNull();

    setBodyImmediate(BODY_B);

    expect(immediate().contentDebounceTimer).toBeNull();
    expect(content().querySelector('.probe-b')).not.toBeNull();
    expect(content().querySelector('.probe-a')).toBeNull();

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS * 3);
    expect(content().querySelector('.probe-b')).not.toBeNull();
  });

  it('cancels a queued write and its callback; the surviving callback runs once', () => {
    setBody(BODY_A);
    const superseded = vi.fn();
    const surviving = vi.fn();
    panel.setSafeContent(unsafeRawHtml(BODY_B, 'test fixture'), superseded);
    expect(immediate().contentDebounceTimer).not.toBeNull();

    setBodyImmediate(BODY_A.replace('alpha', 'gamma').replace('probe-a', 'probe-c'), surviving);

    expect(superseded).not.toHaveBeenCalled();
    expect(surviving).toHaveBeenCalledTimes(1);
    expect(content().querySelector('.probe-c')).not.toBeNull();
    expect(content().querySelector('.probe-b')).toBeNull();

    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS * 3);
    expect(superseded).not.toHaveBeenCalled();
    expect(surviving).toHaveBeenCalledTimes(1);
    expect(content().querySelector('.probe-b')).toBeNull();
  });

  it('preserves same-content dirty checking and still runs afterUpdate', () => {
    setBodyImmediate(BODY_A);
    const first = content().querySelector('.probe-a');
    const afterUpdate = vi.fn();

    setBodyImmediate(BODY_A, afterUpdate);

    expect(afterUpdate).toHaveBeenCalledTimes(1);
    expect(content().querySelector('.probe-a')).toBe(first);
    expect(immediate().contentDebounceTimer).toBeNull();
  });

  it('does not lower the background coalescing timer', () => {
    setBodyImmediate(BODY_A);
    panel.setSafeContent(unsafeRawHtml(BODY_B, 'test fixture'));

    expect(content().querySelector('.probe-b')).toBeNull();
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS - 1);
    expect(content().querySelector('.probe-b')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(content().querySelector('.probe-b')).not.toBeNull();
  });

  it('bails on a locked panel at schedule time', () => {
    panel.showLocked(['probe feature']);
    setBodyImmediate('<div class="premium-payload">paid</div>');

    expect(content().querySelector('.premium-payload')).toBeNull();
    expect(content().querySelector('.panel-locked-state')).not.toBeNull();
  });

  it('clears error/retry state on an immediate commit', () => {
    const retry = vi.fn();
    panel.showError('boom', retry, 15);
    expect(content().querySelector('.panel-error-state')).not.toBeNull();

    setBodyImmediate(BODY_A);

    expect(content().querySelector('.probe-a')).not.toBeNull();
    expect(content().querySelector('.panel-error-state')).toBeNull();
    expect((panel as unknown as { header: HTMLElement }).header.classList.contains('panel-header-error')).toBe(false);
    expect((panel as unknown as { retryCountdownTimer: ReturnType<typeof setInterval> | null }).retryCountdownTimer).toBeNull();
    expect((panel as unknown as { retryAttempt: number }).retryAttempt).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('destroy drops a queued callback so it cannot run later', () => {
    const callback = vi.fn();
    panel.setSafeContent(unsafeRawHtml(BODY_A, 'test fixture'), callback);
    panel.destroy();
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS * 3);
    expect(callback).not.toHaveBeenCalled();
  });
});
