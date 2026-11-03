// The WTO Hormuz tracker page renamed its insight heading from "Strategic Trade
// Insight:" to "Strategic trade insights:", so the seeder stored no title and no
// body. Its status read only the summary, where "severely constrained" matched
// nothing, so the panel and the executive overview showed the strait as OPEN
// while every shipment index sat at zero.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deriveStatus, parseWtoPage } from '../scripts/seed-hormuz.mjs';

const PAGE = readFileSync(new URL('./fixtures/wto-hormuz-page-2026-11.html', import.meta.url), 'utf8');

describe('parseWtoPage on the November 2026 WTO page', () => {
  const page = parseWtoPage(PAGE);

  it('reads the insight title under its current heading', () => {
    assert.equal(page.title, 'Strategic trade insights: Cross-commodity impacts in July and August');
  });

  it('reads the insight body and skips the AIS coverage note', () => {
    assert.ok(page.paragraphs.length >= 3, `expected the body paragraphs, got ${page.paragraphs.length}`);
    assert.match(page.paragraphs[0], /^July and August data indicate/);
    assert.ok(page.paragraphs.every((p) => !/vessels visible through AIS/.test(p)), 'the AIS coverage note is not insight text');
  });

  it('keeps the publication date as an ISO date, and the summary', () => {
    assert.equal(page.updatedDate, '2026-09-21');
    assert.match(page.summary, /^Shipping through the Strait of Hormuz remained severely constrained/);
  });

  it('does not report a severely constrained strait as open', () => {
    assert.equal(page.status, 'disrupted');
  });
});

describe('parseWtoPage on the earlier heading', () => {
  it('still reads "Strategic Trade Insight:"', () => {
    const html = '<p><strong>Strategic Trade Insight: Tanker calls ease</strong></p><p>Tanker calls through the strait eased slightly over the month.</p>';
    const page = parseWtoPage(html);
    assert.equal(page.title, 'Strategic Trade Insight: Tanker calls ease');
    assert.deepEqual(page.paragraphs, ['Tanker calls through the strait eased slightly over the month.']);
  });
});

describe('deriveStatus', () => {
  const cases = [
    ['The strait was closed to commercial traffic.', 'closed'],
    ['Shipping remained severely constrained throughout the quarter.', 'disrupted'],
    ['Regular LNG outbound shipments remained effectively suspended.', 'disrupted'],
    ['Activity remained highly restricted and uneven.', 'restricted'],
    ['Transits continued at seasonal norms.', 'open'],
  ];
  for (const [text, status] of cases) {
    it(`${status}: ${text}`, () => assert.equal(deriveStatus(text), status));
  }
});
