import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { StatusPanel, type DigestCoverageSummary } from '@/components/StatusPanel';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.innerHTML = '';
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

describe('StatusPanel digest coverage row reachability (#7085 reopen)', () => {
  // The component-scoped queries above cannot distinguish a mounted row from a
  // detached one — these assertions must start at `document`, because that is
  // the only starting point that fails when nothing mounts the panel element.
  it('mounts the coverage row into the site footer so it is reachable from document', () => {
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    document.body.appendChild(footer);

    const panel = new StatusPanel();
    panel.updateDigestCoverage(coverage('partial'));

    const row = document.querySelector<HTMLElement>('.digest-coverage-row');
    expect(row).not.toBeNull();
    expect(row?.isConnected).toBe(true);
    expect(row?.closest('.site-footer')).not.toBeNull();
    expect(row?.textContent).toContain('Digest coverage: partial');
  });

  it('does not double-mount across repeated coverage updates', () => {
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    document.body.appendChild(footer);

    const panel = new StatusPanel();
    panel.updateDigestCoverage(coverage('partial'));
    panel.updateDigestCoverage(coverage('complete'));

    expect(document.querySelectorAll('.status-panel-container')).toHaveLength(1);
    expect(document.querySelectorAll('.digest-coverage-row')).toHaveLength(1);
    expect(document.querySelector('.digest-coverage-row')?.textContent).toContain('Digest coverage: complete');
  });

  it('still updates the row without crashing when no site footer exists', () => {
    const panel = new StatusPanel();
    panel.updateDigestCoverage(coverage('stale'));

    expect(document.querySelector('.digest-coverage-row')).toBeNull();
    expect(panel.getElement().querySelector('.digest-coverage-row')?.textContent).toContain('Digest coverage: stale');
  });
});
