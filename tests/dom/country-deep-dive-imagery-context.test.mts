import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });

afterEach(() => {
  document.getElementById('deep-dive-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document.getElementById('country-deep-dive-panel')?.remove();
});

function content(): string {
  return document.getElementById('deep-dive-content')?.textContent ?? '';
}

describe('Country deep-dive imagery change context', () => {
  it('does not carry one country\'s confirmed flags onto the next country', () => {
    const panel = new CountryDeepDivePanel();
    panel.show('Iran', 'IR', null, null);
    panel.updateImageryChange({
      watchedSiteCount: 6,
      confirmedSites: [{ siteId: 'nuclear-facility:natanz', name: 'Natanz', confirmedAt: Date.parse('2026-11-10T02:41:00Z') }],
    });
    expect(content()).toContain('Natanz (confirmed 2026-11-10)');

    panel.show('Italy', 'IT', null, null);
    panel.updateScore(null, null);
    expect(content()).toContain('Italy');
    expect(content()).not.toContain('Natanz');
    expect(content()).not.toContain('Satellite context only');
  });
});
