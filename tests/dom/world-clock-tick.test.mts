/**
 * WorldClockPanel 1 Hz tick — DOM regression coverage.
 *
 * The panel used to call `renderClocks()` from its 1 s interval, which builds a
 * fresh HTML string for every selected city and hands it to
 * `Panel.setSafeContent` — a full subtree replacement, once per second, forever,
 * gated only on drag/settings. That is a continuous main-thread tax that lands
 * in INP input delay for any interaction unlucky enough to share the window.
 *
 * A string-equality assertion cannot catch this: the rebuilt markup renders the
 * same clock face, so "the DOM looks right" holds either way. What separates a
 * rebuild from a patch is NODE IDENTITY — a rebuild throws the old nodes away.
 * These tests therefore pin the element instances across a tick and assert the
 * live values still move, so neither "rebuilds everything" nor "stopped
 * updating" can pass.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorldClockPanel } from '@/components/WorldClockPanel';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

/** Panel.setSafeContent commits behind a trailing debounce; drain it. */
const CONTENT_DEBOUNCE_MS = 150;

let panel: WorldClockPanel;

function content(): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

function container(): HTMLElement | null {
  return content().querySelector<HTMLElement>('.wc-container');
}

function rows(): HTMLElement[] {
  return Array.from(content().querySelectorAll<HTMLElement>('.wc-row'));
}

function timeTexts(): string[] {
  return Array.from(content().querySelectorAll<HTMLElement>('.wc-time')).map(
    (el) => el.textContent ?? '',
  );
}

/** Advance the clock AND the timers together so the tick sees a new second. */
function tick(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  // A fixed instant inside NYSE hours keeps the market-status branch stable, so
  // an OPEN→CLSD flip can't be mistaken for the identity break under test.
  vi.setSystemTime(new Date('2026-08-05T14:30:00.000Z'));
  localStorage.clear();
  panel = new WorldClockPanel();
  document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
  // Drain the debounce so the initial full render has committed.
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
});

afterEach(() => {
  panel.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WorldClockPanel 1 Hz tick', () => {
  it('renders a row per default city on first paint', () => {
    expect(container()).not.toBeNull();
    expect(rows().length).toBeGreaterThan(0);
    expect(timeTexts().every((s) => /^\d{2}:\d{2}:\d{2}$/.test(s))).toBe(true);
  });

  it('does NOT replace the container or the rows on a tick', () => {
    const beforeContainer = container();
    const beforeRows = rows();
    expect(beforeContainer).not.toBeNull();
    expect(beforeRows.length).toBeGreaterThan(0);

    tick(1000);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    // Same node instances, not merely equal markup.
    expect(container()).toBe(beforeContainer);
    const afterRows = rows();
    expect(afterRows.length).toBe(beforeRows.length);
    afterRows.forEach((row, i) => {
      expect(row).toBe(beforeRows[i]);
    });
  });

  it('still advances the displayed seconds on a tick', () => {
    const before = timeTexts();

    tick(1000);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const after = timeTexts();
    expect(after).not.toEqual(before);
    expect(after.every((s) => /^\d{2}:\d{2}:\d{2}$/.test(s))).toBe(true);
  });

  it('keeps node identity across many consecutive ticks', () => {
    const beforeRows = rows();

    for (let i = 0; i < 10; i++) {
      tick(1000);
    }
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const afterRows = rows();
    expect(afterRows.length).toBe(beforeRows.length);
    afterRows.forEach((row, i) => {
      expect(row).toBe(beforeRows[i]);
    });
    expect(timeTexts().every((s) => /^\d{2}:\d{2}:\d{2}$/.test(s))).toBe(true);
  });

  it('survives opening and closing settings inside the debounce window', () => {
    // The user-visible half of the Panel fast-path bug: open settings, close it
    // before the 150 ms debounce commits, and the settings markup could still
    // land afterwards — leaving the settings view on screen AND stranding the
    // cached row handles, so the clock stopped ticking for good.
    const settingsBtn = document.querySelector<HTMLButtonElement>('.wc-settings-btn');
    expect(settingsBtn).not.toBeNull();

    settingsBtn?.click();
    settingsBtn?.click();
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS * 3);

    expect(content().querySelector('.wc-settings-view')).toBeNull();
    expect(rows().length).toBeGreaterThan(0);

    // …and the clock is still live, not frozen against detached nodes.
    const before = timeTexts();
    tick(1000);
    expect(timeTexts()).not.toEqual(before);
  });

  it('refreshes the timezone abbreviation across a DST fall-back', () => {
    // America/New_York repeats 01:xx on 2026-11-01: 05:30Z is 01:30 EDT and
    // 06:30Z is 01:30 EST — same weekday, same hour, different zone. Caching the
    // abbreviation on an hour-granular key served the stale zone for that whole
    // repeated hour.
    panel.destroy();
    document.body.innerHTML = '';
    vi.setSystemTime(new Date('2026-11-01T05:30:00.000Z'));
    panel = new WorldClockPanel();
    document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    // A tick must run INSIDE the pre-fallback hour first, so the abbreviation
    // cache is actually populated with EDT. Without this the cache is still
    // empty at the crossing and would refresh either way — the assertion below
    // would pass against the stale-key bug it exists to catch.
    vi.advanceTimersByTime(1000);
    const zonesBefore = Array.from(content().querySelectorAll<HTMLElement>('.wc-tz > span'))
      .map((el) => el.textContent ?? '');
    expect(zonesBefore.some((z) => z.includes('EDT'))).toBe(true);

    // Cross the fall-back, then let one tick run.
    vi.setSystemTime(new Date('2026-11-01T06:30:00.000Z'));
    vi.advanceTimersByTime(1000);

    const zonesAfter = Array.from(content().querySelectorAll<HTMLElement>('.wc-tz > span'))
      .map((el) => el.textContent ?? '');
    expect(zonesAfter.some((z) => z.includes('EST'))).toBe(true);
    expect(zonesAfter.some((z) => z.includes('EDT'))).toBe(false);
  });

  it('stops ticking after destroy', () => {
    const before = timeTexts();
    panel.destroy();

    tick(5000);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    expect(timeTexts()).toEqual(before);
  });
});
