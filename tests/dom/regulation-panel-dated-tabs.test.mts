import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RegulationPanel } from '@/components/RegulationPanel';
import { initTestI18n } from './helpers/i18n.mts';

// The Timeline and Deadlines tabs filter a static dataset against the clock.
// Once the newest entry aged out of the window, both tabs read as empty.
// Date is frozen outright: re-reading a stubbed Date.now() races day bounds.
// Dataset dates are calendar days, so every case runs west and east of UTC:
// parsed as UTC midnight and formatted locally, Aug 1 read as Jul 31 in the US.
const ORIGINAL_TZ = process.env.TZ;
const TIMEZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'];

function freezeClock(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

function mount(view: 'timeline' | 'deadlines'): { panel: RegulationPanel; content: HTMLElement } {
  const panel = new RegulationPanel('ai-regulation');
  const root = panel.getElement();
  document.body.appendChild(root);
  panel.setView(view);
  return { panel, content: root.querySelector<HTMLElement>('.regulation-content')! };
}

const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe.each(TIMEZONES)('RegulationPanel Timeline tab in %s', (tz) => {
  beforeEach(() => {
    process.env.TZ = tz;
  });

  it('lists the latest recorded actions, newest first, when none fall in the last 12 months', () => {
    freezeClock('2026-11-02T12:00:00Z');
    const { panel, content } = mount('timeline');

    expect(content.querySelector('.empty-state')).toBeNull();
    expect(text(content.querySelector('.regulation-note'))).toBe('No recent regulatory actions');
    expect(text(content.querySelector('h4'))).toBe('Latest Recorded Actions');
    expect(text(content)).not.toContain('Last 12 Months');

    const dates = [...content.querySelectorAll('.timeline-item .timeline-date')].map(text);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates[0]).toBe('Jan 14, 2025');
    const times = dates.map((d) => new Date(d).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    panel.destroy();
  });

  it('keeps the 12-month window and its heading while actions fall inside it', () => {
    freezeClock('2025-01-15T12:00:00Z');
    const { panel, content } = mount('timeline');

    expect(content.querySelector('.regulation-note')).toBeNull();
    expect(text(content.querySelector('h4'))).toBe('Recent Regulatory Actions (Last 12 Months)');
    const dates = [...content.querySelectorAll('.timeline-item .timeline-date')].map(text);
    expect(dates).toEqual(['Jan 14, 2025', 'Aug 1, 2024', 'Jul 1, 2024', 'May 15, 2024']);
    panel.destroy();
  });
});

describe.each(TIMEZONES)('RegulationPanel Deadlines tab in %s', (tz) => {
  beforeEach(() => {
    process.env.TZ = tz;
  });

  it('says no deadline is due in the next 12 months and still lists the latest passed one', () => {
    freezeClock('2026-11-02T12:00:00Z');
    const { panel, content } = mount('deadlines');

    expect(content.querySelector('.empty-state')).toBeNull();
    expect(text(content.querySelector('.regulation-note'))).toBe('No upcoming compliance deadlines in the next 12 months');
    expect(text(content.querySelector('h4'))).toBe('Other Compliance Deadlines');

    const item = content.querySelector('.deadline-item');
    expect(item).not.toBeNull();
    expect(item!.classList.contains('passed')).toBe(true);
    expect(text(item!.querySelector('h5'))).toBe('EU AI Act');
    expect(text(item!.querySelector('.deadline-date'))).toContain('August 1, 2026');
    expect(text(item!.querySelector('.days-until'))).toBe('93');
    expect(text(item!.querySelector('.days-label'))).toBe('days ago');
    expect(text(content)).not.toMatch(/-\d/);
    panel.destroy();
  });

  it('counts down to a deadline inside the next 12 months', () => {
    freezeClock('2025-09-01T12:00:00Z');
    const { panel, content } = mount('deadlines');

    expect(content.querySelector('.regulation-note')).toBeNull();
    expect(text(content.querySelector('h4'))).toBe('Upcoming Compliance Deadlines');
    const item = content.querySelector('.deadline-item');
    expect(item!.classList.contains('passed')).toBe(false);
    expect(text(item!.querySelector('h5'))).toBe('EU AI Act');
    expect(text(item!.querySelector('.days-until'))).toBe('334');
    expect(text(item!.querySelector('.days-label'))).toBe('days');
    panel.destroy();
  });

  it('keeps a deadline upcoming through its whole calendar day', () => {
    // 03:00 UTC on Aug 1 is the evening of Jul 31 in Los Angeles.
    freezeClock('2026-08-01T03:00:00Z');
    const { panel, content } = mount('deadlines');

    const item = content.querySelector('.deadline-item');
    const expected = tz === 'America/Los_Angeles' ? '1' : '0';
    expect(text(content.querySelector('h4'))).toBe('Upcoming Compliance Deadlines');
    expect(item!.classList.contains('passed')).toBe(false);
    expect(text(item!.querySelector('.days-until'))).toBe(expected);
    expect(text(item!.querySelector('.days-label'))).toBe('days');
    panel.destroy();
  });

  it('lists a deadline more than 12 months out instead of an empty tab', () => {
    freezeClock('2025-01-15T12:00:00Z');
    const { panel, content } = mount('deadlines');

    expect(content.querySelector('.empty-state')).toBeNull();
    expect(text(content.querySelector('.regulation-note'))).toBe('No upcoming compliance deadlines in the next 12 months');
    const item = content.querySelector('.deadline-item');
    expect(item!.classList.contains('passed')).toBe(false);
    expect(text(item!.querySelector('h5'))).toBe('EU AI Act');
    expect(text(item!.querySelector('.days-label'))).toBe('days');
    panel.destroy();
  });
});
