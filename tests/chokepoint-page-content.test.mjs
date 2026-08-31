import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHOKEPOINT_CONTENT,
  CHOKEPOINT_REGISTRY_OBSERVED_AT,
  EIA_OIL_TRANSIT_BASELINES,
  TRADE_ROUTES_OBSERVED_AT,
} from '../scripts/chokepoint-page-content.mjs';

const REGISTRY_IDS = [
  'suez',
  'malacca_strait',
  'hormuz_strait',
  'bab_el_mandeb',
  'panama',
  'taiwan_strait',
  'cape_of_good_hope',
  'gibraltar',
  'bosphorus',
  'korea_strait',
  'dover_strait',
  'kerch_strait',
  'lombok_strait',
];

describe('chokepoint page content (#7461)', () => {
  it('covers every canonical waterway with unique question-shaped copy', () => {
    assert.deepEqual(Object.keys(CHOKEPOINT_CONTENT).sort(), [...REGISTRY_IDS].sort());
    const headings = new Set();
    for (const id of REGISTRY_IDS) {
      const content = CHOKEPOINT_CONTENT[id];
      assert.ok(content.region, `${id} must declare connected waters`);
      assert.ok(content.blurb, `${id} must have a lede`);
      assert.match(content.whyHeading, /\?$/, `${id} whyHeading must be a question`);
      assert.equal(headings.has(content.whyHeading), false, `${id} whyHeading must be unique`);
      headings.add(content.whyHeading);
      assert.ok(
        Array.isArray(content.analysis) && content.analysis.length >= 2,
        `${id} must have at least two analysis paragraphs`,
      );
      assert.ok(content.alternative, `${id} must describe the alternative or fallback`);
      assert.ok(
        Array.isArray(content.faqs) && content.faqs.length >= 2,
        `${id} must author at least two FAQs`,
      );
    }
  });

  it('keeps EIA oil baselines aligned with the committed seeder ids', () => {
    assert.equal(EIA_OIL_TRANSIT_BASELINES.referenceYear, 2023);
    assert.equal(EIA_OIL_TRANSIT_BASELINES.byRegistryId.hormuz_strait.mbd, 21.0);
    assert.equal(EIA_OIL_TRANSIT_BASELINES.byRegistryId.panama.mbd, 0.9);
    assert.equal(EIA_OIL_TRANSIT_BASELINES.byRegistryId.dover_strait.eiaName, 'Danish Straits');
  });

  it('does not claim a missing table or off-page rows as this page’s table', () => {
    const emptyRouteIds = new Set(['korea_strait', 'dover_strait', 'kerch_strait', 'lombok_strait']);
    for (const id of REGISTRY_IDS) {
      const content = CHOKEPOINT_CONTENT[id];
      const visible = [
        ...content.analysis,
        content.alternative,
        ...content.faqs.flatMap((faq) => [faq.question, faq.answer]),
      ].join('\n');
      assert.doesNotMatch(
        visible,
        /no (corridor|trade-route) table/i,
        `${id} must not say the rendered corridor table is absent`,
      );
      assert.doesNotMatch(
        visible,
        /in the same (trade-route )?table/i,
        `${id} must not place off-page alternatives inside this page’s table`,
      );
      if (emptyRouteIds.has(id)) {
        assert.match(
          visible,
          /no mapped rows|empty modelled table|corridor book/i,
          `${id} empty-route copy must describe an unmapped table, not a missing one`,
        );
      }
    }
  });

  it('pins observation dates that survive a git-less corpus build', () => {
    assert.match(CHOKEPOINT_REGISTRY_OBSERVED_AT, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(TRADE_ROUTES_OBSERVED_AT, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(CHOKEPOINT_REGISTRY_OBSERVED_AT, '2026-04-09');
    assert.equal(TRADE_ROUTES_OBSERVED_AT, '2026-03-14');
  });
});
