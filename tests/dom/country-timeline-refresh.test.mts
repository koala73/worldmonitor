import { describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';
import type { CountryCoverageEvent } from '@/services/country-coverage';
import { CountryTimeline } from '@/components/CountryTimeline';

describe('country timeline refresh', () => {
  it.each(['resize', 'theme'] as const)('renders empty lanes after a hidden timeline becomes visible on %s', (trigger) => {
    let notifyResize: ResizeObserverCallback = () => {};
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { notifyResize = callback; }
      observe() {}
      disconnect() {}
    });
    const mount = document.createElement('div');
    mount.hidden = true;
    Object.defineProperty(mount, 'clientWidth', { get: () => mount.hidden ? 0 : 900 });
    const provenance = document.createElement('p');
    provenance.textContent = 'Controlled source state: unknown';
    mount.append(provenance);
    document.body.append(mount);
    const timeline = new CountryTimeline(mount);
    try {
      mount.hidden = false;
      notifyResize([], {} as ResizeObserver);
      window.dispatchEvent(new Event('theme-changed'));
      expect(mount.querySelector('svg')).toBeNull();
      mount.hidden = true;
      timeline.render([]);
      expect(mount.querySelector('svg')).toBeNull();
      mount.hidden = false;
      if (trigger === 'resize') notifyResize([], {} as ResizeObserver);
      else window.dispatchEvent(new Event('theme-changed'));
      expect([...mount.querySelectorAll('.lane-label')].map(label => label.textContent))
        .toEqual(['Protest', 'Conflict', 'Natural', 'Military']);
      expect(mount.querySelectorAll('.empty-label')).toHaveLength(4);
      expect(mount.querySelectorAll('.event-circle')).toHaveLength(0);
      expect(mount.querySelectorAll('svg')).toHaveLength(1);
      expect(provenance.textContent).toBe('Controlled source state: unknown');
      expect(mount.contains(provenance)).toBe(true);
    } finally {
      timeline.destroy();
      mount.remove();
      vi.unstubAllGlobals();
    }
  });

  it('renders country events that arrive after the brief opens', () => {
    const mount = document.createElement('div');
    Object.defineProperty(mount, 'clientWidth', { value: 900 });
    document.body.append(mount);
    const countryBriefPage = {
      isVisible: () => true,
      getCode: () => 'FR',
      getName: () => 'France',
      getTimelineMount: () => mount,
    };
    const ctx = {
      countryBriefPage,
      countryTimeline: null,
      intelligenceCache: {
        protests: {
          events: [{
            id: 'fr-protest-1',
            title: 'National protest in France',
            eventType: 'protest',
            country: 'France',
            lat: 48.8566,
            lon: 2.3522,
            time: new Date(),
            severity: 'medium',
            sources: ['test'],
            sourceType: 'rss',
            confidence: 'high',
            validated: true,
          }],
        },
      },
    } as unknown as AppContext;

    const manager = new CountryIntelManager(ctx);
    manager.refreshOpenTimeline();

    expect(mount.querySelectorAll('circle')).toHaveLength(1);
  });

  it('does not let an expired structured event suppress visible coverage', () => {
    const mount = document.createElement('div');
    Object.defineProperty(mount, 'clientWidth', { value: 900 });
    document.body.append(mount);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const matchingLabel = 'National protest in France';
    const ctx = {
      countryBriefPage: {
        getTimelineMount: () => mount,
      },
      countryTimeline: null,
      intelligenceCache: {
        protests: {
          events: [{
            id: 'expired-fr-protest',
            title: matchingLabel,
            eventType: 'protest',
            country: 'France',
            lat: 48.8566,
            lon: 2.3522,
            time: new Date(sevenDaysAgo - 60 * 60 * 1000),
            severity: 'medium',
            sources: ['test'],
            sourceType: 'rss',
            confidence: 'high',
            validated: true,
          }],
        },
      },
    } as unknown as AppContext;
    const coverageEvents: CountryCoverageEvent[] = [{
      timestamp: sevenDaysAgo + 60 * 60 * 1000,
      lane: 'protest',
      label: matchingLabel,
      severity: 'medium',
    }];

    const manager = new CountryIntelManager(ctx);
    const mountTimeline = Reflect.get(manager, 'mountCountryTimeline') as (
      code: string,
      country: string,
      events: CountryCoverageEvent[],
    ) => void;
    mountTimeline.call(manager, 'FR', 'France', coverageEvents);

    expect(mount.querySelectorAll('circle')).toHaveLength(1);
  });
});
