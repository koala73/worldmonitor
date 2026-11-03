// Contract for /reference/coverage/: every panel, map layer and MCP tool by
// name, generated from the registries the product reads.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import {
  assertCatalogComplete,
  assertWrittenDescriptionsTargetPanels,
  buildPanelGroups,
  feedNamesByCategory,
  feedPanelDescription,
  firstSentence,
  PANEL_DESCRIPTIONS_PATH,
  tooltipText,
} from '../scripts/build-coverage-catalog.mjs';
import { ALL_PANELS } from '../src/config/panels.ts';
import { getCompleteLayerCatalogKeys } from '../src/config/map-layer-definitions.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('coverage catalog text', () => {
  it('turns a tooltip into plain prose without its title or interaction hints', () => {
    const html = '<strong>Supply Chain Monitor</strong> Global logistics:<ul><li><strong>Chokepoints</strong>: transit status &amp; scores</li><li><strong>U</strong>nrest: protests</li></ul>Click a chokepoint card to expand transit history chart.';
    assert.equal(tooltipText(html), 'Global logistics: Chokepoints: transit status & scores; Unrest: protests.');
  });

  it('cannot emit markup from nested tags or encoded brackets', () => {
    for (const html of ['<scr<script>ipt>alert(1)</script> text', '&lt;script&gt;alert(1)&lt;/script&gt; text', '<<b>img src=x>']) {
      assert.ok(!tooltipText(html).includes('<'), `${html} -> ${tooltipText(html)}`);
    }
    assert.equal(tooltipText('Brightness >360K.'), 'Brightness >360K.');
  });

  it('splits sentences only at a terminator followed by a space', () => {
    assert.equal(tooltipText('Models such as Llama 3.3 and GPT-4.1. Click to open.'), 'Models such as Llama 3.3 and GPT-4.1.');
  });

  it('keeps sentences that are not interaction hints', () => {
    assert.equal(
      tooltipText('<strong>Methodology</strong> Composite score.<br>Auto-refreshes every 5 minutes.'),
      'Composite score. Auto-refreshes every 5 minutes.',
    );
    assert.equal(tooltipText(undefined), '');
  });

  it('summarizes a tool description from its opening sentences', () => {
    const opening = 'Return the seeded airport disruption snapshot for monitored airports.';
    assert.equal(firstSentence(`${opening} Seeded-cache read.`), opening);
    assert.equal(
      firstSentence('Despite the name, carries no tariff data. Return the price and debt bundle. Weight 1.'),
      'Despite the name, carries no tariff data. Return the price and debt bundle.',
    );
    assert.equal(
      firstSentence(`Return an evidence card for a claim: the matching clusters, a result state (${'state, '.repeat(40)}none), and more.`),
      'Return an evidence card for a claim: the matching clusters.',
      'an overlong sentence ends at its last clause boundary outside parentheses',
    );
    const cut = firstSentence(`${'word '.repeat(80)}end.`, 40);
    assert.ok(cut.endsWith('…') && cut.length <= 41, cut);
  });

  it('describes a news panel by its feeds', () => {
    assert.equal(feedPanelDescription(['A']), 'Headlines from A.');
    assert.equal(
      feedPanelDescription(['A', 'B', 'C', 'D', 'E']),
      'Headlines from 5 news feeds, including A, B, C and D.',
    );
    assert.equal(feedPanelDescription(undefined), '');
    const merged = feedNamesByCategory({
      full: { europe: [{ name: 'A' }, { name: 'B' }] },
      tech: { europe: [{ name: 'B' }, { name: 'C' }] },
    });
    assert.deepEqual(merged.get('europe'), ['A', 'B', 'C']);
  });
});

describe('coverage catalog panel groups', () => {
  const allPanels = {
    'fear-greed': { name: 'Fear & Greed' },
    europe: { name: 'Europe' },
    markets: { name: 'Markets', premium: 'locked' },
  };
  const categoryMap = {
    core: { labelKey: 'header.panelCatCore', panelKeys: ['fear-greed', 'europe'] },
    tech: { labelKey: 'header.panelCatMarkets', panelKeys: ['markets'], variants: ['tech'] },
    fin: { labelKey: 'header.panelCatMarkets', panelKeys: ['markets'], variants: ['finance'] },
  };
  const locale = {
    header: { panelCatCore: 'Core', panelCatMarkets: 'Markets' },
    components: { fearGreed: { infoTooltip: '<strong>Fear</strong> CNN index.' } },
  };

  it('prefers the tooltip, then a written description, then the feed list', () => {
    const groups = buildPanelGroups({
      allPanels,
      categoryMap,
      locale,
      writtenDescriptions: { 'fear-greed': 'Ignored.', markets: 'Shows markets.' },
      feedNames: new Map([['europe', ['France 24']]]),
    });
    const byId = Object.fromEntries(groups.flatMap((group) => group.panels).map((panel) => [panel.id, panel]));
    assert.equal(byId['fear-greed'].description, 'CNN index.');
    assert.equal(byId.markets.description, 'Shows markets.');
    assert.equal(byId.europe.description, 'Headlines from France 24.');
  });

  it('lists a panel once, under one group per label, on the dashboards that register it', () => {
    const isNative = (id, variant) => (id === 'markets' ? variant === 'finance' : true);
    const groups = buildPanelGroups({ allPanels, categoryMap, locale, isNative });
    assert.deepEqual(groups.map((group) => group.label), ['Core', 'Markets']);
    const markets = groups[1].panels;
    assert.equal(markets.length, 1);
    assert.deepEqual(markets[0].variants, ['finance'], 'picker categories do not decide where a panel exists');
    assert.equal(markets[0].pro, true);
    assert.equal(groups[0].panels[0].variants.length, 6);
  });

  it('fails when a panel is in no picker category or a written description names no panel', () => {
    const groups = buildPanelGroups({ allPanels, categoryMap, locale });
    assert.throws(
      () => assertCatalogComplete({ panelGroups: groups, tools: [], layers: [{}] }, { panelCount: 4, toolCount: 0 }),
      /lists 3 panels but the panel registry has 4/,
    );
    assert.throws(() => assertWrittenDescriptionsTargetPanels({ gone: 'x' }, allPanels), /unknown panels: gone/);
  });
});

describe('coverage catalog page', () => {
  let outDir;
  let manifest;
  let html;
  let dataset;

  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'wm-coverage-corpus-'));
    manifest = await buildCorpus({ rootDir: repoRoot, outDir, baseUrl: 'https://www.worldmonitor.app' });
    html = readFileSync(join(outDir, 'reference', 'coverage', 'index.html'), 'utf8');
    dataset = JSON.parse(readFileSync(join(outDir, 'reference', 'coverage', 'coverage.json'), 'utf8'));
  });

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('lists every panel, catalog layer and MCP tool in the registries', () => {
    const panelIds = dataset.panelGroups.flatMap((group) => group.panels.map((panel) => panel.id));
    assert.deepEqual([...panelIds].sort(), Object.keys(ALL_PANELS).sort());
    assert.deepEqual(dataset.layers.map((layer) => layer.id), getCompleteLayerCatalogKeys('full'));
    assert.deepEqual(dataset.tools.map((tool) => tool.name).sort(), TOOL_REGISTRY.map((tool) => tool.name).sort());
    for (const tool of TOOL_REGISTRY) assert.ok(html.includes(`<code>${tool.name}</code>`), `page lists ${tool.name}`);
  });

  it('publishes plain-text descriptions and states counts that match the lists', () => {
    for (const panel of dataset.panelGroups.flatMap((group) => group.panels)) {
      assert.ok(!/<\/?[a-z]/i.test(panel.description), `${panel.id} description has markup`);
    }
    assert.equal(dataset.counts.panels, Object.keys(ALL_PANELS).length);
    assert.equal(dataset.counts.tools, TOOL_REGISTRY.length);
    assert.match(html, new RegExp(`${dataset.counts.panels} dashboard panels in ${dataset.counts.panelGroups} groups, ${dataset.counts.layers} map layers and ${dataset.counts.tools} MCP tools`));
  });

  it('answers "What does World Monitor cover?" in FAQ markup and is linked from every corpus page', () => {
    const faq = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(([, raw]) => JSON.parse(raw))
      .find((entry) => entry['@type'] === 'FAQPage');
    assert.equal(faq?.mainEntity?.[0]?.name, 'What does World Monitor cover?');
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.worldmonitor\.app\/reference\/coverage\/">/);
    assert.equal(manifest.sections.coverage.index, '/reference/coverage/');
    for (const page of ['chokepoints/index.html', 'sources/index.html', ...manifest.sections.sources.routes.map((route) => `${route.slice(1)}index.html`)]) {
      const pageHtml = readFileSync(join(outDir, page), 'utf8');
      assert.ok(pageHtml.includes('<a href="/reference/coverage/">Coverage</a>'), `${page} links the coverage catalog`);
    }
  });

  it('lists each panel on the dashboards that register it', () => {
    const panels = Object.fromEntries(dataset.panelGroups.flatMap((group) => group.panels).map((panel) => [panel.id, panel]));
    assert.deepEqual(panels['fear-greed'].variants, ['full', 'finance']);
    assert.ok(!panels['live-news'].variants.includes('happy'));
  });

  it('keeps written descriptions for panels that exist', () => {
    const written = JSON.parse(readFileSync(join(repoRoot, PANEL_DESCRIPTIONS_PATH), 'utf8'));
    assert.doesNotThrow(() => assertWrittenDescriptionsTargetPanels(written, ALL_PANELS));
  });
});
