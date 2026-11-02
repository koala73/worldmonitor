import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RegulationPanel } from '@/components/RegulationPanel';
import { AI_REGULATIONS, REGULATORY_ACTIONS } from '@/config/ai-regulations';
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

function mount(view: 'timeline' | 'deadlines' | 'regulations' | 'countries'): { panel: RegulationPanel; content: HTMLElement } {
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
    freezeClock('2028-01-01T12:00:00Z');
    const { panel, content } = mount('timeline');

    expect(content.querySelector('.empty-state')).toBeNull();
    expect(text(content.querySelector('.regulation-note'))).toBe('No recent regulatory actions');
    expect(text(content.querySelector('h4'))).toBe('Latest Recorded Actions');
    expect(text(content)).not.toContain('Last 12 Months');

    const dates = [...content.querySelectorAll('.timeline-item .timeline-date')].map(text);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates[0]).toBe('Aug 2, 2026');
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
    expect(dates).toEqual(['Jan 14, 2025', 'Jan 13, 2025', 'Aug 1, 2024', 'Jul 26, 2024']);
    panel.destroy();
  });

  it('shows the last 12 months on 2026-11-02, newest first, each with a linked source', () => {
    freezeClock('2026-11-02T12:00:00Z');
    const { panel, content } = mount('timeline');

    expect(content.querySelector('.regulation-note')).toBeNull();
    expect(text(content.querySelector('h4'))).toBe('Recent Regulatory Actions (Last 12 Months)');
    const items = [...content.querySelectorAll('.timeline-item')];
    expect(text(items[0]?.querySelector('.timeline-date'))).toBe('Aug 2, 2026');
    expect(text(items[items.length - 1]?.querySelector('.timeline-date'))).toBe('Nov 5, 2025');
    for (const item of items) {
      expect(item.querySelector<HTMLAnchorElement>('.timeline-source a')?.href).toMatch(/^https:\/\//);
    }
    panel.destroy();
  });
});

describe.each(TIMEZONES)('RegulationPanel Deadlines tab in %s', (tz) => {
  beforeEach(() => {
    process.env.TZ = tz;
  });

  it('says no deadline is due in the next 12 months and still lists the latest passed one', () => {
    freezeClock('2029-01-01T12:00:00Z');
    const { panel, content } = mount('deadlines');

    expect(content.querySelector('.empty-state')).toBeNull();
    expect(text(content.querySelector('.regulation-note'))).toBe('No upcoming compliance deadlines in the next 12 months');
    expect(text(content.querySelector('h4'))).toBe('Other Compliance Deadlines');

    const item = content.querySelector('.deadline-item');
    expect(item).not.toBeNull();
    expect(item!.classList.contains('passed')).toBe(true);
    expect(text(item!.querySelector('h5'))).toBe('EU AI Act');
    expect(text(item!.querySelector('.deadline-name'))).toBe('High-risk AI rules apply to Annex I product systems (Article 6(1))');
    expect(text(item!.querySelector('.deadline-date'))).toContain('August 2, 2028');
    expect(text(item!.querySelector('.days-until'))).toBe('152');
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
    expect(text(item!.querySelector('h5'))).toBe('California SB 53');
    expect(text(item!.querySelector('.days-until'))).toBe('122');
    expect(text(item!.querySelector('.days-label'))).toBe('days');
    panel.destroy();
  });

  it('keeps a deadline upcoming through its whole calendar day', () => {
    // 03:00 UTC on Aug 2 is the evening of Aug 1 in Los Angeles.
    freezeClock('2026-08-02T03:00:00Z');
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
    freezeClock('2023-06-01T12:00:00Z');
    const { panel, content } = mount('deadlines');

    expect(content.querySelector('.empty-state')).toBeNull();
    expect(text(content.querySelector('.regulation-note'))).toBe('No upcoming compliance deadlines in the next 12 months');
    const item = content.querySelector('.deadline-item');
    expect(item!.classList.contains('passed')).toBe(false);
    expect(text(item!.querySelector('h5'))).toBe('EU AI Act');
    expect(text(item!.querySelector('.days-label'))).toBe('days');
    panel.destroy();
  });

  it('counts down to the EU AI Act staged dates on 2026-11-02 and lists the later high-risk dates', () => {
    freezeClock('2026-11-02T12:00:00Z');
    const { panel, content } = mount('deadlines');

    expect(content.querySelector('.regulation-note')).toBeNull();
    const [upcoming, later] = [...content.querySelectorAll('.deadlines-list')];
    const headings = [...content.querySelectorAll('h4')].map(text);
    expect(headings).toEqual(['Upcoming Compliance Deadlines', 'Other Compliance Deadlines']);

    const first = upcoming!.querySelector('.deadline-item');
    expect(text(first?.querySelector('h5'))).toBe('EU AI Act');
    expect(text(first?.querySelector('.deadline-date'))).toContain('December 2, 2026');
    expect(text(first?.querySelector('.days-until'))).toBe('30');
    expect(first?.querySelector<HTMLAnchorElement>('.deadline-source a')?.href).toBe('https://eur-lex.europa.eu/eli/reg/2026/1744/oj/eng');

    const laterRows = [...later!.querySelectorAll('.deadline-item')].map((item) => ({
      date: text(item.querySelector('.deadline-date')),
      label: text(item.querySelector('.deadline-name')),
    }));
    expect(laterRows).toEqual([
      { date: '📅 December 2, 2027', label: 'High-risk AI rules apply to Annex III systems (Article 6(2))' },
      { date: '📅 August 2, 2028', label: 'High-risk AI rules apply to Annex I product systems (Article 6(1))' },
    ]);
    for (const item of content.querySelectorAll('.deadline-item')) {
      expect(item.classList.contains('passed')).toBe(false);
    }
    panel.destroy();
  });
});

describe('AI regulation dataset', () => {
  // The Timeline lists these as recorded actions. Enforcement under a
  // regulation cannot predate the date that regulation took effect, so an
  // entry that does is a forecast presented as fact.
  it('dates no enforcement action before its regulation took effect', () => {
    const early = REGULATORY_ACTIONS
      .filter((action) => action.type === 'enforcement' && action.regulationId)
      .filter((action) => {
        const effective = AI_REGULATIONS.find((reg) => reg.id === action.regulationId)?.effectiveDate;
        return effective !== undefined && action.date < effective;
      })
      .map((action) => `${action.id} ${action.date}`);
    expect(early).toEqual([]);
  });
});

describe('RegulationPanel Regulations and Countries tabs', () => {
  it('lists the revoked US AI executive order under Revoked, not Active', () => {
    const { panel, content } = mount('regulations');
    const sections = [...content.querySelectorAll('.regulations-section')].map((section) => ({
      heading: text(section.querySelector('h4')),
      cards: [...section.querySelectorAll('.regulation-card h5')].map(text),
    }));

    const active = sections.find((s) => s.heading.startsWith('Active Regulations'));
    const revoked = sections.find((s) => s.heading.startsWith('Revoked Regulations'));
    expect(active?.cards).not.toContain('Biden AI EO');
    expect(revoked).toEqual({ heading: 'Revoked Regulations (1)', cards: ['Biden AI EO'] });
    panel.destroy();
  });

  it('lists Canada\'s AIDA under Lapsed, not Proposed', () => {
    const { panel, content } = mount('regulations');
    const sections = [...content.querySelectorAll('.regulations-section')].map((section) => ({
      heading: text(section.querySelector('h4')),
      cards: [...section.querySelectorAll('.regulation-card h5')].map(text),
    }));

    const proposed = sections.find((s) => s.heading.startsWith('Proposed Regulations'));
    const lapsed = sections.find((s) => s.heading.startsWith('Lapsed Proposals'));
    expect(proposed?.cards).not.toContain('AIDA');
    expect(lapsed).toEqual({ heading: 'Lapsed Proposals (1)', cards: ['AIDA'] });
    panel.destroy();
  });

  it('counts three active regulations for the United States', () => {
    const { panel, content } = mount('countries');
    const us = [...content.querySelectorAll('.country-card')].find((card) => text(card.querySelector('h5')) === 'United States');
    expect(text(us?.querySelector('.country-stats .stat .stat-value'))).toBe('3');
    panel.destroy();
  });
});
