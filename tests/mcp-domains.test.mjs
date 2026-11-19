// Tool categories and the generated domain summary (plan 2026-10-13-001, U3/U4).
//
// api/mcp/domains.ts is the one source for which domain each MCP tool belongs
// to and for the domain list that discovery surfaces quote. The
// product-facts generator renders both into the server card and into the
// sentinel/locator spans of the markdown and JSON discovery files; these tests
// keep the map complete and every rendered copy equal to the source.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_DOMAIN_SUMMARY,
  MCP_TAGS,
  MCP_TOOL_CATEGORIES,
  TOOL_CATEGORY_BY_NAME,
} from '../api/mcp/domains.ts';
import { TOOL_LIST_RESPONSE, TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import {
  JSON_DOMAIN_SURFACES,
  MARKDOWN_DOMAIN_SURFACES,
  formatValuePath,
  readValueAt,
  renderJsonDomainSurface,
  renderMarkdownDomainSurface,
} from '../scripts/lib/mcp-domain-summary.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));
const CARD_PATH = 'public/.well-known/mcp/server-card.json';
const CATEGORY_IDS = MCP_TOOL_CATEGORIES.map((category) => category.id);

describe('MCP tool categories (U3)', () => {
  it('maps every registry tool, and only registry tools, to a category', () => {
    const registryNames = TOOL_REGISTRY.map((tool) => tool.name);
    const unmapped = registryNames.filter((name) => !Object.hasOwn(TOOL_CATEGORY_BY_NAME, name));
    assert.deepEqual(unmapped, [], `tools without a category in api/mcp/domains.ts: ${unmapped.join(', ')}`);
    const unknown = Object.keys(TOOL_CATEGORY_BY_NAME).filter((name) => !registryNames.includes(name));
    assert.deepEqual(unknown, [], `category map names tools not in TOOL_REGISTRY: ${unknown.join(', ')}`);
  });

  it('uses only declared category ids, each once, and leaves no category empty', () => {
    assert.equal(new Set(CATEGORY_IDS).size, CATEGORY_IDS.length, 'category ids must be unique');
    const bad = Object.entries(TOOL_CATEGORY_BY_NAME).filter(([, id]) => !CATEGORY_IDS.includes(id));
    assert.deepEqual(bad, [], 'every mapped category must be declared in MCP_TOOL_CATEGORIES');
    const used = new Set(Object.values(TOOL_CATEGORY_BY_NAME));
    const empty = CATEGORY_IDS.filter((id) => !used.has(id));
    assert.deepEqual(empty, [], `categories with no tools: ${empty.join(', ')}`);
  });

  it('gives every data category a summary phrase, so a new domain cannot stay out of the generated copy', () => {
    // `meta` is the one category that is server plumbing, not a data domain.
    const silent = MCP_TOOL_CATEGORIES
      .filter((category) => category.id !== 'meta' && !(category.summaryPhrase ?? '').trim())
      .map((category) => category.id);
    assert.deepEqual(silent, [], `data categories without a summaryPhrase: ${silent.join(', ')}`);
  });

  it('files the tariff tools under trade-tariffs and the server utilities under meta', () => {
    for (const name of ['get_tariff_averages', 'get_bilateral_tariff', 'get_us_import_duty']) {
      assert.equal(TOOL_CATEGORY_BY_NAME[name], 'trade-tariffs', name);
    }
    // Big Mac, FAO food prices and national debt: no tariff data.
    assert.equal(TOOL_CATEGORY_BY_NAME.get_price_and_debt_indicators, 'markets-economy');
    for (const name of ['get_sources', 'get_mcp_allowance', 'describe_tool', 'open_news_dashboard']) {
      assert.equal(TOOL_CATEGORY_BY_NAME[name], 'meta', name);
    }
    assert.ok(CATEGORY_IDS.includes('trade-tariffs') && CATEGORY_IDS.includes('meta'));
  });

  it('renders categories, trade tags, and a per-tool category onto the committed server card', () => {
    const card = readJson(CARD_PATH);
    assert.deepEqual(card.toolCategories, CATEGORY_IDS, 'toolCategories must equal the category table ids in order');
    assert.deepEqual(card.tags, MCP_TAGS);
    assert.ok(card.tags.includes('trade') && card.tags.includes('tariffs'), 'card tags must advertise trade and tariffs');
    assert.equal(card.tools.length, TOOL_REGISTRY.length);
    for (const tool of card.tools) {
      assert.equal(tool._meta?.['worldmonitor/category'], TOOL_CATEGORY_BY_NAME[tool.name], tool.name);
    }
  });

  it('leaves the live tools/list _meta vendor keys unchanged', () => {
    for (const tool of TOOL_LIST_RESPONSE) {
      const vendorKeys = Object.keys(tool._meta ?? {}).filter((key) => key.startsWith('worldmonitor/')).sort();
      assert.deepEqual(vendorKeys, ['worldmonitor/access', 'worldmonitor/weight'], tool.name);
    }
  });
});

describe('generated MCP domain summary (U4)', () => {
  it('lists every category phrase once and nothing for meta', () => {
    const phrases = MCP_TOOL_CATEGORIES.flatMap((category) => (category.summaryPhrase ? [category.summaryPhrase] : []));
    assert.equal(MCP_DOMAIN_SUMMARY, phrases.join('; '), 'phrases carry commas, so the list joins on semicolons');
    for (const phrase of phrases) assert.ok(MCP_DOMAIN_SUMMARY.includes(phrase), phrase);
    assert.equal(MCP_TOOL_CATEGORIES.find((category) => category.id === 'meta')?.summaryPhrase, undefined);
    assert.ok(MCP_DOMAIN_SUMMARY.includes('tariffs'), 'the summary must name the trade domain');
  });

  it('never contains a surface anchor, so a second render finds each anchor exactly once', () => {
    // A phrase like "U.S. tariffs" would add a second "." to a value whose
    // suffix anchor is ".", and the renderer would throw on the next run.
    for (const surface of JSON_DOMAIN_SURFACES) {
      for (const anchor of [surface.prefix, surface.suffix]) {
        assert.ok(!MCP_DOMAIN_SUMMARY.includes(anchor), `${surface.path}: the summary contains the anchor ${JSON.stringify(anchor)}`);
      }
    }
    for (const surface of MARKDOWN_DOMAIN_SURFACES) {
      for (const anchor of [surface.start, surface.end]) {
        assert.ok(!MCP_DOMAIN_SUMMARY.includes(anchor), `${surface.path}: the summary contains the sentinel ${anchor}`);
      }
    }
  });

  for (const surface of MARKDOWN_DOMAIN_SURFACES) {
    it(`${surface.path} carries the summary between its sentinels and is a fixed point`, () => {
      const source = read(surface.path);
      const start = source.indexOf(surface.start) + surface.start.length;
      assert.equal(source.slice(start, source.indexOf(surface.end)), MCP_DOMAIN_SUMMARY);
      assert.equal(renderMarkdownDomainSurface(source, surface, MCP_DOMAIN_SUMMARY), source);
      // A hand edit inside the span is not a fixed point, so --check reports it stale.
      const edited = source.replace(MCP_DOMAIN_SUMMARY, 'markets');
      assert.notEqual(renderMarkdownDomainSurface(edited, surface, MCP_DOMAIN_SUMMARY), edited);
    });
  }

  for (const surface of JSON_DOMAIN_SURFACES) {
    it(`${surface.path} ${formatValuePath(surface.valuePath)} carries the summary and is a fixed point`, () => {
      const source = read(surface.path);
      const value = readValueAt(JSON.parse(source), surface);
      assert.equal(value.slice(value.indexOf(surface.prefix) + surface.prefix.length, value.lastIndexOf(surface.suffix)), MCP_DOMAIN_SUMMARY);
      assert.equal(renderJsonDomainSurface(source, surface, MCP_DOMAIN_SUMMARY), source);
      const edited = source.replace(MCP_DOMAIN_SUMMARY, 'markets');
      assert.notEqual(renderJsonDomainSurface(edited, surface, MCP_DOMAIN_SUMMARY), edited);
    });
  }

  it('throws naming the path when a markdown surface has zero or two sentinel pairs', () => {
    const surface = MARKDOWN_DOMAIN_SURFACES[0];
    const pair = `${surface.start}x${surface.end}`;
    for (const source of ['no sentinels here', `${pair} and ${pair}`, `${surface.start} only a start`]) {
      assert.throws(
        () => renderMarkdownDomainSurface(source, surface, MCP_DOMAIN_SUMMARY),
        (error) => error.message.includes(surface.path),
      );
    }
  });

  it('throws naming the path and value path when a JSON prefix or suffix is missing or duplicated', () => {
    const surface = { path: 'fixture.json', valuePath: ['item', 'description'], prefix: 'covers ', suffix: ' today.' };
    const doc = (description) => `${JSON.stringify({ item: { description } }, null, 2)}\n`;
    assert.equal(
      renderJsonDomainSurface(doc('It covers old list today.'), surface, 'a, b'),
      doc('It covers a, b today.'),
    );
    for (const description of ['It lists old list today.', 'It covers old list.', 'It covers covers x today.', 'It covers x today. today.']) {
      assert.throws(
        () => renderJsonDomainSurface(doc(description), surface, 'a, b'),
        (error) => error.message.includes('fixture.json') && error.message.includes('item.description'),
        description,
      );
    }
    assert.throws(
      () => renderJsonDomainSurface(doc('x'), { ...surface, valuePath: ['item', 'missing'] }, 'a, b'),
      (error) => error.message.includes('fixture.json') && error.message.includes('item.missing'),
    );
  });

  it('never targets server.json or the card top-level description', () => {
    const targets = JSON_DOMAIN_SURFACES.map((surface) => `${surface.path}#${formatValuePath(surface.valuePath)}`);
    assert.ok(!targets.some((target) => target.startsWith('server.json')), targets.join(', '));
    assert.ok(!targets.includes(`${CARD_PATH}#description`), targets.join(', '));
    assert.ok(targets.includes(`${CARD_PATH}#serverInfo.description`));
    const card = readJson(CARD_PATH);
    assert.equal(card.description, readJson('server.json').description);
    assert.ok(!card.description.includes(MCP_DOMAIN_SUMMARY));
  });

  it('targets the ai-catalog MCP server entry, not the REST entry', () => {
    const surface = JSON_DOMAIN_SURFACES.find((entry) => entry.path === 'public/.well-known/ai-catalog.json');
    assert.ok(surface, 'ai-catalog surface must exist');
    const catalog = readJson(surface.path);
    const restEntry = catalog.entries.find((entry) => entry.type.startsWith('application/vnd.oai.openapi'));
    assert.ok(readValueAt(catalog, surface).includes(MCP_DOMAIN_SUMMARY));
    assert.ok(!restEntry.description.includes(MCP_DOMAIN_SUMMARY));
  });
});
