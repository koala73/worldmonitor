import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { buildCorpus, loadCorpusData } from '../scripts/build-crawlable-corpus.mjs';
import {
  COUNTRY_PRO_LINK_EVENT,
  COUNTRY_PRO_LINK_HREF,
  COUNTRY_PRO_LINK_TARGET,
  MAX_RELATED_COUNTRIES,
  MIN_RELATED_COUNTRIES,
  NEARBY_GAP_DEGREES,
  boundingBoxGapDegrees,
  relatedCountryAnchorText,
  renderCountryProLink,
  renderRelatedCountries,
  selectRelatedCountries,
} from '../scripts/country-related-links.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const crisis = (slug, shortTitle, codes) => ({ slug, shortTitle, coverage: codes.map((code) => ({ code })) });
const LB_IL = crisis('lebanon-israel-escalation', 'Lebanon–Israel escalation', ['LB', 'IL']);
const GULF = crisis('hormuz-gulf-security', 'Hormuz and Gulf security', ['IR', 'IQ', 'SA', 'QA', 'KW', 'AE', 'OM', 'BH']);
const IR_IL = crisis('iran-israel-escalation', 'Iran–Israel escalation', ['IR', 'IL']);

function fixtureCountries() {
  const row = (code, name, regionId, crises = []) => ({
    code,
    name,
    slug: name.toLowerCase().replaceAll(' ', '-'),
    regionId,
    crisisMemberships: crises,
  });
  return [
    row('LB', 'Lebanon', 'mena', [LB_IL]),
    row('IL', 'Israel', 'mena', [LB_IL, IR_IL]),
    row('SY', 'Syria', 'mena'),
    row('JO', 'Jordan', 'mena'),
    row('TR', 'Turkey', 'mena'),
    row('EG', 'Egypt', 'mena'),
    row('IR', 'Iran', 'mena', [GULF, IR_IL]),
    row('IQ', 'Iraq', 'mena', [GULF]),
    row('SA', 'Saudi Arabia', 'mena', [GULF]),
    row('US', 'United States', 'north-america'),
    row('RU', 'Russia', 'europe'),
    row('MC', 'Monaco', 'europe'),
    row('FR', 'France', 'europe'),
    row('TV', 'Tuvalu', 'east-asia'),
  ];
}

const FIXTURE_BBOXES = new Map(Object.entries({
  LB: [33.09, 35.11, 34.65, 36.6],
  IL: [29.5, 34.27, 33.33, 35.9],
  SY: [32.31, 35.73, 37.32, 42.38],
  JO: [29.19, 34.96, 33.37, 39.3],
  TR: [35.82, 26.04, 42.14, 44.79],
  EG: [22, 24.7, 31.67, 36.9],
  IR: [25.06, 44.03, 39.78, 63.32],
  IQ: [29.06, 38.79, 37.38, 48.57],
  SA: [16.38, 34.5, 32.15, 55.67],
  US: [19.03, -168.08, 71.31, -66.98],
  RU: [41.21, 19.6, 81.29, -169.7],
  FR: [41.33, -5.14, 51.09, 9.55],
}));
const FIXTURE_CENTROIDS = {
  LB: [33.92, 35.88], IL: [31.1, 34.86], SY: [35.01, 38.51], JO: [31.25, 36.77], TR: [39.06, 35.18],
  EG: [26.5, 29.86], IR: [32.57, 54.27], IQ: [33.04, 43.74], SA: [24.12, 44.54], US: [39.51, -99.12],
  RU: [61.69, 99.08], MC: [43.75, 7.41], FR: [46.61, 2.49], TV: [-8.52, 179.2],
};
const FIXTURE_TENSION = [{ id: 'usa_russia', countries: ['US', 'RU'], label: 'US–Russia' }];

function select(countries = fixtureCountries()) {
  return selectRelatedCountries({
    countries,
    bboxByCode: FIXTURE_BBOXES,
    centroidByCode: FIXTURE_CENTROIDS,
    tensionPairs: FIXTURE_TENSION,
    regionLabels: { mena: 'the Middle East and North Africa', europe: 'Europe', 'north-america': 'North America' },
  });
}

describe('related-country selection (fixture)', () => {
  it('ranks a shared two-country crisis tracker above proximity', () => {
    const lebanon = select().get('LB');
    assert.equal(lebanon[0].code, 'IL');
    assert.equal(lebanon[0].reason, 'crisis');
    assert.match(lebanon[0].detail, /Lebanon–Israel escalation/);
    assert.deepEqual(lebanon.slice(1, 3).map((target) => target.code).sort(), ['JO', 'SY']);
  });

  it('prefers the smaller shared tracker among crisis ties', () => {
    // Iran shares the two-country Iran–Israel tracker with Israel and the
    // eight-country Gulf tracker with Iraq and Saudi Arabia.
    assert.equal(select().get('IR')[0].code, 'IL');
  });

  it('uses the GDELT tension pairs, which cross the antimeridian for US–Russia', () => {
    const us = select().get('US');
    assert.equal(us[0].code, 'RU');
    assert.equal(us[0].reason, 'tension');
  });

  it('treats a microstate without a box as its centroid inside the neighbour box', () => {
    const monaco = select().get('MC');
    assert.equal(monaco[0].code, 'FR');
    assert.equal(monaco[0].reason, 'nearby');
  });

  it('names a region for nearby only when both countries are in it', () => {
    // Russia's box reaches the Sea of Japan, but Japan's page must not call
    // Russia "nearby in Europe".
    const related = selectRelatedCountries({
      countries: [
        { code: 'JP', name: 'Japan', slug: 'japan', regionId: 'east-asia' },
        { code: 'KR', name: 'South Korea', slug: 'south-korea', regionId: 'east-asia' },
        { code: 'RU', name: 'Russia', slug: 'russia', regionId: 'europe' },
      ],
      bboxByCode: new Map(Object.entries({
        JP: [24.04, 122.93, 45.52, 145.82],
        KR: [33.11, 124.61, 38.61, 131.87],
        RU: FIXTURE_BBOXES.get('RU'),
      })),
      centroidByCode: { JP: [36.2, 138.25], KR: [35.91, 127.77], RU: FIXTURE_CENTROIDS.RU },
      regionLabels: { 'east-asia': 'East Asia and the Pacific', europe: 'Europe' },
    }).get('JP');
    const byCode = new Map(related.map((target) => [target.code, target]));
    assert.equal(byCode.get('KR').detail, 'nearby in East Asia and the Pacific');
    assert.equal(byCode.get('RU').reason, 'nearby');
    assert.equal(byCode.get('RU').detail, 'nearby');
  });

  it('ranks more shared trackers first and names them in the plural', () => {
    // Israel shares two trackers with Lebanon here, Syria one smaller one.
    const LB_SY = crisis('lebanon-syria-border', 'Lebanon–Syria border', ['LB', 'SY']);
    const LB_IL_GAZA = crisis('gaza-war', 'Gaza war', ['LB', 'IL', 'PS', 'EG']);
    const countries = fixtureCountries().map((country) => {
      if (country.code === 'LB') return { ...country, crisisMemberships: [LB_IL, LB_IL_GAZA, LB_SY] };
      if (country.code === 'IL') return { ...country, crisisMemberships: [LB_IL, LB_IL_GAZA] };
      if (country.code === 'SY') return { ...country, crisisMemberships: [LB_SY] };
      return country;
    });
    const lebanon = select(countries).get('LB');
    assert.deepEqual(lebanon.slice(0, 2).map((target) => target.code), ['IL', 'SY']);
    assert.equal(lebanon[0].detail, 'shares the Gaza war and Lebanon–Israel escalation crisis trackers');
    assert.equal(lebanon[1].detail, 'shares the Lebanon–Syria border crisis tracker');
  });

  it('breaks exact ties by name, whatever the input order', () => {
    // Two candidates identical in every signal and distance.
    const twin = (code, name) => ({ code, name, slug: name.toLowerCase(), regionId: 'europe' });
    const countries = [twin('AA', 'Alpha'), twin('BB', 'Bravo'), twin('CC', 'Charlie'), twin('DD', 'Delta')];
    const boxes = new Map(countries.map((country) => [country.code, [10, 10, 11, 11]]));
    const centroids = Object.fromEntries(countries.map((country) => [country.code, [10.5, 10.5]]));
    const run = (input) => selectRelatedCountries({ countries: input, bboxByCode: boxes, centroidByCode: centroids })
      .get('DD').map((target) => target.code);
    assert.deepEqual(run(countries), ['AA', 'BB', 'CC']);
    assert.deepEqual(run([...countries].reverse()), ['AA', 'BB', 'CC']);
  });

  it('tops up to the minimum when no signal applies', () => {
    const tuvalu = select().get('TV');
    assert.equal(tuvalu.length, MIN_RELATED_COUNTRIES);
    assert.ok(tuvalu.every((target) => target.reason === 'nearest'));
  });

  it('returns 3-5 targets, never itself, all from the published set', () => {
    const countries = fixtureCountries();
    const codes = new Set(countries.map((country) => country.code));
    for (const [code, targets] of select(countries)) {
      assert.ok(targets.length >= MIN_RELATED_COUNTRIES && targets.length <= MAX_RELATED_COUNTRIES, `${code}: ${targets.length}`);
      assert.ok(targets.every((target) => target.code !== code), `${code} links to itself`);
      assert.ok(targets.every((target) => codes.has(target.code)), `${code} links outside the set`);
      assert.equal(new Set(targets.map((target) => target.code)).size, targets.length, `${code} repeats a target`);
    }
  });

  it('never links to a country that has no page', () => {
    const countries = fixtureCountries().filter((country) => country.code !== 'SY');
    for (const targets of select(countries).values()) {
      assert.ok(targets.every((target) => target.code !== 'SY'));
    }
  });

  it('is deterministic regardless of input order', () => {
    const forward = select(fixtureCountries());
    const reversed = select(fixtureCountries().reverse());
    for (const [code, targets] of forward) assert.deepEqual(reversed.get(code), targets, code);
  });

  it('measures box gaps across the antimeridian', () => {
    // Alaska and Chukotka sit about 1.6 degrees of longitude apart at ~65N.
    assert.ok(boundingBoxGapDegrees(FIXTURE_BBOXES.get('US'), FIXTURE_BBOXES.get('RU')) < NEARBY_GAP_DEGREES);
    assert.ok(boundingBoxGapDegrees(FIXTURE_BBOXES.get('LB'), FIXTURE_BBOXES.get('US')) > 10);
  });
});

describe('related-country rendering', () => {
  it('uses descriptive anchors and no rank or score', () => {
    const html = renderRelatedCountries(
      { code: 'LB', name: 'Lebanon' },
      select().get('LB'),
      escapeHtml,
    );
    assert.match(html, /<a href="\/countries\/israel\/">Israel resilience and risk profile<\/a>/);
    assert.equal(relatedCountryAnchorText({ name: 'Lebanon' }), 'Lebanon resilience and risk profile');
    assert.doesNotMatch(html, /#\d|click here|ranked|score/i);
  });

  it('renders nothing for an empty list', () => {
    assert.equal(renderRelatedCountries({ code: 'ZZ', name: 'Testland' }, [], escapeHtml), '');
  });
});

describe('country Pro/API link', () => {
  it('links to Pro pricing with Umami attribution and no query tag', () => {
    const html = renderCountryProLink({ code: 'LB', name: 'Lebanon' }, escapeHtml);
    assert.equal(COUNTRY_PRO_LINK_HREF, '/pro#pricing');
    assert.match(html, /<a href="\/pro#pricing" data-umami-event="country-page-cta" data-umami-event-target="pro-api-pricing" data-umami-event-country="LB">Compare World Monitor Pro and API plans for Lebanon risk data<\/a>/);
    // Same-site links take no query tag: any utm_* or ref key is a bot 308 (#8603).
    assert.doesNotMatch(html, /[?&](utm_|ref=|wm_referral=)/);
    assert.equal((html.match(/<a /g) || []).length, 1);
  });
});

describe('related countries and the Pro link on the generated corpus', () => {
  let outDir;
  let data;
  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'wm-country-related-'));
    data = await loadCorpusData({ rootDir: repoRoot });
    await buildCorpus({ rootDir: repoRoot, outDir, baseUrl: 'https://www.worldmonitor.app' });
  });
  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('gives every country 3-5 existing, non-self targets', () => {
    const slugs = new Set(data.countries.map((country) => country.slug));
    assert.equal(data.relatedCountriesByCode.size, data.countries.length);
    for (const country of data.countries) {
      const targets = data.relatedCountriesByCode.get(country.code);
      assert.ok(targets.length >= MIN_RELATED_COUNTRIES && targets.length <= MAX_RELATED_COUNTRIES, `${country.code}: ${targets.length}`);
      assert.ok(targets.every((target) => target.code !== country.code), `${country.code} links to itself`);
      assert.ok(targets.every((target) => slugs.has(target.slug)), `${country.code} links to a missing page`);
    }
  });

  it('feeds every signal from the real datasets', () => {
    // The checks above pass even if every input were dropped and all pages
    // fell back to "nearest". Each signal must reach some page, and the
    // fallback must stay the exception.
    const targets = [...data.relatedCountriesByCode.values()].flat();
    const reasons = new Set(targets.map((target) => target.reason));
    for (const reason of ['crisis', 'tension', 'nearby', 'region']) {
      assert.ok(reasons.has(reason), `no country page links by ${reason}`);
    }
    const nearest = targets.filter((target) => target.reason === 'nearest').length;
    assert.ok(nearest * 10 < targets.length, `${nearest} of ${targets.length} links are the nearest-country fallback`);
  });

  it('keeps far-off territory out of "nearby"', () => {
    const nearbyCodes = (code) => data.relatedCountriesByCode.get(code)
      .filter((target) => target.reason === 'nearby')
      .map((target) => target.code);
    // French Guiana and Russia's single box once made these "nearby".
    for (const code of ['LR', 'SL', 'GM', 'CV', 'CA', 'SR', 'MA']) {
      assert.ok(!nearbyCodes(code).includes('FR'), `${code} calls France nearby`);
    }
    for (const code of ['GR', 'AL', 'RS', 'BG', 'RO', 'MD', 'IT']) {
      assert.ok(!nearbyCodes(code).includes('RU'), `${code} calls Russia nearby`);
    }
    // Real neighbours keep the link.
    assert.ok(nearbyCodes('FI').includes('RU'), 'Finland must keep Russia');
    assert.ok(nearbyCodes('GE').includes('RU'), 'Georgia must keep Russia');
    assert.ok(nearbyCodes('MC').includes('FR'), 'Monaco must keep France');
    assert.ok(nearbyCodes('CU').includes('US'), 'Cuba must keep the United States');
  });

  it('selects the same targets on a second load', async () => {
    const again = await loadCorpusData({ rootDir: repoRoot });
    for (const [code, targets] of data.relatedCountriesByCode) {
      assert.deepEqual(again.relatedCountriesByCode.get(code), targets, code);
    }
  });

  it('renders the related links and exactly one Pro/API link on every country page', () => {
    for (const country of data.countries) {
      const html = readFileSync(join(outDir, 'countries', country.slug, 'index.html'), 'utf8');
      const section = html.match(/<ul class="related-countries" data-related-countries>([\s\S]*?)<\/ul>/)?.[1] || '';
      const hrefs = [...section.matchAll(/href="\/countries\/([^/"]+)\/"/g)].map((match) => match[1]);
      assert.deepEqual(hrefs, data.relatedCountriesByCode.get(country.code).map((target) => target.slug), country.code);
      assert.equal(
        (html.match(new RegExp(`data-umami-event="${COUNTRY_PRO_LINK_EVENT}" data-umami-event-target="${COUNTRY_PRO_LINK_TARGET}"`, 'g')) || []).length,
        1,
        `${country.code} Pro link count`,
      );
      assert.ok(html.includes('src="https://abacus.worldmonitor.app/script.js"'), `${country.code} loads no Umami script`);
    }
  });

  it('keeps unranked pages free of rank claims in the new sections', () => {
    const unranked = data.countries.filter((country) => country.rank == null);
    assert.ok(unranked.length > 0);
    for (const country of unranked) {
      const html = readFileSync(join(outDir, 'countries', country.slug, 'index.html'), 'utf8');
      const section = html.match(/<h2>Related country profiles<\/h2>[\s\S]*?<\/ul>/)?.[0] || '';
      const proLink = html.match(/<p data-country-pro-link>[\s\S]*?<\/p>/)?.[0] || '';
      assert.ok(section && proLink, country.code);
      assert.doesNotMatch(`${section}${proLink}`, /#\d|\branked\b|\brank\b/i, country.code);
    }
  });
});
