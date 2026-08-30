// Content and publishing contract for the /use-cases/ family (issues #6849, #6850, #6851).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  buildCorpus,
  CORPUS_GENERATOR_CONTENT_VERSION,
} from '../scripts/build-crawlable-corpus.mjs';
import {
  HANDOFF_PRESERVE_SCRIPT,
  USE_CASE_PAGES,
  USE_CASES_CONTENT_VERSION,
} from '../scripts/build-use-cases.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXPECTED_USE_CASES_LASTMOD = [
  USE_CASES_CONTENT_VERSION,
  CORPUS_GENERATOR_CONTENT_VERSION,
].sort().at(-1);

function jsonLdObjects(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, raw]) => JSON.parse(raw));
}

function faqQuestion(name, text) {
  return {
    '@type': 'Question',
    name,
    acceptedAnswer: { '@type': 'Answer', text },
  };
}

function itemListElement(steps) {
  return steps.map((name, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name,
  }));
}

/** Visible <ol> step titles from the workflow / checklist sections. */
function visibleWorkflowStepNames(html) {
  return [
    ...html.matchAll(
      /<h2>(?:End-to-end workflow|Routine monitoring checklist|Incident-response checklist)<\/h2>\s*<ol>([\s\S]*?)<\/ol>/g,
    ),
  ].flatMap(([, ol]) =>
    [...ol.matchAll(/<li><strong>([^<]+)<\/strong>/g)].map(([, name]) => name.replace(/\.$/, '').trim()),
  );
}

const USE_CASE_STRUCTURED_DATA = {
  'country-risk': {
    faq: [
      faqQuestion(
        'How do you monitor country risk with World Monitor?',
        'Establish a baseline with the Country Instability Index and Country Resilience Index, review live instability and forecasts, check corroborating economic and security signals, record uncertainty, then set the follow-up or escalation into an exact product state.',
      ),
      faqQuestion(
        'Who is the country-risk workflow for?',
        'Risk analysts, corporate security, procurement, investors, and NGO security officers who need a repeatable monitoring decision for a defined country set — not emergency dispatch, legal certification, or military targeting.',
      ),
      faqQuestion(
        'What is the expected output of a country-risk watch?',
        'A dated monitoring note with baseline, live pressure, corroboration, uncertainty, and the next action, continuing into an exact World Monitor country brief rather than a generic homepage.',
      ),
    ],
    itemListName: 'Country-risk end-to-end workflow',
    steps: [
      'Establish a baseline',
      'Review current instability and forecasts',
      'Check corroborating economic and security signals',
      'Record uncertainty',
      'Set the follow-up or escalation',
    ],
  },
  'breaking-news': {
    faq: [
      faqQuestion(
        'How do you verify breaking news with World Monitor?',
        'Treat a viral claim as a hypothesis: capture the exact claim and window, assess the source chain, test only the World Monitor signal families that can support or contradict it, record contradictions and coverage gaps, then assign a qualified outcome before you brief anyone.',
      ),
      faqQuestion(
        'Who is the breaking-news verification workflow for?',
        'Newsroom researchers, OSINT analysts, duty-of-care officers, and desk editors who need a bounded verification record in minutes — not a rewritten article and not a generic homepage tour.',
      ),
      faqQuestion(
        'What can World Monitor not prove about a breaking claim?',
        'That a quiet map means nothing happened, or that repeated headlines are independent confirmations. Correlated sensors are evidence, not certainty, and this workflow does not certify that an event is true.',
      ),
    ],
    itemListName: 'Breaking-news verification workflow',
    steps: [
      'Capture the claim precisely',
      'Assess the original source',
      'Check news velocity without equating repetition to proof',
      'Test only relevant independent signals',
      'Record freshness, fit, and contradictions',
      'Assign a qualified outcome',
    ],
  },
  'supply-chain': {
    faq: [
      faqQuestion(
        'How do you monitor supply-chain disruptions with World Monitor?',
        'Define the exposure first, keep a routine baseline, then switch to incident mode only when a signal can touch that exposure. Separate observed evidence, forecasts, and analyst inference before you escalate.',
      ),
      faqQuestion(
        'What is the difference between routine monitoring and incident response?',
        'Routine monitoring defines exposure, establishes a baseline, runs the daily scan, and sets watch thresholds. Incident response identifies the first-order constraint, tests exposure fit, maps transmission paths, separates evidence classes, and records stale or contradictory sources before escalating.',
      ),
      faqQuestion(
        'What can World Monitor not prove about a disruption?',
        'That an event will cause a specific price, shortage, delay, or customer impact. Market moves are confirmation signals, not causal proof.',
      ),
    ],
    itemListName: 'Supply-chain disruption monitoring steps',
    steps: [
      'Define the exposure',
      'Establish a baseline',
      'Run the daily scan',
      'Set watch thresholds',
      'Identify the first-order constraint',
      'Test exposure fit',
      'Map transmission paths',
      'Separate evidence classes',
      'Record stale, missing, or contradictory sources',
    ],
  },
};

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
      assert.match(html, /name="robots" content="index, follow, max-image-preview:large, max-snippet:-1"/);
      const [ld] = jsonLdObjects(html);
      assert.notEqual(ld['@type'], 'BlogPosting');
      assert.match(html, new RegExp(`<meta name="lastmod" content="${EXPECTED_USE_CASES_LASTMOD}">`));
    }

    const [hubLd] = jsonLdObjects(hubHtml);
    const [pageLd] = jsonLdObjects(supplyChainHtml);
    assert.equal(hubLd['@type'], 'CollectionPage');
    assert.equal(pageLd['@type'], 'WebPage');

    for (const [label, html] of [
      ['country-risk', countryRiskHtml],
      ['breaking-news', breakingNewsHtml],
      ['supply-chain', supplyChainHtml],
    ]) {
      const expected = USE_CASE_STRUCTURED_DATA[label];
      const types = new Set(jsonLdObjects(html).map((ld) => ld['@type']));
      assert.ok(types.has('WebPage'), `${label} missing WebPage JSON-LD`);
      assert.ok(types.has('FAQPage'), `${label} missing FAQPage JSON-LD for AI extraction (#7381)`);
      assert.ok(types.has('ItemList'), `${label} missing ItemList JSON-LD for AI extraction (#7381)`);
      const faq = jsonLdObjects(html).find((ld) => ld['@type'] === 'FAQPage');
      assert.deepEqual(faq.mainEntity, expected.faq, `${label} FAQPage questions`);
      const list = jsonLdObjects(html).find((ld) => ld['@type'] === 'ItemList');
      assert.equal(list.name, expected.itemListName, `${label} ItemList name`);
      assert.equal(list.numberOfItems, expected.steps.length, `${label} ItemList numberOfItems`);
      assert.deepEqual(
        list.itemListElement,
        itemListElement(expected.steps),
        `${label} ItemList steps`,
      );
      assert.deepEqual(
        visibleWorkflowStepNames(html),
        expected.steps,
        `${label} visible workflow steps must match ItemList names`,
      );
    }
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
