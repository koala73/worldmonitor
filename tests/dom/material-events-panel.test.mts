/**
 * #6429 — the SEC material-events backend (8-K stream seeder + RPCs + MCP
 * tool) had no dashboard surface at all. MaterialEventsPanel is the first
 * one: a list panel over listMaterialEvents, default-off in every variant
 * like earnings-calendar, so enabling it stays a product decision.
 *
 * These tests drive the exported pure helpers (the EnergyRiskOverviewPanel
 * pattern) — projection, labels, URL policy, and row rendering — in the
 * vitest dom project (the component imports @/services/i18n, whose
 * import.meta.glob only a Vite pipeline can transform). The URL policy is the tooth that matters: filing links come from a
 * seeded Redis blob, so only https://www.sec.gov/ URLs may render as
 * anchors; anything else renders as plain text.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  filedAtLabel,
  projectMaterialEvents,
  renderMaterialEvent,
  secArchiveUrl,
} from '@/components/MaterialEventsPanel';

const NOW = Date.parse('2026-08-31T12:00:00Z');

function event(overrides: Record<string, unknown> = {}) {
  return {
    company: 'ACME CORP',
    cik: '0000123456',
    form: '8-K',
    accession: '0000123456-26-000001',
    filedAtMs: NOW - 3_600_000,
    items: [{ code: '5.02', description: 'Departure of Directors or Certain Officers' }],
    url: 'https://www.sec.gov/Archives/edgar/data/123456/000012345626000001-index.htm',
    ...overrides,
  };
}

describe('secArchiveUrl — filing links come from a seeded blob and must be origin-locked', () => {
  it('accepts an https sec.gov archive URL', () => {
    assert.equal(
      secArchiveUrl('https://www.sec.gov/Archives/edgar/data/1/x.htm'),
      'https://www.sec.gov/Archives/edgar/data/1/x.htm',
    );
  });

  it('rejects other origins, downgraded schemes, and javascript: URLs', () => {
    assert.equal(secArchiveUrl('http://www.sec.gov/Archives/x.htm'), null);
    assert.equal(secArchiveUrl('https://evil.example/www.sec.gov/x'), null);
    assert.equal(secArchiveUrl('https://www.sec.gov.evil.example/x'), null);
    assert.equal(secArchiveUrl('javascript:alert(1)'), null);
    assert.equal(secArchiveUrl(''), null);
  });
});

describe('projectMaterialEvents', () => {
  it('sorts newest-first and drops entries with no usable identity', () => {
    const projected = projectMaterialEvents([
      event({ company: 'OLDER', filedAtMs: NOW - 7_200_000 }),
      event({ company: 'NEWER', filedAtMs: NOW - 60_000 }),
      event({ company: '', cik: '' }),
    ]);

    assert.deepEqual(projected.map((e) => e.company), ['NEWER', 'OLDER']);
  });

  it('falls back to the CIK for a nameless filer and to 8-K for a blank form', () => {
    const [projected] = projectMaterialEvents([event({ company: '', cik: '0000999999', form: '' })]);
    assert.equal(projected!.company, 'CIK 0000999999');
    assert.equal(projected!.form, '8-K');
  });

  it('tolerates a malformed items array', () => {
    const projected = projectMaterialEvents([
      event({ items: undefined }),
      event({ items: [] }),
    ]);
    assert.equal(projected.length, 2);
    assert.deepEqual(projected[0]!.items, []);
  });
});

describe('filedAtLabel', () => {
  it('renders a time for a same-day filing and a date otherwise', () => {
    // Local noon, so "one hour earlier" is the same local day in every timezone.
    const localNoon = new Date(2026, 7, 31, 12, 0).getTime();
    const sameDay = filedAtLabel(localNoon - 3_600_000, localNoon, 'en');
    const older = filedAtLabel(localNoon - 3 * 86_400_000, localNoon, 'en');
    assert.match(sameDay, /\d{1,2}:\d{2}/);
    assert.doesNotMatch(older, /\d{1,2}:\d{2}/);
    assert.match(older, /Aug/);
  });

  it('renders an empty label for an unusable timestamp', () => {
    assert.equal(filedAtLabel(0, NOW, 'en'), '');
    assert.equal(filedAtLabel(Number.NaN, NOW, 'en'), '');
  });
});

describe('renderMaterialEvent', () => {
  it('escapes seeded text and carries the form + item badge', () => {
    const html = renderMaterialEvent(
      projectMaterialEvents([event({ company: '<img src=x onerror=alert(1)>' })])[0]!,
      NOW,
      'en',
    );
    assert.ok(!html.includes('<img'), 'seeded company names must be escaped');
    assert.ok(html.includes('&lt;img'));
    assert.ok(html.includes('8-K'));
    assert.ok(html.includes('5.02'));
    assert.ok(html.includes('Departure of Directors'));
  });

  it('links only origin-locked filing URLs and never emits a bare anchor otherwise', () => {
    const linked = renderMaterialEvent(projectMaterialEvents([event()])[0]!, NOW, 'en');
    assert.ok(linked.includes('href="https://www.sec.gov/Archives/'));
    assert.ok(linked.includes('rel="noopener'), 'external links must carry noopener');

    const unlinked = renderMaterialEvent(
      projectMaterialEvents([event({ url: 'https://evil.example/x' })])[0]!,
      NOW,
      'en',
    );
    assert.ok(!unlinked.includes('<a '), 'an off-origin URL must not render as a link');
    assert.ok(unlinked.includes('ACME CORP'), 'the row still renders as text');
  });

  it('counts extra items on the badge and omits item markup when there are none', () => {
    const multi = renderMaterialEvent(
      projectMaterialEvents([event({
        items: [
          { code: '5.02', description: 'Departure of Directors or Certain Officers' },
          { code: '9.01', description: 'Financial Statements and Exhibits' },
        ],
      })])[0]!,
      NOW,
      'en',
    );
    assert.ok(multi.includes('5.02 +1'));
    assert.ok(!multi.includes('Financial Statements'), 'only the primary item description renders');

    const bare = renderMaterialEvent(projectMaterialEvents([event({ items: [] })])[0]!, NOW, 'en');
    assert.ok(!bare.includes('5.02'));
    assert.ok(!bare.includes('Departure of Directors'));
  });

  it('keeps an on-origin URL with a quote inside the href attribute', () => {
    const html = renderMaterialEvent(
      projectMaterialEvents([event({ url: 'https://www.sec.gov/x"onmouseover="alert(1)' })])[0]!,
      NOW,
      'en',
    );
    assert.ok(html.includes('href="https://www.sec.gov/x&quot;onmouseover=&quot;alert(1)"'));
    assert.ok(!html.includes('"onmouseover="'), 'a seeded quote must not close the href attribute');
  });
});
