/**
 * #10713 unit 2: a dated event's popup opens the before and after around the
 * event date for Pro, shows the Pro entry point to everyone else, and searches
 * the public archives from the browser only when asked.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
import type { EventPair } from '@/services/orbital/event-imagery';
import type { MatchedAcquisition } from '@/services/orbital/match';
import type { ImageryTarget, ObjectImagery } from '@/services/orbital/object-imagery';

vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));
vi.mock('@/services/orbital/archive-image', () => ({ loadArchiveImage: vi.fn(() => new Promise(() => {})) }));

import { eventTimeFor, mountImageryRow, renderImageryRow, type EventCompareHooks } from '@/components/map-popup-imagery';

const NOW = Date.UTC(2026, 10, 15, 12);
const DAY = 86_400_000;
const target: ImageryTarget = { kind: 'point', point: { lat: 35.69, lon: 51.39 } };
const imagery: ObjectImagery = { latest: null, nextPass: null };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function scene(daysAgo: number): MatchedAcquisition {
  const startMs = NOW - daysAgo * DAY;
  return {
    key: `sentinel-2c:1:${startMs}`, profileId: 'sentinel-2', platform: 'sentinel-2c', orbit: 1, startMs, endMs: startMs + 5_000, items: [],
    pass: null, condition: 'clear', cloudCoverPct: 2, sunElevationDeg: 40, resolutionM: 10, imageUrl: null,
  };
}

function mount(eventCompare?: EventCompareHooks) {
  const holder = document.createElement('div');
  holder.innerHTML = renderImageryRow();
  const row = holder.firstElementChild as HTMLElement;
  document.body.appendChild(row);
  const dispose = mountImageryRow(row, target, { onOpenEvidence: vi.fn(), onLayout: vi.fn(), load: async () => imagery, now: () => NOW, eventCompare });
  return { row, dispose };
}

beforeAll(async () => {
  await initTestI18n();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('eventTimeFor', () => {
  it('reads the date of conflict events, wildfires and satellite fire detections', () => {
    expect(eventTimeFor('iranEvent', { latitude: 35.69, longitude: 51.39, timestamp: '2026-11-10T08:00:00Z' })).toBe(Date.UTC(2026, 10, 10, 8));
    expect(eventTimeFor('iranEvent', { latitude: 35.69, longitude: 51.39, timestamp: NOW })).toBe(NOW);
    expect(eventTimeFor('natEvent', { category: 'wildfires', lat: 38, lon: -120, date: new Date(NOW) })).toBe(NOW);
    const fire = { lat: 38, lon: -120, brightness: 330, frp: 12, confidence: 95, region: 'US', acq_date: '2026-11-12', daynight: 'D', satellite: 'N20' };
    expect(eventTimeFor('fireDetection', { ...fire, detected_at: NOW - DAY })).toBe(NOW - DAY);
  });

  it('gives no date to sites, undated events, or popups without an imagery row', () => {
    expect(eventTimeFor('base', { id: 'b', lat: 1, lon: 2 })).toBeNull();
    expect(eventTimeFor('iranEvent', { latitude: 35.69, longitude: 51.39, timestamp: 'not a date' })).toBeNull();
    expect(eventTimeFor('natEvent', { category: 'volcanoes', lat: 1, lon: 2, date: new Date(NOW) })).toBeNull();
    expect(eventTimeFor('outage', { lat: 1, lon: 2, pubDate: new Date(NOW) })).toBeNull();
    expect(eventTimeFor('news', { lat: 1, lon: 2, pubDate: new Date(NOW) })).toBeNull();
  });
});

describe('before and after in the imagery row', () => {
  it('shows no compare action for an object without an event date', async () => {
    const { row } = mount();
    await flush();
    expect(row.querySelector('[data-orbital-event-compare]')).toBeNull();
    expect(row.querySelector('[data-orbital-event-compare-locked]')).toBeNull();
  });

  it('shows the Pro entry point instead of searching when the user is not Pro', async () => {
    const findPair = vi.fn();
    const { row } = mount({ eventMs: NOW - 3 * DAY, access: 'locked', onOpen: vi.fn(), findPair });
    await flush();
    const link = row.querySelector<HTMLAnchorElement>('[data-orbital-event-compare-locked]')!;
    expect(link.textContent).toBe('Before / after · Pro');
    expect(link.getAttribute('href')).toBe('/pro#pricing');
    expect(row.querySelector('[data-orbital-event-compare]')).toBeNull();
    expect(findPair).not.toHaveBeenCalled();
  });

  it('searches around the event only on click, then hands the pair to the viewer', async () => {
    const eventMs = NOW - 3 * DAY;
    const pair: EventPair = { status: 'ok', profileId: 'sentinel-2', windowEndMs: NOW, scenes: [scene(1), scene(5)], before: scene(5), after: scene(1) };
    let answer!: (pair: EventPair) => void;
    const findPair = vi.fn(() => new Promise<EventPair>((resolve) => { answer = resolve; }));
    const onOpen = vi.fn();
    const { row } = mount({ eventMs, access: 'open', onOpen, findPair });
    await flush();
    expect(findPair).not.toHaveBeenCalled();

    const button = row.querySelector<HTMLButtonElement>('[data-orbital-event-compare]')!;
    button.click();
    expect(findPair).toHaveBeenCalledWith(target.point, eventMs, NOW, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(button.disabled).toBe(true);
    expect(row.querySelector('[data-orbital-event-status]')!.textContent).toBe('Searching scenes either side of Nov 12, 2026…');

    answer(pair);
    await flush();
    expect(onOpen).toHaveBeenCalledWith(target, eventMs, pair);
    expect(row.querySelector<HTMLElement>('[data-orbital-event-status]')!.hidden).toBe(true);
  });

  it('says in place which side of the event has no clear scene', async () => {
    const onOpen = vi.fn();
    const { row } = mount({ eventMs: NOW - DAY, access: 'open', onOpen, findPair: async () => ({ status: 'none', missing: 'after' }) });
    await flush();
    row.querySelector<HTMLButtonElement>('[data-orbital-event-compare]')!.click();
    await flush();
    expect(row.querySelector('[data-orbital-event-status]')!.textContent).toBe('No clear scene since Nov 14, 2026 yet.');
    expect(row.querySelector<HTMLButtonElement>('[data-orbital-event-compare]')!.disabled).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('stops the search and opens nothing once the popup closes', async () => {
    let seen: AbortSignal | undefined;
    let answer!: (pair: EventPair) => void;
    const onOpen = vi.fn();
    const { row, dispose } = mount({
      eventMs: NOW - DAY, access: 'open', onOpen,
      findPair: (_point, _eventMs, _now, options) => { seen = options?.signal; return new Promise<EventPair>((resolve) => { answer = resolve; }); },
    });
    await flush();
    row.querySelector<HTMLButtonElement>('[data-orbital-event-compare]')!.click();
    dispose();
    expect(seen?.aborted).toBe(true);
    answer({ status: 'ok', profileId: 'sentinel-2', windowEndMs: NOW, scenes: [], before: scene(5), after: scene(1) });
    await flush();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
