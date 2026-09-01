import { describe, expect, it } from 'vitest';

import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';

describe('country timeline refresh', () => {
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
});
