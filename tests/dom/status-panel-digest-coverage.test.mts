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
    itemsConsidered: 0,
    publishersConsidered: 0,
    staleCause: state === 'stale' ? 'server' : null,
    staleReason: state === 'stale' ? 'build-error' : '',
    contentAgeSeconds: state === 'stale' ? 1800 : null,
  };
}

function row(summary: DigestCoverageSummary): HTMLElement | null {
  const panel = new StatusPanel();
  panel.updateDigestCoverage(summary);
  return panel.getElement().querySelector<HTMLElement>('.digest-coverage-row');
}

function rowText(summary: DigestCoverageSummary): string {
  return row(summary)?.textContent ?? '';
}

/** The explanation lives only in the tooltip, never in the visible footer. */
function rowTitle(summary: DigestCoverageSummary): string {
  return row(summary)?.title ?? '';
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
      expect(row?.getAttribute('aria-label')).toBe('News coverage status');
      expect(row?.textContent).toContain(`News coverage: ${state}`);
    },
  );

  it.each(['complete', 'partial', 'stale', 'unavailable'] as const)(
    'keeps the %s explanation out of the visible footer text',
    (state) => {
      const text = rowText(coverage(state));
      for (const phrase of ['every configured category', 'some categories had no completed feed', 'rebuild', 'no news content', 'did not report']) {
        expect(text).not.toContain(phrase);
      }
      expect(text.trim().endsWith(')')).toBe(state === 'partial');
    },
  );
});

describe('StatusPanel digest coverage row truncation (#10499)', () => {
  // The compact footer ellipsizes this row on one 28px line, so the full text
  // (missing categories) plus the explanation stays reachable as a tooltip.
  it.each(['complete', 'partial', 'stale', 'unavailable'] as const)(
    'exposes the full %s text and its explanation as the row title',
    (state) => {
      const el = row(coverage(state));
      expect(el?.title.startsWith(el?.textContent ?? '')).toBe(true);
      expect(el?.title.length).toBeGreaterThan(el?.textContent?.length ?? 0);
      expect(el?.title).toContain(`News coverage: ${state}`);
    },
  );

  it('keeps the title in step with later updates', () => {
    const panel = new StatusPanel();
    panel.updateDigestCoverage(coverage('complete'));
    panel.updateDigestCoverage(coverage('partial'));
    const row = panel.getElement().querySelector<HTMLElement>('.digest-coverage-row');
    expect(row?.title).toContain('News coverage: partial');
    expect(row?.title).toContain('tech');
  });
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
    expect(row?.textContent).toContain('News coverage: partial');
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
    expect(document.querySelector('.digest-coverage-row')?.textContent).toContain('News coverage: complete');
  });

  it('still updates the row without crashing when no site footer exists', () => {
    const panel = new StatusPanel();
    panel.updateDigestCoverage(coverage('stale'));

    expect(document.querySelector('.digest-coverage-row')).toBeNull();
    expect(panel.getElement().querySelector('.digest-coverage-row')?.textContent).toContain('News coverage: stale');
  });
});

describe('StatusPanel digest coverage breadth and stale cause', () => {
  // Prod 2026-11-07 full:en: 1,269 stories from 274 sources ranked, 333 shown
  // (20 per category). The row used to report only the 333-item slice.
  it('reports the publishers and stories the build reviewed, not just the served slice', () => {
    const text = rowText({
      ...coverage('complete'),
      itemsServed: 333,
      publisherCount: 136,
      itemsConsidered: 1269,
      publishersConsidered: 251,
    });
    expect(text).toContain('251 publishers, 1,269 stories reviewed, top 333 shown');
    expect(text).not.toContain('136 publishers');
  });

  it('falls back to served counts when the digest predates the considered fields', () => {
    const text = rowText({ ...coverage('complete'), itemsServed: 333, publisherCount: 136 });
    expect(text).toContain('136 publishers, 333 stories');
    expect(text).not.toContain('reviewed');
  });

  it('blames the server rebuild only when the server replayed old content', () => {
    const text = rowTitle(coverage('stale'));
    expect(text).toContain('from 30 min ago');
    expect(text).toContain('latest rebuild failed');
  });

  it('says the copy is from this device when the browser could not reach the service', () => {
    const text = rowTitle({ ...coverage('stale'), staleCause: 'device', contentAgeSeconds: 7200 });
    expect(text).toContain('saved on this device');
    expect(text).toContain('from 2 h ago');
    expect(text).not.toContain('rebuild');
  });

  it('does not call a rebuild the gate refused a failure', () => {
    const text = rowTitle({ ...coverage('stale'), staleReason: 'gate-held' });
    expect(text).toContain('held back by a quality check');
    expect(text).not.toContain('failed');
  });

  it('names an empty rebuild as empty', () => {
    const text = rowTitle({ ...coverage('stale'), staleReason: 'empty-rebuild' });
    expect(text).toContain('latest rebuild came back empty');
  });

  it('does not blame the service while a language switch is loading', () => {
    const text = rowTitle({ ...coverage('stale'), staleCause: 'switching', contentAgeSeconds: 600 });
    expect(text).toContain('saved on this device');
    expect(text).toContain('while this language loads');
    expect(text).not.toContain('did not respond');
  });

  it('omits the age when it is unknown', () => {
    const text = rowTitle({ ...coverage('stale'), staleCause: 'device', contentAgeSeconds: null });
    expect(text).toContain('saved on this device');
    expect(text).not.toContain('ago');
  });
});

describe('StatusPanel digest coverage row when the build ran out of time', () => {
  // Prod 2026-11-18 full:en footer: "partial … feeds 932/955, categories 18/18
  // (some categories had no completed feed in this cycle)". With every category
  // covered the server's partial comes from the build deadline alone, and the
  // row claimed a missing category that did not exist.
  const deadlineOnly = (): DigestCoverageSummary => ({
    ...coverage('partial'),
    feedsCompleted: 932,
    feedsTotal: 955,
    categoriesCompleted: 18,
    categoriesTotal: 18,
    missingCategories: [],
  });

  it('does not call the cycle partial when every category was covered', () => {
    const text = rowText(deadlineOnly());
    expect(text).toContain('News coverage: complete');
    expect(text).not.toContain('partial');
  });

  it('shows only the counts in the footer and the reason in the tooltip', () => {
    const summary = deadlineOnly();
    expect(rowText(summary)).toBe(
      'News coverage: complete — 4 publishers, 12 stories, feeds 932/955, categories 18/18',
    );
    expect(rowTitle(summary)).toContain('23 feeds did not complete');
    // The count also holds feeds that errored before the deadline.
    expect(rowTitle(summary)).not.toContain('in time');
  });

  // Prod 2026-11-18: "partial — 142 publishers, 593 stories reviewed, top 330
  // shown, feeds 137/955, categories 18/18". Most feeds never finished, so
  // the row must not call that complete.
  it('keeps partial when most feeds did not complete', () => {
    const text = rowText({ ...deadlineOnly(), feedsCompleted: 137 });
    expect(text).toContain('News coverage: partial');
    expect(text).toContain('feeds 137/955, categories 18/18');
    expect(text).not.toContain('(');
  });

  it('keeps partial when a category is actually missing', () => {
    const summary = { ...deadlineOnly(), categoriesCompleted: 17, missingCategories: ['tech'] };
    const text = rowText(summary);
    expect(text).toContain('News coverage: partial');
    expect(text).toContain('no completed feed: tech');
    expect(text).not.toContain('some categories had no completed feed');
    expect(rowTitle(summary)).toMatch(/some categories had no completed feed/i);
  });
});
