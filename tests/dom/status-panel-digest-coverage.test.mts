import { beforeAll, describe, expect, it } from 'vitest';

import { StatusPanel, type DigestCoverageSummary } from '@/components/StatusPanel';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

function coverage(state: DigestCoverageSummary['state']): DigestCoverageSummary {
  return {
    state,
    itemsServed: 12,
    publisherCount: 4,
    feedsCompleted: 7,
    feedsTotal: 8,
    categoriesCompleted: 3,
    categoriesTotal: 4,
    missingCategories: state === 'partial' ? ['tech'] : [],
  };
}

describe('StatusPanel digest coverage row', () => {
  it.each(['complete', 'partial', 'stale', 'unavailable'] as const)(
    'announces the %s state with visible text',
    (state) => {
      const panel = new StatusPanel();
      panel.updateDigestCoverage(coverage(state));

      const row = panel.getElement().querySelector<HTMLElement>('.digest-coverage-row');
      expect(row).not.toBeNull();
      expect(row?.getAttribute('role')).toBe('status');
      expect(row?.getAttribute('aria-live')).toBe('polite');
      expect(row?.getAttribute('aria-label')).toBe('Digest coverage status');
      expect(row?.textContent).toContain(`Digest coverage: ${state}`);
      expect(row?.textContent?.trim().length).toBeGreaterThan(`Digest coverage: ${state}`.length);
    },
  );
});
