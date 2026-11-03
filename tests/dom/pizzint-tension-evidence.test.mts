import { expect, it, vi } from 'vitest';
import type { GdeltTensionPair, TensionEvidence } from '@/types';

// The popup's English copy, interpolated, so the test reads what a viewer reads.
vi.mock('@/services/i18n', async () => {
  const { readFileSync } = await import('node:fs');
  const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8'));
  const lookup = (key: string): unknown => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
  return {
    t: (key: string, params: Record<string, unknown> = {}) =>
      String(lookup(key) ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? '')),
    getCurrentLanguageTag: () => 'en',
  };
});

import { PizzIntIndicator } from '@/components/PizzIntIndicator';

const pair = (id: string, label: string, evidence?: TensionEvidence[]): GdeltTensionPair => ({
  id, countries: ['US', 'IR'], label, score: 40, trend: 'rising', changePercent: 8, region: 'middle_east',
  ...(evidence ? { evidence } : {}),
});
const reading = (fields: Partial<TensionEvidence> & Pick<TensionEvidence, 'channel' | 'value'>): TensionEvidence => ({
  baseline: null, countries: [], airports: [], ...fields,
});

function render(tensions: GdeltTensionPair[]) {
  const indicator = new PizzIntIndicator();
  indicator.updateTensions(tensions);
  const element = indicator.getElement();
  const rows = [...element.querySelectorAll('.pizzint-tension-row')];
  const evidenceUnder = (label: string) => {
    const row = rows.find(r => r.querySelector('.pizzint-tension-label')?.textContent === label);
    const next = row?.nextElementSibling;
    return next?.classList.contains('pizzint-tension-evidence') ? next.textContent : null;
  };
  return { element, evidenceUnder };
}

it('shows up to three notable readings in plain words under their pair', () => {
  const { evidenceUnder } = render([
    pair('usa_iran', 'US–Iran', [
      reading({ channel: 'airports', value: 2, airports: [
        { name: 'Tehran Imam Khomeini', status: 'closed' }, { name: 'Shiraz', status: 'restricted' },
      ] }),
      reading({ channel: 'military_aircraft', value: 9, baseline: 2.21, countries: ['US'] }),
      reading({ channel: 'sanctions', value: 4, baseline: 1, countries: ['IR'] }),
      reading({ channel: 'strikes', value: 30, baseline: 9, countries: ['IR'] }),
    ]),
    pair('saudi_arabia_yemen', 'Saudi Arabia–Yemen', [
      reading({ channel: 'strikes', value: 47, baseline: 12, countries: ['SA', 'YE'] }),
      reading({ channel: 'airports', value: 1, airports: [{ name: 'Riyadh', status: 'halted' }] }),
    ]),
    pair('china_taiwan', 'China–Taiwan', [
      reading({ channel: 'pla_aircraft', value: 31, baseline: 5 }),
      reading({ channel: 'pla_ships', value: 14, baseline: 7 }),
    ]),
    pair('iran_gcc', 'Iran–GCC', [
      reading({ channel: 'airports', value: 3, baseline: 1, airports: [
        { name: 'Doha', status: 'closed' }, { name: 'Dubai', status: 'closed' }, { name: 'Manama', status: 'restricted' },
      ] }),
    ]),
  ]);
  expect(evidenceUnder('US–Iran')).toBe(
    'Tehran Imam Khomeini airport closed, Shiraz: flights restricted'
    + ' · United States military aircraft in the region: 9 (usual 2.2)'
    + ' · New US sanctions on Iran this week: 4 (usual 1)',
  );
  expect(evidenceUnder('Saudi Arabia–Yemen')).toBe(
    'Reported strikes on Saudi Arabia, Yemen in 3 days: 47 (usual 12) · Riyadh: most flights cancelled',
  );
  expect(evidenceUnder('China–Taiwan')).toBe(
    'Chinese military aircraft near Taiwan: 31 (usual 5) · Chinese navy ships near Taiwan: 14 (usual 7)',
  );
  expect(evidenceUnder('Iran–GCC')).toBe('Airports disrupted: 3 (usual 1)');
});

it('adds no line to a pair without notable readings, or to a pair with no score', () => {
  const { element, evidenceUnder } = render([
    pair('usa_iran', 'US–Iran', []),
    pair('usa_russia', 'US–Russia'),
  ]);
  expect(evidenceUnder('US–Iran')).toBeNull();
  expect(evidenceUnder('US–Russia')).toBeNull();
  expect(evidenceUnder('China–Taiwan')).toBeNull();
  expect(element.querySelectorAll('.pizzint-tension-evidence')).toHaveLength(0);
  const missing = [...element.querySelectorAll('.pizzint-tension-row')]
    .find(r => r.querySelector('.pizzint-tension-label')?.textContent === 'China–Taiwan');
  expect(missing?.querySelector('.pizzint-tension-score')?.textContent).toBe('Insufficient data');
});
