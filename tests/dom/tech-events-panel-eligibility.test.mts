import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const hydrated = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@/components/Panel', () => ({ Panel: class {
  element = document.createElement('div');
  content = document.body.appendChild(document.createElement('div'));
  setCount() {}
  showError(message: string) { this.content.textContent = `error:${message}`; }
  setContentNodes(...nodes: Node[]) { this.content.replaceChildren(...nodes); }
} }));
vi.mock('@/services/i18n', () => ({
  t: (key: string, params?: { count?: string }) => (params?.count ? `${key}:${params.count}` : key),
}));
vi.mock('@/services/bootstrap', () => ({ getHydratedData: () => hydrated.value }));
import { TechEventsPanel } from '@/components/TechEventsPanel';

const event = (id: string, type: string, startDate: string, endDate: string) => ({
  id, title: id, type, location: '', startDate, endDate, url: '', source: 'test', description: '',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 25, 4, 0, 0));
  hydrated.value = {
    success: true,
    conferenceCount: 3,
    events: [
      event('Finished Summit', 'conference', '2026-11-20', '2026-11-21'),
      event('Earnings: ENDED', 'earnings', '2026-11-24', '2026-11-24'),
      event('Ongoing Expo', 'conference', '2026-11-24', '2026-11-26'),
      event('Earnings: DELL, HPQ, Xiaomi', 'earnings', '2026-11-25', '2026-11-25'),
      event('NET Conf Online 2026', 'conference', '2026-11-25', '2026-11-25'),
      event('Vex House: Muscat Night', 'conference', '2026-11-27', '2026-11-27'),
    ],
  };
  document.body.replaceChildren();
});

afterEach(() => vi.useRealTimers());

const listedTitles = () =>
  [...document.querySelectorAll('.tech-events-list .event-title')].map(el => el.textContent);

it('keeps events happening today and ongoing events in Upcoming', () => {
  new TechEventsPanel('events');
  expect(listedTitles()).toEqual(['Ongoing Expo', 'Earnings: DELL, HPQ, Xiaomi', 'NET Conf Online 2026', 'Vex House: Muscat Night']);
  expect(document.querySelector('.tech-events-stats')?.textContent).toContain('components.techEvents.conferencesCount:3');
});

it('keeps earnings happening today in Earnings and drops ones that ended yesterday', () => {
  new TechEventsPanel('events');
  document.querySelector<HTMLButtonElement>('.panel-tab[data-view="earnings"]')!.click();
  expect(listedTitles()).toEqual(['Earnings: DELL, HPQ, Xiaomi']);
});

it('shows date-only events on their calendar day west of UTC', () => {
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    vi.setSystemTime(new Date(2026, 10, 25, 12, 0, 0));
    new TechEventsPanel('events');
    const dates = [...document.querySelectorAll('.tech-events-list .event-dates')].map(el => el.textContent);
    expect(dates).toEqual(['Nov 24 - Nov 26', 'Nov 25', 'Nov 25', 'Nov 27']);
  } finally {
    process.env.TZ = originalTz;
  }
});
