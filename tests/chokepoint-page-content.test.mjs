import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as corpus from '../scripts/build-crawlable-corpus.mjs';

import {
  CHOKEPOINTS,
  EIA_OIL_TRANSIT_REFERENCE_YEAR,
  EIA_OIL_TRANSIT_SOURCE,
} from '../scripts/seed-chokepoint-baselines.mjs';
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
  it('resolves authored country and crisis links by ID and derives inverse links once', () => {
    const chokepoint = { id: 'hormuz_strait', slug: 'stable-route', displayName: 'Renamed waterway' };
    const country = { code: 'IR', slug: 'stable-country', name: 'Renamed country' };
    const crisis = { slug: 'gulf-context', title: 'Renamed crisis' };
    const input = {
      chokepoints: [chokepoint], countries: [country], crises: [crisis],
      content: { hormuz_strait: { countryCodes: ['IR', 'IR'], crisisSlugs: ['gulf-context', 'gulf-context'] } },
    };
    const links = corpus.buildChokepointPageLinks(input);
    assert.deepEqual(links.byChokepointId.get('hormuz_strait'), { countries: [country], crises: [crisis], editorial: [] });
    assert.deepEqual(links.byCountryCode.get('IR'), [chokepoint]);
    assert.deepEqual(links.byCrisisSlug.get('gulf-context'), [chokepoint]);
    assert.equal(links.byCountryCode.has('OM'), false);
    assert.deepEqual(corpus.buildChokepointPageLinks({ ...input, content: {} }).byCountryCode, new Map());
    for (const [field, value] of [['countryCodes', ['XX']], ['crisisSlugs', ['unknown-crisis']], ['countryCodes', 'IR']]) {
      assert.throws(() => corpus.buildChokepointPageLinks({
        ...input, content: { hormuz_strait: { [field]: value } },
      }), new RegExp(`hormuz_strait.*${field}`));
    }
  });
  it('accepts canonical blog targets once and rejects missing or noncanonical editorial routes', () => {
    const href = '/blog/posts/energy-shock-monitoring-chokepoints-worldmonitor/';
    const link = { href, label: 'Energy shock monitoring' };
    const input = {
      chokepoints: [{ id: 'hormuz_strait', slug: 'strait-of-hormuz' }],
      countries: [], crises: [], blogPostPaths: new Set([href]),
      content: { hormuz_strait: { editorialLinks: [link, link] } },
    };
    assert.deepEqual(corpus.buildChokepointPageLinks(input).byChokepointId.get('hormuz_strait').editorial, [link]);
    for (const invalid of [
      { href: '/blog/posts/missing/', label: 'Missing article' },
      { href: `${href}?ref=other`, label: 'Query URL' },
      { href: `https://other.example${href}`, label: 'External URL' },
      { href, label: '' },
    ]) {
      assert.throws(() => corpus.buildChokepointPageLinks({
        ...input, content: { hormuz_strait: { editorialLinks: [invalid] } },
      }), /hormuz_strait.*editorialLinks/);
    }
  });
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

  it('derives EIA oil baselines from every committed seeder row', () => {
    assert.equal(EIA_OIL_TRANSIT_BASELINES.source, EIA_OIL_TRANSIT_SOURCE);
    assert.equal(EIA_OIL_TRANSIT_BASELINES.referenceYear, EIA_OIL_TRANSIT_REFERENCE_YEAR);
    assert.deepEqual(
      Object.keys(EIA_OIL_TRANSIT_BASELINES.byRegistryId).sort(),
      CHOKEPOINTS.map((cp) => cp.relayId).sort(),
    );
    for (const cp of CHOKEPOINTS) {
      assert.deepEqual(
        EIA_OIL_TRANSIT_BASELINES.byRegistryId[cp.relayId],
        { mbd: cp.mbd, eiaName: cp.name },
        `${cp.relayId} must match the seeder mbd and EIA name`,
      );
    }
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
        /(already in the|in the same) (trade-route )?table/i,
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
