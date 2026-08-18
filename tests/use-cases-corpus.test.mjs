// Content and publishing contract for the /use-cases/ family (issues #6849, #6850, #6851).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import {
  HANDOFF_PRESERVE_SCRIPT,
  USE_CASE_PAGES,
  USE_CASES_CONTENT_VERSION,
} from '../scripts/build-use-cases.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function jsonLdObjects(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, raw]) => JSON.parse(raw));
}

function htmlAttributes(source) {
  return Object.fromEntries(
    [...source.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)]
      .map(([, name, value = '']) => [name, value.replaceAll('&amp;', '&')]),
  );
}

function handoffForDestination(html, destination) {
  for (const [, source] of html.matchAll(/<a\b([^>]*)>/g)) {
    const attributes = htmlAttributes(source);
    if (attributes['data-umami-event-content-destination'] === destination) return attributes;
  }
  assert.fail(`missing ${destination} handoff`);
}

function executeHandoffPreserve(incomingSearch, initialHrefs) {
  const anchors = initialHrefs.map((initialHref) => {
    let href = initialHref;
    return {
      getAttribute(name) {
        return name === 'href' ? href : null;
      },
      setAttribute(name, value) {
        assert.equal(name, 'href');
        href = value;
      },
      currentHref() {
        return href;
      },
    };
  });

  runInNewContext(HANDOFF_PRESERVE_SCRIPT, {
    URL,
    URLSearchParams,
    window: {
      location: {
        origin: 'https://www.worldmonitor.app',
        search: incomingSearch,
      },
    },
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '[data-use-case-handoff]');
        return anchors;
      },
    },
  });

  return anchors.map((anchor) => anchor.currentHref());
}

describe('use-cases corpus (#6849, #6850, #6851)', () => {
  let outDir;
  let hubHtml;
  let countryRiskHtml;
  let breakingNewsHtml;
  let supplyChainHtml;
  let manifest;

  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'wm-use-cases-corpus-'));
    manifest = await buildCorpus({
      rootDir: repoRoot,
      outDir,
      baseUrl: 'https://www.worldmonitor.app',
    });
    hubHtml = readFileSync(join(outDir, 'use-cases', 'index.html'), 'utf8');
    countryRiskHtml = readFileSync(
      join(outDir, 'use-cases', 'monitor-country-risk', 'index.html'),
      'utf8',
    );
    breakingNewsHtml = readFileSync(
      join(outDir, 'use-cases', 'verify-breaking-news', 'index.html'),
      'utf8',
    );
    supplyChainHtml = readFileSync(
      join(outDir, 'use-cases', 'monitor-supply-chain-disruptions', 'index.html'),
      'utf8',
    );
  });

  after(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('publishes the hub and child pages with crawlable discovery', () => {
    assert.equal(USE_CASE_PAGES.length, 3);
    assert.deepEqual(
      USE_CASE_PAGES.map((page) => page.path),
      [
        '/use-cases/monitor-country-risk/',
        '/use-cases/verify-breaking-news/',
        '/use-cases/monitor-supply-chain-disruptions/',
      ],
    );
    assert.match(hubHtml, /<h1>Evergreen monitoring workflows<\/h1>/);
    assert.match(hubHtml, /href="\/use-cases\/monitor-country-risk\/"/);
    assert.match(hubHtml, /href="\/use-cases\/verify-breaking-news\/"/);
    assert.match(hubHtml, /href="\/use-cases\/monitor-supply-chain-disruptions\/"/);
    assert.match(hubHtml, /How use cases differ from editorial posts/);
    assert.match(countryRiskHtml, /<h1>Monitor country risk<\/h1>/);
    assert.match(breakingNewsHtml, /<h1>Verify breaking news<\/h1>/);
    assert.match(breakingNewsHtml, /Direct answer:/);
    assert.match(breakingNewsHtml, /End-to-end workflow/);
    assert.match(breakingNewsHtml, /Worked example/);
    assert.match(breakingNewsHtml, /Provenance, freshness, and limits/);
    assert.match(breakingNewsHtml, /repeated headlines are independent confirmations|equating repetition to proof|repetition as corroboration|Treat wire pickup as reach/i);
    assert.match(breakingNewsHtml, /Absence of AIS here is weak evidence|quiet sensor|proof the event did not occur/i);
    assert.match(supplyChainHtml, /<h1>Monitor supply-chain disruptions<\/h1>/);
    assert.match(supplyChainHtml, /Routine monitoring checklist/);
    assert.match(supplyChainHtml, /Incident-response checklist/);
    assert.match(supplyChainHtml, /Observed:|observed evidence|Separate evidence classes/i);
    assert.match(supplyChainHtml, /cannot prove[\s\S]*price|shortage|delay|customer impact/i);
    for (const html of [hubHtml, countryRiskHtml, breakingNewsHtml, supplyChainHtml]) {
      assert.match(html, /href="\/use-cases\/"/);
    }
  });

  it('keeps metadata and structured data inside the corpus SEO contract', () => {
    for (const [label, html, canonical] of [
      ['hub', hubHtml, '/use-cases/'],
      ['country-risk', countryRiskHtml, '/use-cases/monitor-country-risk/'],
      ['breaking-news', breakingNewsHtml, '/use-cases/verify-breaking-news/'],
      ['supply-chain', supplyChainHtml, '/use-cases/monitor-supply-chain-disruptions/'],
    ]) {
      const desc = html.match(/<meta name="description" content="([^"]+)">/)?.[1];
      assert.ok(desc, `${label} missing description`);
      assert.ok(desc.length >= 155 && desc.length <= 160, `${label} description length ${desc.length}`);
      assert.match(
        html,
        new RegExp(`rel="canonical" href="https://www\\.worldmonitor\\.app${canonical.replaceAll('/', '\\/')}"`),
      );
      assert.match(html, /name="robots" content="index, follow"/);
      const [ld] = jsonLdObjects(html);
      assert.notEqual(ld['@type'], 'BlogPosting');
      assert.match(html, new RegExp(`<meta name="lastmod" content="${USE_CASES_CONTENT_VERSION}">`));
    }

    const [hubLd] = jsonLdObjects(hubHtml);
    const [pageLd] = jsonLdObjects(supplyChainHtml);
    assert.equal(hubLd['@type'], 'CollectionPage');
    assert.equal(pageLd['@type'], 'WebPage');
  });

  it('emits bounded URL and Umami attribution for every product handoff', () => {
    const expectedPaths = {
      dashboard: '/dashboard',
      pro: '/pro',
      api: '/docs/api-reference',
      mcp: '/docs/mcp-quickstart',
    };

    for (const [label, html, campaign, dashboardParams] of [
      ['country-risk', countryRiskHtml, 'monitor-country-risk', {
        country: 'TW',
        expanded: '1',
      }],
      ['breaking-news', breakingNewsHtml, 'verify-breaking-news', {
        view: 'mena',
        layers: 'ais,flights,fires,outages,hotspots,natural,military',
        timeRange: '24h',
      }],
      ['supply-chain', supplyChainHtml, 'monitor-supply-chain-disruptions', {
        chokepoint: 'bab_el_mandeb',
        layers: 'ais,tradeRoutes,hotspots,sanctions,flights,cables',
        timeRange: '24h',
      }],
    ]) {
      for (const destination of ['dashboard', 'pro', 'api', 'mcp']) {
        const attributes = handoffForDestination(html, destination);
        const placement = `use-case-cta-${destination}`;
        assert.equal(attributes['data-use-case-handoff'], '', label);
        assert.equal(attributes['data-wm-content-link'], '', label);
        assert.equal(attributes['data-umami-event'], 'use-case-product-cta-click', label);
        for (const [field, value] of Object.entries({
          source: 'worldmonitor-use-cases',
          medium: 'owned-content',
          campaign,
          destination,
          placement,
        })) {
          assert.equal(attributes[`data-umami-event-${field}`], value, label);
          assert.equal(attributes[`data-umami-event-content-${field}`], value, label);
        }

        const url = new URL(attributes.href, 'https://www.worldmonitor.app');
        assert.equal(url.pathname, expectedPaths[destination], label);
        assert.equal(url.searchParams.get('utm_source'), 'seo-use-case', label);
        assert.equal(url.searchParams.get('wm_content_source'), 'worldmonitor-use-cases', label);
        assert.equal(url.searchParams.get('wm_content_medium'), 'owned-content', label);
        assert.equal(url.searchParams.get('wm_content_campaign'), campaign, label);
        assert.equal(url.searchParams.get('wm_content_destination'), destination, label);
        assert.equal(url.searchParams.get('wm_content_placement'), placement, label);
        assert.equal(url.searchParams.has('ref'), false, label);
        assert.equal(url.searchParams.has('wm_referral'), false, label);
      }

      const dashboardUrl = new URL(
        handoffForDestination(html, 'dashboard').href,
        'https://www.worldmonitor.app',
      );
      for (const [name, value] of Object.entries(dashboardParams)) {
        assert.equal(dashboardUrl.searchParams.get(name), value, label);
      }
    }
  });

  it('preserves bounded inbound UTM values without clobbering destination values', () => {
    const longCampaign = 'x'.repeat(120);
    const [dashboardHref, proHref, malformedHref] = executeHandoffPreserve(
      `?utm_source=inbound&utm_source=second&utm_medium=email&utm_campaign=${longCampaign}&utm_term=term&utm_content=button&ref=affiliate&wm_referral=partner`,
      [
        '/dashboard?utm_source=destination&utm_medium=existing',
        '/pro?utm_campaign=page',
        'http://[',
      ],
    );
    const dashboardUrl = new URL(dashboardHref, 'https://www.worldmonitor.app');
    assert.equal(dashboardUrl.searchParams.get('utm_source'), 'destination');
    assert.equal(dashboardUrl.searchParams.get('utm_medium'), 'existing');
    assert.equal(dashboardUrl.searchParams.get('utm_campaign'), 'x'.repeat(100));
    assert.equal(dashboardUrl.searchParams.get('utm_term'), 'term');
    assert.equal(dashboardUrl.searchParams.get('utm_content'), 'button');
    assert.equal(dashboardUrl.searchParams.has('ref'), false);
    assert.equal(dashboardUrl.searchParams.has('wm_referral'), false);

    const proUrl = new URL(proHref, 'https://www.worldmonitor.app');
    assert.equal(proUrl.searchParams.get('utm_source'), 'inbound');
    assert.equal(proUrl.searchParams.get('utm_campaign'), 'page');
    assert.equal(proUrl.searchParams.has('ref'), false);
    assert.equal(proUrl.searchParams.has('wm_referral'), false);
    assert.equal(malformedHref, 'http://[');
  });

  it('records the family in the crawlable corpus manifest and countries hub', () => {
    assert.equal(manifest.sections.useCases.index, '/use-cases/');
    assert.equal(manifest.sections.useCases.count, 3);
    assert.deepEqual(manifest.sections.useCases.routes, [
      '/use-cases/monitor-country-risk/',
      '/use-cases/verify-breaking-news/',
      '/use-cases/monitor-supply-chain-disruptions/',
    ]);
    const countriesHub = readFileSync(join(outDir, 'countries', 'index.html'), 'utf8');
    assert.match(countriesHub, /href="\/use-cases\/monitor-country-risk\/"/);
    assert.match(countriesHub, /href="\/use-cases\/"/);
  });

  it('rejects indexable placeholder copy', () => {
    for (const html of [hubHtml, countryRiskHtml, breakingNewsHtml, supplyChainHtml]) {
      assert.doesNotMatch(html, /TODO|lorem ipsum|coming soon|placeholder/i);
    }
  });
});
