import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import { LIVE_TOPIC_PAGES } from '../scripts/live-pages/index.mjs';
import { LIVE_PAGE_RELATED } from '../scripts/live-pages/related-links.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let outDir;
const pages = new Map();

function linksIn(html) {
  return new Set([...html.matchAll(/<a [^>]*href="(\/[^"#?]*)"/g)].map(([, href]) => href));
}

function inbound(target) {
  return [...pages].filter(([path, html]) => path !== target && linksIn(html).has(target)).map(([path]) => path);
}

before(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'wm-live-links-'));
  await buildCorpus({ rootDir: repoRoot, outDir, baseUrl: 'https://www.worldmonitor.app' });
  for (const file of readdirSync(outDir, { recursive: true }).map(String)) {
    if (!file.endsWith('index.html')) continue;
    const path = `/${file.slice(0, -'index.html'.length)}`;
    pages.set(path, readFileSync(join(outDir, file), 'utf8'));
  }
});

after(() => rmSync(outDir, { recursive: true, force: true }));

describe('internal links to the live data pages', () => {
  it('links every country profile to the debt clock and the outage tracker', () => {
    const countries = [...pages.keys()].filter((path) => /^\/countries\/[^/]+\/$/.test(path));
    assert.ok(countries.length > 150, `country profiles: ${countries.length}`);
    for (const path of countries) {
      const links = linksIn(pages.get(path));
      assert.ok(links.has('/tools/national-debt-clock/'), `${path} -> debt clock`);
      assert.ok(links.has('/tools/internet-outages/'), `${path} -> internet outages`);
    }
  });

  it('gives the US profile its markets pages and no other country those links', () => {
    const us = linksIn(pages.get('/countries/united-states/'));
    for (const href of ['/tools/treasury-yield-curve/', '/tools/crude-oil-inventories/', '/tools/fear-and-greed-index/']) {
      assert.ok(us.has(href), `US -> ${href}`);
      assert.ok(!linksIn(pages.get('/countries/france/')).has(href), `France must not link ${href}`);
    }
  });

  it('links oil chokepoints, and only oil chokepoints, to US crude stocks', () => {
    for (const slug of ['strait-of-hormuz', 'bab-el-mandeb', 'suez-canal', 'strait-of-malacca', 'panama-canal']) {
      assert.ok(linksIn(pages.get(`/chokepoints/${slug}/`)).has('/tools/crude-oil-inventories/'), slug);
    }
    for (const slug of ['taiwan-strait', 'korea-strait', 'cape-of-good-hope']) {
      assert.ok(!linksIn(pages.get(`/chokepoints/${slug}/`)).has('/tools/crude-oil-inventories/'), `${slug} carries no EIA oil baseline`);
    }
    assert.ok(linksIn(pages.get('/chokepoints/')).has('/tools/crude-oil-inventories/'), 'the hub oil table points to current stocks');
  });

  it('links every crisis tracker to prediction markets and the outage tracker', () => {
    const crises = [...pages.keys()].filter((path) => /^\/crises\/[^/]+\/$/.test(path));
    assert.ok(crises.length >= 10, `crisis trackers: ${crises.length}`);
    for (const path of crises) {
      const links = linksIn(pages.get(path));
      assert.ok(links.has('/tools/prediction-markets/'), `${path} -> prediction markets`);
      assert.ok(links.has('/tools/internet-outages/'), `${path} -> internet outages`);
    }
  });

  it('adds crude stocks only to crisis trackers tied to an oil chokepoint', () => {
    for (const slug of ['red-sea-security', 'hormuz-gulf-security']) {
      assert.ok(linksIn(pages.get(`/crises/${slug}/`)).has('/tools/crude-oil-inventories/'), slug);
    }
    for (const slug of ['afghanistan-crisis', 'haiti-gang-crisis']) {
      assert.ok(!linksIn(pages.get(`/crises/${slug}/`)).has('/tools/crude-oil-inventories/'), `${slug} touches no oil chokepoint`);
    }
  });

  it('leaves no live page reachable only from the hub', () => {
    for (const page of LIVE_TOPIC_PAGES) {
      const from = inbound(page.path).filter((path) => path !== '/tools/');
      assert.ok(from.length >= 2, `${page.path} has contextual inbound links from ${JSON.stringify(from)}`);
    }
  });

  it('points every related-data link at a page the build writes', () => {
    for (const [slug, links] of Object.entries(LIVE_PAGE_RELATED)) {
      assert.ok(LIVE_TOPIC_PAGES.some((page) => page.slug === slug), `${slug} is a live page`);
      for (const { href } of links) {
        assert.ok(pages.has(href) || existsSync(join(repoRoot, 'public', href, 'index.html')), `${slug} -> ${href}`);
      }
    }
  });
});
